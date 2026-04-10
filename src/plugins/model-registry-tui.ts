/**
 * TUI plugin that exposes curated model-registry slash commands.
 */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  filterModelRegistryEntries,
  loadModelRegistry,
} from "../model-registry.js";

const CONTROL_PLANE_ROOT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MAX_VISIBLE_MODEL_COUNT = 20;
const LIST_MODELS_COMMAND_VALUE = "list-curated-models";
const SELECT_MODEL_COMMAND_VALUE = "select-curated-model";
const MODEL_REGISTRY_CATEGORY_NAME = "Model Registry";
const CURATED_MODELS_TOAST_TITLE = "Curated models";
const MODEL_REGISTRY_ERROR_TOAST_TITLE = "Model Registry Error";
const SELECT_MODEL_TOAST_TITLE = "select-model";
const SELECT_MODEL_TOAST_MESSAGE =
  "Use: /select-model <role>  e.g. architect, reviewer, combatant";
const INFO_TOAST_DURATION_MS = 8_000;
const ERROR_TOAST_DURATION_MS = 5_000;
const ROLE_HINT_TOAST_DURATION_MS = 5_000;

function formatModelIdentifierList(modelIdentifiers: string[]): string {
  const visibleModelIdentifiers = modelIdentifiers.slice(0, MAX_VISIBLE_MODEL_COUNT);
  const hiddenModelCount = modelIdentifiers.length - visibleModelIdentifiers.length;
  const visibleModelList = visibleModelIdentifiers.join("\n");

  if (hiddenModelCount <= 0) {
    return visibleModelList;
  }

  return `${visibleModelList}\n... and ${hiddenModelCount} more`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function showCuratedModelsToast(api: Parameters<TuiPlugin>[0]): void {
  void (async () => {
    try {
      const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
      const enabledModelEntries = filterModelRegistryEntries(modelRegistry.models, {
        freeOnly: false,
        roleFilter: null,
        providerFilter: null,
        enabledOnly: true,
      });
      const modelIdentifiers = enabledModelEntries.map((modelEntry) => modelEntry.id);

      api.ui.toast({
        variant: "info",
        title: CURATED_MODELS_TOAST_TITLE,
        message: formatModelIdentifierList(modelIdentifiers),
        duration: INFO_TOAST_DURATION_MS,
      });
    } catch (error: unknown) {
      api.ui.toast({
        variant: "error",
        title: MODEL_REGISTRY_ERROR_TOAST_TITLE,
        message: toErrorMessage(error),
        duration: ERROR_TOAST_DURATION_MS,
      });
    }
  })();
}

export const ModelRegistryTuiPlugin: TuiPlugin = async (api) => {
  const unregisterCommands = api.command.register(() => [
    {
      title: "List curated models",
      value: LIST_MODELS_COMMAND_VALUE,
      category: MODEL_REGISTRY_CATEGORY_NAME,
      description: "Show curated model list",
      slash: { name: "list-models", aliases: ["lm"] },
      onSelect: () => {
        showCuratedModelsToast(api);
      },
    },
    {
      title: "Select model for role",
      value: SELECT_MODEL_COMMAND_VALUE,
      category: MODEL_REGISTRY_CATEGORY_NAME,
      description: "Filter to curated model for a role",
      slash: { name: "select-model", aliases: ["sm"] },
      onSelect: () => {
        api.ui.toast({
          variant: "info",
          title: SELECT_MODEL_TOAST_TITLE,
          message: SELECT_MODEL_TOAST_MESSAGE,
          duration: ROLE_HINT_TOAST_DURATION_MS,
        });
      },
    },
  ]);

  api.lifecycle.onDispose(unregisterCommands);
};

const modelRegistryTuiPluginModule = {
  tui: ModelRegistryTuiPlugin,
} satisfies TuiPluginModule;

export default modelRegistryTuiPluginModule;
