import type { Event } from "@opencode-ai/sdk";
import { type Plugin, tool } from "@opencode-ai/plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const PROVIDER_QUOTA_STATUS_HEADER = "## Provider quota status";
const NO_FALLBACK_MODEL_CONFIGURED_MESSAGE = "no fallback configured";

// Providers and model name substrings excluded from fallback suggestions.
// These are subscription-gated, paid-only, or architecturally undesirable
// as automatic fallbacks during quota events.
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

type ModelIdentity = {
  id: string;
  providerID: string;
};

function logRegistryLoadError(error: unknown): void {
  console.error(MODEL_REGISTRY_LOAD_ERROR_MESSAGE, error);
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
): string {
  const allowedRoute = modelRegistryEntry.provider_order.find(
    (providerRoute) =>
      providerRoute.provider !== blockedProviderID &&
      !isFallbackBlocked(providerRoute.provider, providerRoute.model),
  );

  if (!allowedRoute) {
    return NO_FALLBACK_MODEL_CONFIGURED_MESSAGE;
  }

  return `${allowedRoute.provider}/${allowedRoute.model}`;
}

function buildProviderQuotaStatusSystemPrompt(
  modelRegistryEntries: ModelRegistryEntry[],
  providerQuotaBackoffMap: Map<string, number>,
  now: number,
): string | null {
  const quotaStatusSections = Array.from(providerQuotaBackoffMap.entries())
    .filter(([, backoffUntil]) => backoffUntil > now)
    .map(([providerID, backoffUntil]) => {
      // All curated enabled models that list this provider in their routing order.
      const affectedEntries = modelRegistryEntries.filter(
        (modelRegistryEntry) =>
          modelRegistryEntry.enabled &&
          modelRegistryEntry.provider_order.some(
            (providerRoute) => providerRoute.provider === providerID,
          ),
      );

      const fallbackLines = affectedEntries.map((modelRegistryEntry) => {
        const fallback = findCuratedFallbackRoute(modelRegistryEntry, providerID);
        return `- ${modelRegistryEntry.id} → ${fallback}`;
      });

      return [
        PROVIDER_QUOTA_STATUS_HEADER,
        `Provider ${providerID} is in quota backoff until ${new Date(backoffUntil).toISOString()}.`,
        `Use these curated fallbacks (longcat/claude/gpt/grok excluded):`,
        ...fallbackLines,
      ].join("\n");
    });

  if (quotaStatusSections.length === 0) {
    return null;
  }

  return quotaStatusSections.join("\n\n");
}

async function listCuratedModels(
  options: {
    freeOnly: boolean;
    role: string | null;
    provider: string | null;
  },
): Promise<string> {
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
      models: filteredEntries.map(buildModelRegistryPayload),
    },
    null,
    2,
  );
}

export const ModelRegistryPlugin: Plugin = async () => {
  const providerQuotaBackoffMap = new Map<string, number>();
  const sessionActiveProviderMap = new Map<string, string>();
  const QUOTA_BACKOFF_DURATION_MS = 60 * 60 * 1000;
  const QUOTA_HTTP_STATUS_CODE = 429;
  const QUOTA_KEYWORDS = ["quota", "rate limit", "rate_limit", "too many requests"];

  return {
    tool: {
      list_curated_models: tool({
        description: "List curated routing models from aicoder-opencode models.jsonc.",
        args: {
          freeOnly: tool.schema.boolean().default(false),
          role: tool.schema.string().nullable().default(null),
          provider: tool.schema.string().nullable().default(null),
        },
        async execute(args) {
          return listCuratedModels(args);
        },
      }),
      select_models_for_role: tool({
        description: "List curated routing models recommended for one role.",
        args: {
          role: tool.schema.string(),
          freeOnly: tool.schema.boolean().default(false),
          provider: tool.schema.string().nullable().default(null),
        },
        async execute(args) {
          return listCuratedModels({
            freeOnly: args.freeOnly,
            role: args.role,
            provider: args.provider,
          });
        },
      }),
      get_quota_backoff_status: tool({
        description:
          "Return which LLM providers are currently in quota backoff and when they expire.",
        args: {},
        async execute() {
          const now = Date.now();
          const status: Record<string, string | null> = {};

          for (const [providerID, until] of providerQuotaBackoffMap.entries()) {
            if (until <= now) {
              providerQuotaBackoffMap.delete(providerID);
              continue;
            }

            status[providerID] = new Date(until).toISOString();
          }

          return JSON.stringify(status, null, 2);
        },
      }),
    },
    provider: {
      id: OPENROUTER_PROVIDER_ID,
      async models(provider) {
        try {
          const backoffUntil = providerQuotaBackoffMap.get(OPENROUTER_PROVIDER_ID);
          if (backoffUntil && backoffUntil > Date.now()) {
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
      const isQuotaError =
        apiError.data.statusCode === QUOTA_HTTP_STATUS_CODE ||
        QUOTA_KEYWORDS.some((quotaKeyword) =>
          apiError.data.message?.toLowerCase().includes(quotaKeyword),
        );

      if (!isQuotaError) {
        return;
      }

      const sessionID = sessionError.sessionID;
      if (!sessionID) {
        return;
      }

      const providerID = sessionActiveProviderMap.get(sessionID);
      if (!providerID) {
        return;
      }

      providerQuotaBackoffMap.set(providerID, Date.now() + QUOTA_BACKOFF_DURATION_MS);
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
        const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
        const modelRegistryEntry = findRegistryEntryByModel(modelRegistry.models, {
          id: input.model.id,
          providerID: input.model.providerID,
        });

        if (!modelRegistryEntry) {
          return;
        }

        output.system.push(buildRoutingContextSystemPrompt(modelRegistryEntry));

        const providerQuotaStatusSystemPrompt = buildProviderQuotaStatusSystemPrompt(
          modelRegistry.models,
          providerQuotaBackoffMap,
          Date.now(),
        );

        if (providerQuotaStatusSystemPrompt) {
          output.system.push(providerQuotaStatusSystemPrompt);
        }
      } catch {
        return;
      }
    },
  };
};
