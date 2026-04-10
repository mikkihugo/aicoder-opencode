import test from "node:test";
import assert from "node:assert/strict";

import {
  filterModelRegistryEntries,
  filterVisibleProviderRoutes,
  getPreferredVisibleProviderRoute,
  isBillingMode,
  isCostTier,
  listBillingModeValues,
  listCostTierValues,
  loadModelRegistry,
  parsePositiveInteger,
  parseInteractiveRowIndex,
  parseModelSelectionOptions,
  parseRoleList,
  renderModelRegistryJsonc,
} from "./model-registry.js";

const CONTROL_PLANE_ROOT_DIRECTORY = process.cwd();

test("loadModelRegistry_whenRegistryExists_returnsCuratedModels", async () => {
  const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);

  assert.equal(modelRegistry.models.length > 0, true);
});

test("parseModelSelectionOptions_whenFlagsProvided_returnsParsedFilters", () => {
  const options = parseModelSelectionOptions([
    "--free",
    "--role",
    "architect",
    "--provider",
    "ollama-cloud",
  ]);

  assert.deepEqual(options, {
    freeOnly: true,
    roleFilter: "architect",
    providerFilter: "ollama-cloud",
    enabledOnly: false,
  });
});

test("filterModelRegistryEntries_whenFreeOnlyRequested_keepsOnlyFreeModels", async () => {
  const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
  const filteredEntries = filterModelRegistryEntries(modelRegistry.models, {
    freeOnly: true,
    roleFilter: null,
    providerFilter: null,
    enabledOnly: false,
  });

  assert.equal(
    filteredEntries.every((modelEntry) => modelEntry.cost_tier === "free"),
    true,
  );
});

test("listCostTierValues_whenRequested_returnsDropdownValues", () => {
  assert.deepEqual(listCostTierValues(), ["free", "cheap", "medium", "expensive"]);
});

test("listBillingModeValues_whenRequested_returnsDropdownValues", () => {
  assert.deepEqual(listBillingModeValues(), ["free", "subscription", "quota", "paid_api"]);
});

test("renderModelRegistryJsonc_whenRendered_preservesRegistryHeaderComment", async () => {
  const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
  const renderedJsonc = renderModelRegistryJsonc(modelRegistry);

  assert.equal(
    renderedJsonc.startsWith("{\n  // Canonical control-plane model registry."),
    true,
  );
});

test("parseInteractiveRowIndex_whenRowIsOutOfRange_returnsNull", () => {
  assert.equal(parseInteractiveRowIndex("0", 4), null);
});

test("isCostTier_whenValueIsKnown_returnsTrue", () => {
  assert.equal(isCostTier("medium"), true);
});

test("isBillingMode_whenValueIsUnknown_returnsFalse", () => {
  assert.equal(isBillingMode("metered"), false);
});

test("parsePositiveInteger_whenValueIsInvalid_returnsNull", () => {
  assert.equal(parsePositiveInteger("0"), null);
});

test("parseRoleList_whenCommaSeparated_returnsTrimmedRoles", () => {
  assert.deepEqual(parseRoleList("architect, coder,oracle"), [
    "architect",
    "coder",
    "oracle",
  ]);
});

test("filterVisibleProviderRoutes_whenOpenRouterRoutesAreMixed_keepsOnlyAllowedOpenRouterRoutes", () => {
  const visibleRoutes = filterVisibleProviderRoutes([
    {
      provider: "opencode",
      model: "opencode/glm-5.1",
      priority: 1,
    },
    {
      provider: "opencode",
      model: "opencode/minimax-m2.5-free",
      priority: 2,
    },
    {
      provider: "openrouter",
      model: "openrouter/auto",
      priority: 3,
    },
    {
      provider: "openrouter",
      model: "openrouter/bodybuilder",
      priority: 4,
    },
    {
      provider: "openrouter",
      model: "openrouter/openrouter/free",
      priority: 5,
    },
    {
      provider: "openrouter",
      model: "openrouter/xiaomi/mimo-v2-pro",
      priority: 6,
    },
    {
      provider: "opencode-go",
      model: "opencode-go/mimo-v2-pro",
      priority: 7,
    },
    {
      provider: "cloudflare-ai-gateway",
      model: "cloudflare-ai-gateway/openai/gpt-5.4",
      priority: 8,
    },
    {
      provider: "togetherai",
      model: "togetherai/zai-org/GLM-5.1",
      priority: 9,
    },
    {
      provider: "cerebras",
      model: "cerebras/zai-glm-4.7",
      priority: 10,
    },
    {
      provider: "xai",
      model: "xai/grok-4-fast",
      priority: 11,
    },
    {
      provider: "xai",
      model: "xai/grok-4.20-0309-reasoning",
      priority: 12,
    },
    {
      provider: "deepseek",
      model: "deepseek/deepseek-reasoner",
      priority: 13,
    },
    {
      provider: "github-copilot",
      model: "github-copilot/gpt-5.4",
      priority: 14,
    },
    {
      provider: "minimax-cn",
      model: "minimax-cn/MiniMax-M2.5",
      priority: 15,
    },
    {
      provider: "minimax",
      model: "minimax/MiniMax-M2.5",
      priority: 16,
    },
    {
      provider: "minimax-coding-plan",
      model: "minimax-coding-plan/MiniMax-M2.5",
      priority: 17,
    },
    {
      provider: "openrouter",
      model: "openrouter/stepfun/step-3.5-flash:free",
      priority: 18,
    },
  ]);

  assert.deepEqual(visibleRoutes.map((route) => route.model), [
    "opencode/minimax-m2.5-free",
    "opencode-go/mimo-v2-pro",
    "xai/grok-4.20-0309-reasoning",
    "minimax/MiniMax-M2.5",
    "minimax-coding-plan/MiniMax-M2.5",
    "openrouter/stepfun/step-3.5-flash:free",
  ]);
});

test("getPreferredVisibleProviderRoute_whenTopOpenRouterRoutesAreFiltered_returnsNextAllowedRoute", () => {
  const preferredRoute = getPreferredVisibleProviderRoute([
    {
      provider: "openrouter",
      model: "openrouter/auto",
      priority: 1,
    },
    {
      provider: "openrouter",
      model: "openrouter/xiaomi/mimo-v2-pro",
      priority: 2,
    },
    {
      provider: "xiaomi-token-plan-ams",
      model: "xiaomi-token-plan-ams/mimo-v2-pro",
      priority: 3,
    },
  ]);

  assert.equal(preferredRoute?.model, "xiaomi-token-plan-ams/mimo-v2-pro");
});
