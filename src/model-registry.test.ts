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
  parseProviderRouteList,
  parseRoleList,
  renderModelRegistryJsonc,
} from "./model-registry.js";
import {
  enrichRuntimeModelFamiliesFromRegistry,
  groupVisibleRuntimeModelFamilies,
  renderRuntimeModelFamily,
} from "./cli/model-commands.js";

const CONTROL_PLANE_ROOT_DIRECTORY = process.cwd();

test("loadModelRegistry_whenRegistryExists_returnsCuratedModels", async () => {
  const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);

  assert.equal(modelRegistry.models.length > 0, true);
});

test("loadModelRegistry_whenQwenOauthRouteIsCurated_includesQwenThreePointFiveCoder", async () => {
  const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
  const qwenModelEntry = modelRegistry.models.find((entry) => entry.id === "qwen-3.5-coder");

  assert.equal(qwenModelEntry?.provider_order[0]?.model, "qwen/qwen-3.5-coder");
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
    "minimax/MiniMax-M2.5",
    "minimax-coding-plan/MiniMax-M2.5",
    "openrouter/stepfun/step-3.5-flash:free",
  ]);
});

test("filterVisibleProviderRoutes_whenInputArrayOrderDivergesFromPriority_returnsPrioritySorted", () => {
  // Pin the invariant that `filterVisibleProviderRoutes` returns routes
  // in ascending-priority order regardless of the array order in which
  // the config authored them. Several plugin call sites treat the result's
  // `[0]` as the "primary route" (computeRegistryEntryHealthReport, the
  // `provider.models` active-route resolution, findHealthyRouteForFallback),
  // so a models.jsonc entry with out-of-order `provider_order` would have
  // silently poisoned every primary-route decision if the filter preserved
  // insertion order. Deliberately feed the input in reverse priority to
  // prove the sort is authoritative.
  const visibleRoutes = filterVisibleProviderRoutes([
    {
      provider: "openrouter",
      model: "openrouter/stepfun/step-3.5-flash:free",
      priority: 3,
    },
    {
      provider: "ollama-cloud",
      model: "ollama-cloud/glm-5",
      priority: 1,
    },
    {
      provider: "opencode-go",
      model: "opencode-go/glm-5",
      priority: 2,
    },
  ]);

  assert.deepEqual(
    visibleRoutes.map((route) => ({
      provider: route.provider,
      priority: route.priority,
    })),
    [
      { provider: "ollama-cloud", priority: 1 },
      { provider: "opencode-go", priority: 2 },
      { provider: "openrouter", priority: 3 },
    ],
  );
});

test("filterVisibleProviderRoutes_whenHiddenRoutesInterleavedWithOutOfOrderVisibleRoutes_sortsOnlyTheSurvivors", () => {
  // Regression case: hidden routes (togetherai, xai) are interleaved
  // with visible survivors whose authored order is REVERSED from their
  // priority. A naive implementation that either (a) preserved insertion
  // order or (b) sorted BEFORE filtering could land the wrong survivor at
  // `[0]`. The contract: priority order across the surviving subset.
  const visibleRoutes = filterVisibleProviderRoutes([
    {
      provider: "ollama-cloud",
      model: "ollama-cloud/glm-5",
      priority: 7,
    },
    {
      provider: "togetherai",
      model: "togetherai/zai-org/GLM-5.1",
      priority: 1,
    },
    {
      provider: "opencode",
      model: "opencode/minimax-m2.5-free",
      priority: 5,
    },
    {
      provider: "xai",
      model: "xai/grok-4-fast",
      priority: 2,
    },
  ]);

  assert.deepEqual(visibleRoutes.map((route) => route.priority), [5, 7]);
  assert.equal(visibleRoutes[0]?.provider, "opencode");
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

test("parseProviderRouteList_whenValidRoutesProvided_returnsOrderedRoutes", () => {
  const routes = parseProviderRouteList("ollama-cloud/glm-5,openrouter/stepfun/step-3.5-flash:free");

  assert.deepEqual(routes, [
    { provider: "ollama-cloud", model: "ollama-cloud/glm-5", priority: 1 },
    { provider: "openrouter", model: "openrouter/stepfun/step-3.5-flash:free", priority: 2 },
  ]);
});

test("parseProviderRouteList_whenRouteHasNoSlash_throws", () => {
  assert.throws(
    () => parseProviderRouteList("invalid-no-slash"),
    /invalid provider\/model route/,
  );
});

test("renderModelRegistryJsonc_whenRendered_indentsTopLevelFieldsAtTwoSpaces", async () => {
  const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
  const renderedJsonc = renderModelRegistryJsonc(modelRegistry);
  const lines = renderedJsonc.split("\n");

  // First content line after the opening brace should be a 2-space-indented comment
  assert.equal(lines[1]?.startsWith("  //"), true);

  // No line inside the braces should start with 4+ spaces for top-level keys
  // (i.e., the "version" line should be at 2-space indent, not 4)
  const versionLine = lines.find((line) => line.includes('"version"'));
  assert.ok(versionLine !== undefined, "version line not found");
  assert.equal(versionLine!.startsWith("  ") && !versionLine!.startsWith("    "), true);
});

test("filterModelRegistryEntries_whenEnabledOnlyRequested_excludesDisabledModels", async () => {
  const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);

  // Temporarily disable the first model to have a known disabled entry
  const firstEntry = modelRegistry.models[0]!;
  const originalEnabled = firstEntry.enabled;
  firstEntry.enabled = false;

  const filteredEntries = filterModelRegistryEntries(modelRegistry.models, {
    freeOnly: false,
    roleFilter: null,
    providerFilter: null,
    enabledOnly: true,
  });

  assert.equal(
    filteredEntries.every((modelEntry) => modelEntry.enabled),
    true,
  );
  assert.equal(filteredEntries.includes(firstEntry), false);

  // Restore
  firstEntry.enabled = originalEnabled;
});

test("groupVisibleRuntimeModelFamilies_whenRoutesShareModelName_groupsThemTogether", () => {
  const runtimeModelFamilies = groupVisibleRuntimeModelFamilies([
    "xiaomi-token-plan-ams/mimo-v2-pro",
    "opencode-go/mimo-v2-pro",
    "openrouter/stepfun/step-3.5-flash:free",
  ]);

  assert.deepEqual(runtimeModelFamilies, [
    {
      familyId: "mimo-v2-pro",
      preferredModelId: "xiaomi-token-plan-ams/mimo-v2-pro",
      providerNames: ["xiaomi-token-plan-ams", "opencode-go"],
      routes: [
        "xiaomi-token-plan-ams/mimo-v2-pro",
        "opencode-go/mimo-v2-pro",
      ],
    },
    {
      familyId: "step-3.5-flash:free",
      preferredModelId: "openrouter/stepfun/step-3.5-flash:free",
      providerNames: ["openrouter"],
      routes: ["openrouter/stepfun/step-3.5-flash:free"],
    },
  ]);
});

test("enrichRuntimeModelFamiliesFromRegistry_whenRegistryHasMatchingFamilyIds_populatesRuntimeFamilyMetadata", async () => {
  const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);

  const runtimeFamilies = enrichRuntimeModelFamiliesFromRegistry(
    [
      {
        familyId: "glm-5.1",
        preferredModelId: "opencode/glm-5.1",
        providerNames: ["opencode"],
        routes: ["opencode/glm-5.1"],
      },
      {
        familyId: "step-3.5-flash:free",
        preferredModelId: "openrouter/stepfun/step-3.5-flash:free",
        providerNames: ["openrouter"],
        routes: ["openrouter/stepfun/step-3.5-flash:free"],
      },
    ],
    modelRegistry,
  );

  assert.equal(runtimeFamilies[0]?.capabilityTier, "frontier");
  assert.equal(runtimeFamilies[0]?.costTier, "expensive");
  assert.deepEqual(runtimeFamilies[0]?.defaultRoles, ["architect", "deep_reviewer", "oracle"]);
  assert.equal(runtimeFamilies[1]?.capabilityTier, undefined);

  assert.equal(
    renderRuntimeModelFamily(runtimeFamilies[0]!),
    "glm-5.1\tpreferred=opencode/glm-5.1\tproviders=opencode\troutes=opencode/glm-5.1\ttier=frontier/expensive\troles=architect,deep_reviewer,oracle",
  );
});
