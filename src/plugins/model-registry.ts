import type { Event } from "@opencode-ai/sdk";
import { type Plugin, tool } from "@opencode-ai/plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";

import {
  buildModelRegistryPayload,
  type CapabilityTier,
  type ModelRegistryEntry,
  filterModelRegistryEntries,
  loadModelRegistry,
} from "../model-registry.js";

const PLUGIN_SOURCE_FILE_PATH = fileURLToPath(import.meta.url);
const PLUGIN_SOURCE_DIRECTORY = path.dirname(PLUGIN_SOURCE_FILE_PATH);
const CONTROL_PLANE_ROOT_DIRECTORY = path.resolve(
  PLUGIN_SOURCE_DIRECTORY,
  "..",
  "..",
);
const OPENROUTER_PROVIDER_ID = "openrouter";
const MODEL_REGISTRY_LOAD_ERROR_MESSAGE =
  "Failed to load model registry for model-registry plugin hooks.";
const ACTIVE_MODEL_ROUTING_CONTEXT_HEADER = "## Active model routing context";
const PROVIDER_QUOTA_STATUS_HEADER = "## Provider health status";
const AVAILABLE_MODELS_HEADER = "## Available models by role/task";
const NO_FALLBACK_MODEL_CONFIGURED_MESSAGE = "no fallback configured";

const PROVIDER_HEALTH_STATE_FILE = path.join(
  CONTROL_PLANE_ROOT_DIRECTORY,
  ".opencode",
  "state",
  "plugin",
  "provider-health.json",
);

// Providers and model name substrings excluded from fallback suggestions.
const FALLBACK_BLOCKED_PROVIDER_IDS = new Set([
  "longcat-openai",
  "longcat",
  "anthropic",
  "openai",
  "xai",
  "github-copilot",
]);
const FALLBACK_BLOCKED_MODEL_SUBSTRINGS = ["longcat", "claude", "gpt", "grok"];

const CAPABILITY_TIER_TO_TEMPERATURE: Record<CapabilityTier, number> = {
  frontier: 0.7,
  strong: 0.6,
  standard: 0.5,
  fast: 0.3,
  tiny: 0.3,
};

// Billing mode preference order for model selection (lower index = more preferred).
const BILLING_MODE_PREFERENCE_ORDER = ["free", "subscription", "quota", "paid_api"] as const;

type ProviderHealthState = "quota" | "key_dead" | "no_credit";

type ProviderHealth = {
  state: ProviderHealthState;
  until: number;
  retryCount: number;
};

type PersistedHealthMap = Record<string, ProviderHealth>;

type ModelIdentity = {
  id: string;
  providerID: string;
};

function logRegistryLoadError(error: unknown): void {
  console.error(MODEL_REGISTRY_LOAD_ERROR_MESSAGE, error);
}

async function loadPersistedProviderHealth(): Promise<Map<string, ProviderHealth>> {
  try {
    const raw = await readFile(PROVIDER_HEALTH_STATE_FILE, "utf8");
    const parsed: PersistedHealthMap = JSON.parse(raw);
    const now = Date.now();
    const map = new Map<string, ProviderHealth>();
    for (const [providerID, health] of Object.entries(parsed)) {
      if (health.until > now) {
        map.set(providerID, health);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

async function persistProviderHealth(healthMap: Map<string, ProviderHealth>): Promise<void> {
  try {
    await mkdir(path.dirname(PROVIDER_HEALTH_STATE_FILE), { recursive: true });
    const obj: PersistedHealthMap = Object.fromEntries(healthMap.entries());
    await writeFile(PROVIDER_HEALTH_STATE_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // Non-fatal — in-memory state still works.
  }
}

function buildEnabledProviderModelSet(
  modelRegistryEntries: ModelRegistryEntry[],
  providerID: string,
): Set<string> {
  return new Set(
    modelRegistryEntries
      .filter((modelRegistryEntry) => modelRegistryEntry.enabled)
      .flatMap((modelRegistryEntry) =>
        modelRegistryEntry.provider_order
          .filter((providerRoute) => providerRoute.provider === providerID)
          .map((providerRoute) => providerRoute.model),
      ),
  );
}

function findRegistryEntryByModel(
  modelRegistryEntries: ModelRegistryEntry[],
  model: ModelIdentity,
): ModelRegistryEntry | undefined {
  return modelRegistryEntries.find((modelRegistryEntry) =>
    modelRegistryEntry.provider_order.some(
      (providerRoute) =>
        providerRoute.model === model.id ||
        (providerRoute.provider === model.providerID &&
          providerRoute.model === model.id),
    ),
  );
}

function buildRoutingContextSystemPrompt(modelRegistryEntry: ModelRegistryEntry): string {
  return [
    ACTIVE_MODEL_ROUTING_CONTEXT_HEADER,
    `Model: ${modelRegistryEntry.id}`,
    `Description: ${modelRegistryEntry.description}`,
    `Roles: ${modelRegistryEntry.default_roles.join(", ")}`,
    `Best for: ${modelRegistryEntry.best_for.join(", ")}`,
    `Not for: ${modelRegistryEntry.not_for.join(", ")}`,
    `Concurrency limit: ${modelRegistryEntry.concurrency}`,
    `Cost tier: ${modelRegistryEntry.cost_tier} | Billing: ${modelRegistryEntry.billing_mode}`,
  ].join("\n");
}

function isFallbackBlocked(providerID: string, modelID: string): boolean {
  if (FALLBACK_BLOCKED_PROVIDER_IDS.has(providerID)) {
    return true;
  }
  const lowerModelID = modelID.toLowerCase();
  return FALLBACK_BLOCKED_MODEL_SUBSTRINGS.some((blocked) =>
    lowerModelID.includes(blocked),
  );
}

function findCuratedFallbackRoute(
  modelRegistryEntry: ModelRegistryEntry,
  blockedProviderID: string,
  providerHealthMap: Map<string, ProviderHealth>,
  now: number,
): string {
  const allowedRoute = modelRegistryEntry.provider_order.find(
    (providerRoute) =>
      providerRoute.provider !== blockedProviderID &&
      !isFallbackBlocked(providerRoute.provider, providerRoute.model) &&
      isProviderHealthy(providerHealthMap, providerRoute.provider, now),
  );

  if (!allowedRoute) {
    return NO_FALLBACK_MODEL_CONFIGURED_MESSAGE;
  }

  return `${allowedRoute.provider}/${allowedRoute.model}`;
}

function isProviderHealthy(
  providerHealthMap: Map<string, ProviderHealth>,
  providerID: string,
  now: number,
): boolean {
  const health = providerHealthMap.get(providerID);
  if (!health) return true;
  return health.until <= now;
}

function healthStateLabel(state: ProviderHealthState): string {
  switch (state) {
    case "quota": return "QUOTA BACKOFF";
    case "key_dead": return "KEY DEAD";
    case "no_credit": return "NO CREDIT";
  }
}

function buildProviderHealthSystemPrompt(
  modelRegistryEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  now: number,
): string | null {
  const activePenalties = Array.from(providerHealthMap.entries()).filter(
    ([, health]) => health.until > now,
  );

  if (activePenalties.length === 0) {
    return null;
  }

  const sections = activePenalties.map(([providerID, health]) => {
    const label = healthStateLabel(health.state);
    const until = new Date(health.until).toISOString();

    const affectedEntries = modelRegistryEntries.filter(
      (entry) =>
        entry.enabled &&
        entry.provider_order.some((route) => route.provider === providerID),
    );

    const fallbackLines = affectedEntries.map((entry) => {
      const fallback = findCuratedFallbackRoute(entry, providerID, providerHealthMap, now);
      return `- ${entry.id} → ${fallback}`;
    });

    return [
      PROVIDER_QUOTA_STATUS_HEADER,
      `Provider ${providerID} [${label}] until ${until}.`,
      `Curated fallbacks (longcat/claude/gpt/grok excluded):`,
      ...fallbackLines,
    ].join("\n");
  });

  return sections.join("\n\n");
}

/**
 * Build a role+task filtered view of currently healthy models for the system prompt.
 * Only injected when at least one provider has a health penalty.
 */
function buildAvailableModelsSystemPrompt(
  modelRegistryEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  now: number,
): string | null {
  if (providerHealthMap.size === 0) {
    return null;
  }

  // Group enabled models by their first default_role, filtering to healthy primary provider.
  const roleToModels = new Map<string, string[]>();

  for (const entry of modelRegistryEntries) {
    if (!entry.enabled) continue;

    const primaryRoute = entry.provider_order[0];
    if (!primaryRoute) continue;
    if (!isProviderHealthy(providerHealthMap, primaryRoute.provider, now)) continue;

    for (const role of entry.default_roles) {
      const existing = roleToModels.get(role) ?? [];
      if (existing.length < 2) {
        existing.push(`${entry.id} (${entry.billing_mode})`);
        roleToModels.set(role, existing);
      }
    }
  }

  if (roleToModels.size === 0) {
    return null;
  }

  const lines = Array.from(roleToModels.entries())
    .slice(0, 8)
    .map(([role, models]) => `- ${role}: ${models.join(", ")}`);

  return [AVAILABLE_MODELS_HEADER, ...lines].join("\n");
}

/**
 * Select the best available model for a given role and/or task.
 *
 * Selection criteria (in order):
 * 1. Primary provider is currently healthy (not in any penalty state)
 * 2. Billing mode preference: free > subscription > quota > paid_api
 * 3. Capability tier match if requested
 */
function selectBestModelForRoleAndTask(
  modelRegistryEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  now: number,
  role: string | null,
  task: string | null,
  capabilityTier: string | null,
): ModelRegistryEntry | null {
  const candidates = modelRegistryEntries.filter((entry) => {
    if (!entry.enabled) return false;

    if (role && !entry.default_roles.includes(role)) return false;

    if (task) {
      const lowerTask = task.toLowerCase();
      const matchesTask = entry.best_for.some((bf) =>
        bf.toLowerCase().includes(lowerTask),
      ) || entry.default_roles.some((r) => r.toLowerCase().includes(lowerTask));
      if (!matchesTask) return false;
    }

    if (capabilityTier && entry.capability_tier !== capabilityTier) return false;

    return true;
  });

  if (candidates.length === 0) return null;

  // Sort: healthy primary provider first, then billing preference, then capability tier.
  const tierOrder = ["frontier", "strong", "standard", "fast", "tiny"] as const;

  candidates.sort((a, b) => {
    const aPrimary = a.provider_order[0];
    const bPrimary = b.provider_order[0];
    const aHealthy = aPrimary && isProviderHealthy(providerHealthMap, aPrimary.provider, now) ? 0 : 1;
    const bHealthy = bPrimary && isProviderHealthy(providerHealthMap, bPrimary.provider, now) ? 0 : 1;

    if (aHealthy !== bHealthy) return aHealthy - bHealthy;

    const aBillingIdx = BILLING_MODE_PREFERENCE_ORDER.indexOf(a.billing_mode as typeof BILLING_MODE_PREFERENCE_ORDER[number]);
    const bBillingIdx = BILLING_MODE_PREFERENCE_ORDER.indexOf(b.billing_mode as typeof BILLING_MODE_PREFERENCE_ORDER[number]);
    if (aBillingIdx !== bBillingIdx) return aBillingIdx - bBillingIdx;

    const aTierIdx = tierOrder.indexOf(a.capability_tier as typeof tierOrder[number]);
    const bTierIdx = tierOrder.indexOf(b.capability_tier as typeof tierOrder[number]);
    return aTierIdx - bTierIdx;
  });

  return candidates[0] ?? null;
}

async function listCuratedModels(
  options: {
    freeOnly: boolean;
    role: string | null;
    provider: string | null;
  },
  providerHealthMap: Map<string, ProviderHealth>,
): Promise<string> {
  const now = Date.now();
  const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
  const filteredEntries = filterModelRegistryEntries(modelRegistry.models, {
    freeOnly: options.freeOnly,
    roleFilter: options.role,
    providerFilter: options.provider,
    enabledOnly: false,
  });

  return JSON.stringify(
    {
      count: filteredEntries.length,
      models: filteredEntries.map((entry) => {
        const payload = buildModelRegistryPayload(entry);
        const primaryProvider = entry.provider_order[0]?.provider ?? null;
        const health = primaryProvider ? providerHealthMap.get(primaryProvider) : undefined;
        return {
          ...payload,
          providerHealth: health && health.until > now
            ? { state: health.state, until: new Date(health.until).toISOString() }
            : null,
        };
      }),
    },
    null,
    2,
  );
}

export const ModelRegistryPlugin: Plugin = async () => {
  const providerHealthMap = await loadPersistedProviderHealth();
  const sessionActiveProviderMap = new Map<string, string>();

  const QUOTA_BACKOFF_DURATION_MS = 60 * 60 * 1000;        // 1h — recovers automatically
  const KEY_DEAD_DURATION_MS = 2 * 60 * 60 * 1000;         // 2h — may be transient token refresh
  const NO_CREDIT_DURATION_MS = 2 * 60 * 60 * 1000;        // 2h — may be replenished
  const QUOTA_HTTP_STATUS_CODE = 429;
  const KEY_DEAD_HTTP_STATUS_CODES = new Set([401, 403]);
  const NO_CREDIT_HTTP_STATUS_CODE = 402;
  const QUOTA_KEYWORDS = ["quota", "rate limit", "rate_limit", "too many requests"];
  const KEY_DEAD_KEYWORDS = ["user not found", "invalid api key", "invalid key", "unauthorized", "authentication"];
  const NO_CREDIT_KEYWORDS = ["insufficient credits", "no credit", "payment", "billing"];

  function recordProviderHealth(
    providerID: string,
    state: ProviderHealthState,
    durationMs: number,
  ): void {
    const existing = providerHealthMap.get(providerID);
    providerHealthMap.set(providerID, {
      state,
      until: Date.now() + durationMs,
      retryCount: (existing?.retryCount ?? 0) + 1,
    });
    void persistProviderHealth(providerHealthMap);
  }

  return {
    tool: {
      list_curated_models: tool({
        description: "List curated routing models from aicoder-opencode models.jsonc. Includes current provider health status.",
        args: {
          freeOnly: tool.schema.boolean().default(false),
          role: tool.schema.string().nullable().default(null),
          provider: tool.schema.string().nullable().default(null),
        },
        async execute(args) {
          return listCuratedModels(args, providerHealthMap);
        },
      }),

      select_models_for_role: tool({
        description: "List curated routing models recommended for a role. Annotates blocked providers with their health state.",
        args: {
          role: tool.schema.string(),
          freeOnly: tool.schema.boolean().default(false),
          provider: tool.schema.string().nullable().default(null),
        },
        async execute(args) {
          return listCuratedModels(
            { freeOnly: args.freeOnly, role: args.role, provider: args.provider },
            providerHealthMap,
          );
        },
      }),

      recommend_model_for_role: tool({
        description: [
          "Return the single best currently-available model for a role and/or task.",
          "Filters out providers in quota backoff, with dead keys, or with no credit.",
          "Prefers healthy free/subscription providers over penalized paid ones.",
          "Use this instead of select_models_for_role when you need one concrete recommendation.",
        ].join(" "),
        args: {
          role: tool.schema.string().nullable().default(null).describe(
            "Agent role, e.g. 'architect', 'coder', 'fixer', 'implementation_worker', 'deep_reviewer'",
          ),
          task: tool.schema.string().nullable().default(null).describe(
            "Task description, e.g. 'coding', 'debugging', 'architecture', 'review', 'maintenance'. Matched against best_for field.",
          ),
          capabilityTier: tool.schema.string().nullable().default(null).describe(
            "Required capability tier: 'frontier', 'strong', 'standard', 'fast', 'tiny'",
          ),
        },
        async execute(args) {
          const now = Date.now();
          const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);

          // Expire stale entries.
          for (const [providerID, health] of providerHealthMap.entries()) {
            if (health.until <= now) {
              providerHealthMap.delete(providerID);
            }
          }

          const best = selectBestModelForRoleAndTask(
            modelRegistry.models,
            providerHealthMap,
            now,
            args.role,
            args.task,
            args.capabilityTier,
          );

          if (!best) {
            return JSON.stringify({
              recommendation: null,
              reason: "No model found matching role/task/tier filters",
              providerHealthSummary: Object.fromEntries(
                Array.from(providerHealthMap.entries()).map(([id, h]) => [
                  id,
                  { state: h.state, until: new Date(h.until).toISOString() },
                ]),
              ),
            }, null, 2);
          }

          const primaryRoute = best.provider_order[0];
          const healthy = primaryRoute
            ? isProviderHealthy(providerHealthMap, primaryRoute.provider, now)
            : false;

          return JSON.stringify({
            recommendation: {
              modelID: best.id,
              primaryRoute: primaryRoute
                ? `${primaryRoute.provider}/${primaryRoute.model}`
                : null,
              capabilityTier: best.capability_tier,
              billingMode: best.billing_mode,
              roles: best.default_roles,
              bestFor: best.best_for,
              primaryProviderHealthy: healthy,
            },
            alternativeRoutes: best.provider_order.slice(1).map((route) => ({
              route: `${route.provider}/${route.model}`,
              healthy: isProviderHealthy(providerHealthMap, route.provider, now),
            })),
          }, null, 2);
        },
      }),

      get_quota_backoff_status: tool({
        description: "Return all LLM providers currently penalized (quota backoff, dead key, no credit) and when they expire.",
        args: {},
        async execute() {
          const now = Date.now();
          const status: Record<string, { state: string; until: string; retryCount: number } | null> = {};

          for (const [providerID, health] of providerHealthMap.entries()) {
            if (health.until <= now) {
              providerHealthMap.delete(providerID);
              continue;
            }
            status[providerID] = {
              state: health.state,
              until: new Date(health.until).toISOString(),
              retryCount: health.retryCount,
            };
          }

          return JSON.stringify(status, null, 2);
        },
      }),
    },

    provider: {
      id: OPENROUTER_PROVIDER_ID,
      async models(provider) {
        try {
          const now = Date.now();
          const health = providerHealthMap.get(OPENROUTER_PROVIDER_ID);
          if (health && health.until > now) {
            return {};
          }

          const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
          const enabledOpenRouterModels = buildEnabledProviderModelSet(
            modelRegistry.models,
            OPENROUTER_PROVIDER_ID,
          );

          return Object.fromEntries(
            Object.entries(provider.models).filter(([modelID]) =>
              enabledOpenRouterModels.has(modelID),
            ),
          );
        } catch (error) {
          logRegistryLoadError(error);
          return provider.models;
        }
      },
    },

    async event({ event }: { event: Event }) {
      if (event.type !== "session.error") {
        return;
      }

      const sessionError = event.properties;
      if (!sessionError?.error || sessionError.error.name !== "APIError") {
        return;
      }

      const apiError = sessionError.error;
      const statusCode: number = apiError.data.statusCode ?? 0;
      const message: string = (apiError.data.message ?? "").toLowerCase();

      const sessionID = sessionError.sessionID;
      if (!sessionID) return;

      const providerID = sessionActiveProviderMap.get(sessionID);
      if (!providerID) return;

      // 429 or quota keywords → quota backoff (1h, auto-recovers).
      const isQuota =
        statusCode === QUOTA_HTTP_STATUS_CODE ||
        QUOTA_KEYWORDS.some((kw) => message.includes(kw));
      if (isQuota) {
        recordProviderHealth(providerID, "quota", QUOTA_BACKOFF_DURATION_MS);
        return;
      }

      // 402 or no-credit keywords → no credit (2h).
      const isNoCredit =
        statusCode === NO_CREDIT_HTTP_STATUS_CODE ||
        NO_CREDIT_KEYWORDS.some((kw) => message.includes(kw));
      if (isNoCredit) {
        recordProviderHealth(providerID, "no_credit", NO_CREDIT_DURATION_MS);
        return;
      }

      // 401/403 or key-dead keywords → key dead (2h, may be transient token refresh).
      const isKeyDead =
        KEY_DEAD_HTTP_STATUS_CODES.has(statusCode) ||
        KEY_DEAD_KEYWORDS.some((kw) => message.includes(kw));
      if (isKeyDead) {
        recordProviderHealth(providerID, "key_dead", KEY_DEAD_DURATION_MS);
        return;
      }
    },

    async "chat.params"(input, output) {
      try {
        sessionActiveProviderMap.set(input.sessionID, input.provider.info.id);

        const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
        const modelRegistryEntry = findRegistryEntryByModel(modelRegistry.models, {
          id: input.model.id,
          providerID: input.model.providerID,
        });

        if (!modelRegistryEntry) {
          return;
        }

        output.temperature =
          CAPABILITY_TIER_TO_TEMPERATURE[modelRegistryEntry.capability_tier];
      } catch {
        return;
      }
    },

    async "experimental.chat.system.transform"(input, output) {
      try {
        const now = Date.now();
        const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);

        // Expire stale health entries.
        for (const [providerID, health] of providerHealthMap.entries()) {
          if (health.until <= now) {
            providerHealthMap.delete(providerID);
          }
        }

        const modelRegistryEntry = findRegistryEntryByModel(modelRegistry.models, {
          id: input.model.id,
          providerID: input.model.providerID,
        });

        if (modelRegistryEntry) {
          output.system.push(buildRoutingContextSystemPrompt(modelRegistryEntry));
        }

        // Only inject health/available-models sections when there are active penalties.
        if (providerHealthMap.size === 0) {
          return;
        }

        const providerHealthPrompt = buildProviderHealthSystemPrompt(
          modelRegistry.models,
          providerHealthMap,
          now,
        );
        if (providerHealthPrompt) {
          output.system.push(providerHealthPrompt);
        }

        const availableModelsPrompt = buildAvailableModelsSystemPrompt(
          modelRegistry.models,
          providerHealthMap,
          now,
        );
        if (availableModelsPrompt) {
          output.system.push(availableModelsPrompt);
        }
      } catch {
        return;
      }
    },
  };
};
