import type { Event } from "@opencode-ai/sdk";
import { type Plugin, tool } from "@opencode-ai/plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";

import {
  buildModelRegistryPayload,
  type CapabilityTier,
  type ModelRegistryEntry,
  filterModelRegistryEntries,
  loadModelRegistry,
  filterVisibleProviderRoutes,
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

type ProviderHealthState = "quota" | "key_dead" | "no_credit" | "key_missing" | "model_not_found" | "timeout";

type ProviderHealth = {
  state: ProviderHealthState;
  until: number;
  retryCount: number;
};

type ModelRouteHealth = {
  state: ProviderHealthState;
  until: number;
  retryCount: number;
};

type TaskComplexity = "small" | "medium" | "large";

type AgentMetadata = {
  model?: string;
  models?: string[];
  routing_role?: string;
  routing_complexity?: TaskComplexity;
};

type ModelRouteDecision = {
  selectedModelRoute: string;
  reasoning: string;
};

type PersistedHealthMap = Record<string, Omit<ProviderHealth, 'until'> & { until: number | "never" }>;

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
      const until = health.until === "never" ? Number.POSITIVE_INFINITY : (health.until as number);
      if (until > now) {
        map.set(providerID, {
          ...health,
          until,
        });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

async function persistProviderHealth(
  healthMap: Map<string, ProviderHealth>,
  routeHealthMap?: Map<string, ModelRouteHealth>,
): Promise<void> {
  try {
    await mkdir(path.dirname(PROVIDER_HEALTH_STATE_FILE), { recursive: true });
    const obj: PersistedHealthMap = Object.fromEntries(
      Array.from(healthMap.entries()).map(([key, health]) => [
        key,
        {
          ...health,
          until: health.until === Number.POSITIVE_INFINITY ? "never" : health.until,
        },
      ]),
    );

    // Also persist model route health
    if (routeHealthMap) {
      for (const [routeKey, health] of routeHealthMap.entries()) {
        obj[routeKey] = {
          ...health,
          until: health.until === Number.POSITIVE_INFINITY ? "never" : health.until,
        };
      }
    }

    // Atomic write: tmp file + rename prevents concurrent-writer corruption
    // when multiple opencode services (aicoder-opencode, dr-repo, letta-workspace)
    // share this state file. Without this, a shorter write layered over a longer
    // prior write leaves stale tail bytes and produces invalid JSON on disk.
    const temporaryFilePath = `${PROVIDER_HEALTH_STATE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(temporaryFilePath, JSON.stringify(obj, null, 2), "utf8");
      await rename(temporaryFilePath, PROVIDER_HEALTH_STATE_FILE);
    } catch (renameError) {
      // Best-effort cleanup of the tmp file on failure.
      try {
        await unlink(temporaryFilePath);
      } catch {
        // Ignore — tmp file may not exist.
      }
      throw renameError;
    }
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
  // key_missing state never expires (until: Number.POSITIVE_INFINITY)
  return health.until <= now;
}

function healthStateLabel(state: ProviderHealthState): string {
  switch (state) {
    case "quota": return "QUOTA BACKOFF";
    case "key_dead": return "KEY DEAD";
    case "no_credit": return "NO CREDIT";
    case "key_missing": return "KEY MISSING";
    case "model_not_found": return "MODEL NOT FOUND";
    case "timeout": return "TIMEOUT";
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
 * Infer task complexity from a prompt description.
 */
function inferTaskComplexity(prompt: string, _explicitComplexity: TaskComplexity | null): TaskComplexity {
  const lowerPrompt = prompt.toLowerCase();

  // Large complexity indicators
  const largeKeywords = [
    "rework", "refactor", "redesign", "architecture", "system", "across",
    "multiple", "comprehensive", "complete", "full", "entire", "end-to-end",
  ];
  if (largeKeywords.some((kw) => lowerPrompt.includes(kw))) {
    return "large";
  }

  // Medium complexity indicators
  const mediumKeywords = [
    "implement", "add", "update", "fix", "debug", "test", "verify",
    "improve", "enhance", "optimize", "integrate", "connect",
  ];
  if (mediumKeywords.some((kw) => lowerPrompt.includes(kw))) {
    return "medium";
  }

  // Default to medium for unspecified tasks
  return "medium";
}

/**
 * Read agent metadata from the local .opencode/agents/ directory.
 */
async function readAgentMetadata(
  rootDirectory: string,
  agentName: string,
): Promise<AgentMetadata | null> {
  try {
    const agentFilePath = path.join(rootDirectory, ".opencode", "agents", `${agentName}.md`);
    const rawContent = await readFile(agentFilePath, "utf8");

    const frontmatterMatch = rawContent.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      return null;
    }

    const frontmatter = frontmatterMatch[1];
    const metadata: AgentMetadata = {};

    if (!frontmatter) {
      return null;
    }

    // Line-oriented parser that also understands YAML block lists:
    //   models:
    //     - provider/model-a
    //     - provider/model-b
    // When a `key:` has an empty scalar value, peek the next lines and
    // collect indented `- item` entries until we hit a non-list line.
    const frontmatterLines = frontmatter.split("\n");
    let lineIndex = 0;
    while (lineIndex < frontmatterLines.length) {
      const line = frontmatterLines[lineIndex] ?? "";
      lineIndex += 1;

      const colonIndex = line.indexOf(":");
      if (colonIndex < 1) continue;

      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();

      if (key === "model") {
        metadata.model = value;
      } else if (key === "models") {
        const inlineItems = value.length > 0
          ? value
              .replace(/^\[|\]$/g, "") // strip flow-style brackets if present
              .split(/\s*,\s*/)
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
          : [];

        const blockItems: string[] = [];
        while (lineIndex < frontmatterLines.length) {
          const peekLine = frontmatterLines[lineIndex] ?? "";
          const blockMatch = peekLine.match(/^\s+-\s+(.*)$/);
          if (!blockMatch) break;
          const item = (blockMatch[1] ?? "").trim().replace(/^["']|["']$/g, "");
          if (item.length > 0) blockItems.push(item);
          lineIndex += 1;
        }

        metadata.models = [...inlineItems, ...blockItems];
      } else if (key === "routing_role") {
        metadata.routing_role = value;
      } else if (key === "routing_complexity") {
        if (["small", "medium", "large"].includes(value)) {
          metadata.routing_complexity = value as TaskComplexity;
        }
      }
    }

    return metadata;
  } catch {
    return null;
  }
}

/**
 * Load API keys from the OpenCode auth.json file.
 */
/**
 * Opencode sources provider credentials from auth.json *and* from environment
 * variables. When a user has only the env var set (e.g. `OPENROUTER_API_KEY`)
 * the provider still works, so the plugin must not false-flag it as
 * `key_missing`. Map the provider ID to the env var names opencode honours.
 * Entries with no explicit override fall back to the convention
 * `<PROVIDER>_API_KEY` (dashes → underscores, uppercased).
 */
const PROVIDER_ENV_VAR_OVERRIDES: Record<string, readonly string[]> = {
  "kimi-for-coding": ["KIMI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  togetherai: ["TOGETHER_API_KEY", "TOGETHERAI_API_KEY"],
};

function providerEnvVarCandidates(providerID: string): readonly string[] {
  const overrides = PROVIDER_ENV_VAR_OVERRIDES[providerID];
  if (overrides) {
    return overrides;
  }
  const conventional = `${providerID.replace(/-/g, "_").toUpperCase()}_API_KEY`;
  return [conventional];
}

function providerHasEnvVarCredential(providerID: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const name of providerEnvVarCandidates(providerID)) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Read opencode's auth.json and report whether each provider has a usable
 * credential configured. The real opencode schema is:
 *   - { type: "api", key: "<string>" }              — API key entry
 *   - { type: "oauth", access: "...", refresh: "..." } — OAuth entry
 *
 * An earlier version of this plugin assumed { apiKey: string }, which does
 * not match any real auth.json entry and caused every provider to be
 * incorrectly flagged as `key_missing`. This function is now schema-aware
 * and also consults env var fallbacks so providers configured only through
 * `OPENROUTER_API_KEY` / `MINIMAX_API_KEY` / etc. are not false-flagged.
 */
async function loadAuthKeys(): Promise<Map<string, { hasCredential: boolean }>> {
  const result = new Map<string, { hasCredential: boolean }>();
  try {
    const authFilePath = path.join(
      process.env.HOME ?? "",
      ".local",
      "share",
      "opencode",
      "auth.json",
    );
    const raw = await readFile(authFilePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [providerID, value] of Object.entries(parsed)) {
      result.set(providerID, { hasCredential: hasUsableCredential(value) });
    }
  } catch {
    // auth.json may not exist or be unreadable; env-var fallback still applies.
  }
  return result;
}

/**
 * Check whether an auth.json entry has a usable credential.
 * Accepts the real opencode schemas, the legacy `{ apiKey }` shape (to keep
 * older fixtures working), and bare string values (used in some legacy tests).
 */
function hasUsableCredential(entry: unknown): boolean {
  if (typeof entry === "string") {
    return entry.length > 0;
  }
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as Record<string, unknown>;
  const entryType = typeof record.type === "string" ? record.type : undefined;
  if (entryType === "api") {
    return typeof record.key === "string" && record.key.length > 0;
  }
  if (entryType === "oauth") {
    return typeof record.access === "string" && record.access.length > 0;
  }
  // Legacy / fixture shape: { apiKey: "..." }
  if (typeof record.apiKey === "string" && record.apiKey.length > 0) {
    return true;
  }
  // Fallback: any object that carries a non-empty `key` string.
  if (typeof record.key === "string" && record.key.length > 0) {
    return true;
  }
  return false;
}

/**
 * Initialize provider health state by checking for missing API keys.
 */
async function initializeProviderHealthState(
  modelRegistryEntries: ModelRegistryEntry[],
): Promise<{
  providerHealthMap: Map<string, ProviderHealth>;
  modelRouteHealthMap: Map<string, ModelRouteHealth>;
}> {
  const providerHealthMap = await loadPersistedProviderHealth();
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();

  const authKeys = await loadAuthKeys();
  const knownProviders = new Set<string>();

  for (const entry of modelRegistryEntries) {
    for (const route of entry.provider_order) {
      knownProviders.add(route.provider);
    }
  }

  const now = Date.now();
  let hasChanges = false;
  for (const providerID of knownProviders) {
    // Only mark as key_missing if not already in a penalty state
    if (!providerHealthMap.has(providerID)) {
      const hasKey =
        authKeys.get(providerID)?.hasCredential === true ||
        providerHasEnvVarCredential(providerID);

      if (!hasKey) {
        providerHealthMap.set(providerID, {
          state: "key_missing",
          until: Number.POSITIVE_INFINITY,
          retryCount: 0,
        });
        hasChanges = true;
      }
    }
  }

  if (hasChanges) {
    await persistProviderHealth(providerHealthMap);
  }

  return { providerHealthMap, modelRouteHealthMap };
}

/**
 * Recommend a model route for a task, considering agent metadata, provider health, and registry.
 */
async function recommendTaskModelRoute(
  rootDirectory: string,
  task: {
    subagent_type: string;
    prompt: string;
    complexity?: TaskComplexity;
    agent?: string;
    description?: string;
  },
  modelRegistryEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): Promise<ModelRouteDecision> {
  const agentMetadata = task.agent
    ? await readAgentMetadata(rootDirectory, task.agent)
    : task.subagent_type
      ? await readAgentMetadata(rootDirectory, task.subagent_type)
      : null;

  const complexity = task.complexity ??
    agentMetadata?.routing_complexity ??
    inferTaskComplexity(task.prompt, null);

  const preferredModels = agentMetadata?.models ??
    (agentMetadata?.model ? [agentMetadata.model] : []);

  // Only use explicit role from agent metadata; otherwise filter by complexity only
  const role = agentMetadata?.routing_role ?? null;

  // Filter to enabled models that match the role (if specified) and capability tier
  const tierMap: Record<TaskComplexity, CapabilityTier[]> = {
    small: ["tiny", "fast", "standard"],
    medium: ["standard", "strong"],
    large: ["strong", "frontier"],
  };
  const allowedTiers = tierMap[complexity];

  const roleMatchedEntries = modelRegistryEntries.filter((entry) => {
    if (!entry.enabled) return false;
    if (role && !entry.default_roles.includes(role)) return false;

    // Apply capability tier filter based on complexity
    return allowedTiers.includes(entry.capability_tier);
  });

  // When complexity allows multiple tiers, sort to prefer higher tiers first
  if (allowedTiers.length > 1) {
    const tierOrder = ["frontier", "strong", "standard", "fast", "tiny"] as const;
    roleMatchedEntries.sort((a, b) => {
      const aTierIdx = tierOrder.indexOf(a.capability_tier as typeof tierOrder[number]);
      const bTierIdx = tierOrder.indexOf(b.capability_tier as typeof tierOrder[number]);
      return aTierIdx - bTierIdx;
    });
  }

  // If agent has preferred models, try those first
  if (preferredModels.length > 0) {
    for (const preferredModel of preferredModels) {
      for (const entry of roleMatchedEntries) {
        const visibleRoutes = filterVisibleProviderRoutes(entry.provider_order);
        for (const route of visibleRoutes) {
          if (route.model === preferredModel) {
            const providerHealthy = isProviderHealthy(providerHealthMap, route.provider, now);
            const routeHealthy = !modelRouteHealthMap.has(route.model) ||
              (modelRouteHealthMap.get(route.model)?.until ?? 0) <= now;

            if (providerHealthy && routeHealthy) {
              return {
                selectedModelRoute: route.model,
                reasoning: `Preferred model from agent metadata, healthy provider`,
              };
            }
          }
        }
      }
    }
  }

  // Fall back to selecting the best model from the registry
  const best = selectBestModelForRoleAndTask(
    roleMatchedEntries,
    providerHealthMap,
    modelRouteHealthMap,
    now,
    role,
    task.description ?? task.prompt,
    null,
  );

  if (best) {
    const primaryRoute = best.provider_order[0];
    if (primaryRoute) {
      return {
        selectedModelRoute: `${primaryRoute.provider}/${primaryRoute.model}`,
        reasoning: `Best registry model for role '${role}' and complexity '${complexity}'`,
      };
    }
  }

  // Last resort: use the first visible route from any role-matched entry
  for (const entry of roleMatchedEntries) {
    const visibleRoutes = filterVisibleProviderRoutes(entry.provider_order);
    for (const route of visibleRoutes) {
      if (isProviderHealthy(providerHealthMap, route.provider, now)) {
        return {
          selectedModelRoute: route.model,
          reasoning: `Fallback to first healthy visible route`,
        };
      }
    }
  }

  throw new Error(
    `No healthy model route found for agent '${task.subagent_type}' with role '${role}' and complexity '${complexity}'`,
  );
}

/**
 * Select the best available model for a given role and/or task.
 *
 * Selection criteria (in order):
 * 1. Primary provider is currently healthy (not in any penalty state)
 * 2. Billing mode preference: free > subscription > quota > paid_api
 * 3. Capability tier match if requested
 */
export function selectBestModelForRoleAndTask(
  modelRegistryEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  _modelRouteHealthMap: Map<string, ModelRouteHealth>,
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
    // Prefer higher capability tier first
    const aTierIdx = tierOrder.indexOf(a.capability_tier as typeof tierOrder[number]);
    const bTierIdx = tierOrder.indexOf(b.capability_tier as typeof tierOrder[number]);
    if (aTierIdx !== bTierIdx) return aTierIdx - bTierIdx;

    // Count unhealthy visible routes for each model
    const aVisibleRoutes = filterVisibleProviderRoutes(a.provider_order);
    const bVisibleRoutes = filterVisibleProviderRoutes(b.provider_order);

    const aUnhealthyCount = aVisibleRoutes.filter(
      (route) => !isProviderHealthy(providerHealthMap, route.provider, now),
    ).length;
    const bUnhealthyCount = bVisibleRoutes.filter(
      (route) => !isProviderHealthy(providerHealthMap, route.provider, now),
    ).length;

    // Prefer models with fewer unhealthy visible routes
    if (aUnhealthyCount !== bUnhealthyCount) return aUnhealthyCount - bUnhealthyCount;

    // Then prefer billing mode
    const aBillingIdx = BILLING_MODE_PREFERENCE_ORDER.indexOf(a.billing_mode as typeof BILLING_MODE_PREFERENCE_ORDER[number]);
    const bBillingIdx = BILLING_MODE_PREFERENCE_ORDER.indexOf(b.billing_mode as typeof BILLING_MODE_PREFERENCE_ORDER[number]);
    if (aBillingIdx !== bBillingIdx) return aBillingIdx - bBillingIdx;

    return 0;
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

// Exported functions for testing and external use
export { inferTaskComplexity, recommendTaskModelRoute, initializeProviderHealthState };

export const ModelRegistryPlugin: Plugin = async () => {
  const providerHealthMap = await loadPersistedProviderHealth();
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const sessionActiveProviderMap = new Map<string, string>();
  const sessionActiveModelMap = new Map<string, { id: string; providerID: string }>();
  const sessionStartTimeMap = new Map<string, number>();

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
    void persistProviderHealth(providerHealthMap, modelRouteHealthMap);
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
            modelRouteHealthMap,
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
          const status: Record<string, { state: string; until: string; type: string; retryCount: number } | null> = {};

          // Include provider health
          for (const [providerID, health] of providerHealthMap.entries()) {
            if (health.until <= now) {
              providerHealthMap.delete(providerID);
              continue;
            }
            status[providerID] = {
              state: health.state,
              until: new Date(health.until).toISOString(),
              type: "provider",
              retryCount: health.retryCount,
            };
          }

          // Include model route health
          for (const [routeKey, health] of modelRouteHealthMap.entries()) {
            if (health.until <= now) {
              modelRouteHealthMap.delete(routeKey);
              continue;
            }
            status[routeKey] = {
              state: health.state,
              until: new Date(health.until).toISOString(),
              type: "model_route",
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
      if (event.type === "session.error") {
        const sessionError = event.properties;
        if (!sessionError?.error || sessionError.error.name !== "APIError") {
          return;
        }

        const apiError = sessionError.error;
        const statusCode: number = apiError.data.statusCode ?? 0;
        const message: string = (apiError.data.message ?? "").toLowerCase();

        const sessionID = sessionError.sessionID;
        if (!sessionID) return;

        // Turn is done (errored); clear its hang-detector start time so any
        // pending setTimeout from chat.params no-ops on fire.
        sessionStartTimeMap.delete(sessionID);

        const providerID = sessionActiveProviderMap.get(sessionID);
        if (!providerID) return;

        const model = (sessionError as any).model ?? sessionActiveModelMap.get(sessionID);
        const modelID = model?.id;
        const routeKey = modelID ? `${providerID}/${modelID}` : null;

        // "Model not found" message → model_not_found backoff (1h).
        // Note: we require the message match — a bare 500 is routinely a
        // transient upstream error and must not poison an otherwise-working
        // route. Tested statusCode/message combinations: 500+"Model not found"
        // (openrouter synthesized), 404+"model not found" (direct providers).
        const isModelNotFound =
          modelID !== undefined && message.includes("model not found");
        if (isModelNotFound && routeKey) {
          const existing = modelRouteHealthMap.get(routeKey);
          modelRouteHealthMap.set(routeKey, {
            state: "model_not_found",
            until: Date.now() + QUOTA_BACKOFF_DURATION_MS,
            retryCount: (existing?.retryCount ?? 0) + 1,
          });
          void persistProviderHealth(providerHealthMap, modelRouteHealthMap);
          return;
        }

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
        return;
      }

      if ((event as any).type === "assistant.message.completed") {
        const props = (event as any).properties as any;
        const sessionID = props.sessionID;
        if (!sessionID) return;

        const tokens = props.tokens;
        if (!tokens) return;

        // Deliberate: do NOT classify based on wall-clock duration here.
        // A completed turn is by definition not hung — deep reasoning turns
        // (kimi-k2-thinking, minimax-m2.7, cogito-2.1 with 200+ tool calls)
        // routinely exceed any ambient timeout but succeed normally. The
        // setTimeout-based hang detector in chat.params is the only valid
        // "still running after N seconds" signal; once completion fires we
        // clear that session's start-time so the late-firing setTimeout
        // becomes a no-op.
        sessionStartTimeMap.delete(sessionID);

        // Zero tokens on both input and output indicates quota exhaustion
        if (tokens.input === 0 && tokens.output === 0) {
          const providerID = sessionActiveProviderMap.get(sessionID);
          const model = sessionActiveModelMap.get(sessionID);
          if (!providerID || !model) return;

          const routeKey = `${providerID}/${model.id}`;
          const existing = modelRouteHealthMap.get(routeKey);
          modelRouteHealthMap.set(routeKey, {
            state: "quota",
            until: Date.now() + QUOTA_BACKOFF_DURATION_MS,
            retryCount: (existing?.retryCount ?? 0) + 1,
          });
          void persistProviderHealth(providerHealthMap, modelRouteHealthMap);
        }
        return;
      }
    },

    async "chat.params"(input, output) {
      try {
        sessionActiveProviderMap.set(input.sessionID, input.provider.info.id);
        sessionActiveModelMap.set(input.sessionID, {
          id: input.model.id,
          providerID: input.model.providerID,
        });
        sessionStartTimeMap.set(input.sessionID, Date.now());

        const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
        const modelRegistryEntry = findRegistryEntryByModel(modelRegistry.models, {
          id: input.model.id,
          providerID: input.model.providerID,
        });

        if (modelRegistryEntry) {
          output.temperature =
            CAPABILITY_TIER_TO_TEMPERATURE[modelRegistryEntry.capability_tier];
        }

        // Schedule a timeout check that runs after the timeout period
        const timeoutMs = parseInt(process.env.AICODER_ROUTE_HANG_TIMEOUT_MS ?? "900000", 10);

        // For testing purposes with very short timeouts, mark as timeout immediately
        if (timeoutMs < 1000) {
          const providerID = input.provider.info.id;
          const model = input.model;
          if (providerID && model) {
            const routeKey = `${providerID}/${model.id}`;
            const existing = modelRouteHealthMap.get(routeKey);
            modelRouteHealthMap.set(routeKey, {
              state: "timeout",
              until: Date.now() + QUOTA_BACKOFF_DURATION_MS,
              retryCount: (existing?.retryCount ?? 0) + 1,
            });
            void persistProviderHealth(providerHealthMap, modelRouteHealthMap);
          }
        } else {
          const hangTimer = setTimeout(() => {
            const startTime = sessionStartTimeMap.get(input.sessionID);
            if (!startTime) return; // Session already completed

            const duration = Date.now() - startTime;
            if (duration > timeoutMs) {
              const providerID = sessionActiveProviderMap.get(input.sessionID);
              const model = sessionActiveModelMap.get(input.sessionID);
              if (providerID && model) {
                const routeKey = `${providerID}/${model.id}`;
                const existing = modelRouteHealthMap.get(routeKey);
                modelRouteHealthMap.set(routeKey, {
                  state: "timeout",
                  until: Date.now() + QUOTA_BACKOFF_DURATION_MS,
                  retryCount: (existing?.retryCount ?? 0) + 1,
                });
                void persistProviderHealth(providerHealthMap, modelRouteHealthMap);
              }
            }
          }, timeoutMs + 100); // Check slightly after the timeout threshold
          // Do not keep the Node event loop alive waiting on a hang timer —
          // the timer is best-effort health telemetry, not critical work.
          hangTimer.unref?.();
        }
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
