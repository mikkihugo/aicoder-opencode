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
    },
    provider: {
      id: OPENROUTER_PROVIDER_ID,
      async models(provider) {
        try {
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
    async "chat.params"(input, output) {
      try {
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
      } catch {
        return;
      }
    },
  };
};
