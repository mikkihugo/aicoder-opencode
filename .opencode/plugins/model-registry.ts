import { type Plugin, tool } from "@opencode-ai/plugin";

import {
  buildModelRegistryPayload,
  filterModelRegistryEntries,
  loadModelRegistry,
} from "../../src/model-registry.ts";

async function listCuratedModels(
  directory: string,
  options: {
    freeOnly: boolean;
    role: string | null;
    provider: string | null;
  },
): Promise<string> {
  const modelRegistry = await loadModelRegistry(directory);
  const filteredEntries = filterModelRegistryEntries(modelRegistry.models, {
    freeOnly: options.freeOnly,
    roleFilter: options.role,
    providerFilter: options.provider,
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
        async execute(args, context) {
          return listCuratedModels(context.directory, args);
        },
      }),
      select_models_for_role: tool({
        description: "List curated routing models recommended for one role.",
        args: {
          role: tool.schema.string(),
          freeOnly: tool.schema.boolean().default(false),
          provider: tool.schema.string().nullable().default(null),
        },
        async execute(args, context) {
          return listCuratedModels(context.directory, {
            freeOnly: args.freeOnly,
            role: args.role,
            provider: args.provider,
          });
        },
      }),
    },
  };
};
