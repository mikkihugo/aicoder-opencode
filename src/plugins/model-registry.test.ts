import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ModelRegistryEntry } from "../model-registry.js";
import type { ModelRouteHealth, ProviderHealth } from "./model-registry.js";
import {
  buildAgentVisibleBackoffStatus,
  buildAvailableModelsSystemPrompt,
  buildEnabledProviderModelSet,
  buildLeadingBoundaryRegex,
  buildRoutingContextSystemPrompt,
  buildProviderHealthSummaryForTool,
  buildProviderHealthSystemPrompt,
  buildRoleRecommendationRoutes,
  buildRouteHealthEntry,
  buildModelNotFoundRouteHealth,
  classifyProviderApiError,
  collectAgentVisibleLivePenalties,
  PROVIDER_PENALTY_CLASS_TO_BACKOFF_DURATION_MS,
  isFallbackBlocked,
  findFirstHealthyRouteInEntry,
  findFirstHealthyVisibleRoute,
  isRouteCurrentlyHealthy,
  findPreferredHealthyRoute,
  isAgentVisibleHealthState,
  hasAgentVisiblePenalty,
  hasUsableCredential,
  healthStateLabel,
  isZeroTokenQuotaSignal,
  parseAgentFrontmatter,
  parseHangTimeoutMs,
  providerEnvVarCandidates,
  stripYamlScalarQuotes,
  DEFAULT_ROUTE_HANG_TIMEOUT_MS,
  ROUTE_MODEL_NOT_FOUND_DURATION_MS,
  ROUTE_QUOTA_BACKOFF_DURATION_MS,
  PROVIDER_NO_CREDIT_DURATION_MS,
  PROVIDER_KEY_DEAD_DURATION_MS,
  shouldClassifyAsModelNotFound,
  bindSessionHangState,
  clearSessionHangState,
  logPluginHookFailure,
  readAndClearSessionHangState,
  serializeHealthEntryForPersistence,
  countHealthyVisibleRoutes,
  composeRouteKey,
  findLiveProviderPenalty,
  findLiveRoutePenalty,
  lookupRouteHealthByIdentifiers,
  isAgentVisibleLivePenalty,
  recordModelNotFoundRouteHealthByIdentifiers,
  recordProviderHealthPenalty,
  recordRouteHealthByIdentifiers,
  recordRouteHealthPenalty,
  renderAvailableModelsSystemPromptBody,
  computeProviderHealthUpdate,
  computeRegistryEntryHealthReport,
  expireHealthMaps,
  filterEnabledEntriesByOptionalRole,
  filterProviderModelsByRouteHealth,
  findCuratedFallbackRoute,
  formatHealthExpiry,
  formatPenaltySectionPrefix,
  HANG_TIMEOUT_IMMEDIATE_THRESHOLD_MS,
  assembleHealthAwareSystemPrompts,
  classifyPersistedHealthKey,
  extractAssistantMessageCompletedPayload,
  extractSessionErrorApiErrorContext,
  extractSessionErrorExplicitModel,
  shouldRecordImmediateTimeoutPenalty,
  findRegistryEntryByModel,
  loadRegistryAndLookupEntryForInputModel,
  inferTaskComplexity,
  parsePersistedHealthEntry,
  recommendTaskModelRoute,
  evaluateSessionHangForTimeoutPenalty,
  finalizeHungSessionState,
  finalizeHungSessionStateAndRecordPenalty,
  selectBestModelForRoleAndTask,
  summarizeVisibleRouteHealth,
} from "./model-registry.js";

function buildModelRegistryEntry(
  id: string,
  roles: string[],
  capabilityTier: ModelRegistryEntry["capability_tier"],
  providerOrder: ModelRegistryEntry["provider_order"],
): ModelRegistryEntry {
  return {
    id,
    enabled: true,
    description: `${id} description`,
    capability_tier: capabilityTier,
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: roles,
    not_for: [],
    default_roles: roles,
    provider_order: providerOrder,
    notes: [],
  };
}

async function writeAgentMetadata(
  rootDirectory: string,
  agentName: string,
  body: string,
): Promise<void> {
  const agentsDirectory = path.join(rootDirectory, ".opencode", "agents");
  await mkdir(agentsDirectory, { recursive: true });
  await writeFile(path.join(agentsDirectory, `${agentName}.md`), body, "utf8");
}

test("inferTaskComplexity_whenPromptSystemWorkIsNamed_returnsLarge", () => {
  assert.equal(
    inferTaskComplexity(
      "Rework the prompt system across dr-repo and letta-workspace with plugin and doctrine updates.",
      null,
    ),
    "large",
  );
});

test("recommendTaskModelRoute_whenAgentModelsIncludeHealthyFallback_usesNextHealthyRoute", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "aicoder-model-routing-"));
  await writeAgentMetadata(
    tempDirectory,
    "prompt_architect",
    [
      "---",
      "model: ollama-cloud/glm-5.1",
      "models:",
      "  - ollama-cloud/glm-5.1",
      "  - ollama-cloud/glm-5",
      "routing_role: architect",
      "routing_complexity: large",
      "---",
      "",
      "Prompt architect.",
      "",
    ].join("\n"),
  );

  const providerHealthMap = new Map([
    [
      "ollama-cloud",
      {
        state: "quota" as const,
        until: Date.now() + 60_000,
        retryCount: 1,
      },
    ],
    [
      "opencode-go",
      {
        state: "quota" as const,
        until: Date.now() - 1,
        retryCount: 0,
      },
    ],
  ]);

  const decision = await recommendTaskModelRoute(
    tempDirectory,
    {
      subagent_type: "prompt_architect",
      prompt: "Tighten the prompt system contract.",
    },
    [
      buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
        { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 1 },
        { provider: "opencode-go", model: "opencode-go/glm-5.1", priority: 2 },
      ]),
      buildModelRegistryEntry("glm-5", ["architect"], "frontier", [
        { provider: "opencode-go", model: "opencode-go/glm-5", priority: 1 },
      ]),
      ],
      providerHealthMap,
      new Map(),
      Date.now(),
    );

  assert.equal(decision.selectedModelRoute, "opencode-go/glm-5.1");
  // Lock in the fix: this must resolve via the preferred-list fallback,
  // not accidentally via last-resort registry-order traversal.
  assert.match(decision.reasoning, /Preferred model from agent metadata/);
});

test("recommendTaskModelRoute_whenNoAgentMetadataExists_usesRegistryRoleAndComplexity", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "aicoder-model-routing-"));
  const decision = await recommendTaskModelRoute(
    tempDirectory,
    {
      subagent_type: "planning_analyst",
      prompt: "Plan the next production readiness slice for dr-repo.",
      complexity: "large",
    },
    [
      buildModelRegistryEntry("glm-4.7", ["architect"], "strong", [
        { provider: "ollama-cloud", model: "ollama-cloud/glm-4.7", priority: 1 },
      ]),
      buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
        { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 1 },
      ]),
      ],
      new Map(),
      new Map(),
      Date.now(),
    );

  assert.equal(decision.selectedModelRoute, "ollama-cloud/glm-5.1");
});

test("recommendTaskModelRoute_whenPreferredModelFamilyIsUnhealthy_usesNextMatchingRegistryModel", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "aicoder-model-routing-"));
  await writeAgentMetadata(
    tempDirectory,
    "implementation_lead",
    [
      "---",
      "models:",
      "  - ollama-cloud/glm-4.7",
      "routing_role: implementation_worker",
      "---",
      "",
      "Implementation lead.",
      "",
    ].join("\n"),
  );

  const providerHealthMap = new Map([
    [
      "ollama-cloud",
      {
        state: "quota" as const,
        until: Date.now() + 60_000,
        retryCount: 1,
      },
    ],
  ]);

  const decision = await recommendTaskModelRoute(
    tempDirectory,
    {
      subagent_type: "implementation_lead",
      prompt: "Continue autonomous iteration for dr-repo until done.",
    },
    [
      buildModelRegistryEntry("glm-4.7", ["implementation_worker"], "standard", [
        { provider: "ollama-cloud", model: "ollama-cloud/glm-4.7", priority: 1 },
      ]),
      buildModelRegistryEntry("qwen3-coder-plus", ["implementation_worker"], "strong", [
        { provider: "iflowcn", model: "iflowcn/qwen3-coder-plus", priority: 1 },
      ]),
    ],
    providerHealthMap,
    new Map(),
    Date.now(),
  );

  assert.equal(decision.selectedModelRoute, "iflowcn/qwen3-coder-plus");
});

test("recommendTaskModelRoute_whenAgentFrontmatterUsesBlockStyleModelsList_parsesAllItems", async () => {
  // Regression: the agent frontmatter parser used to silently drop
  // multi-line YAML list items under `models:` because the list rows
  // (e.g. `  - provider/model`) have no `:` and were skipped. The
  // recommendTaskModelRoute fallback path masked this in earlier tests,
  // but per-agent preference ordering was completely ignored fleet-wide.
  // This test locks in that the block-style list IS parsed and the
  // preferredModels path honors the declared order.
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "aicoder-model-routing-"));
  await writeAgentMetadata(
    tempDirectory,
    "block_list_agent",
    [
      "---",
      "models:",
      "  - iflowcn/qwen3-coder-plus",
      "  - opencode-go/glm-4.7",
      "routing_role: implementation_worker",
      "routing_complexity: medium",
      "---",
      "",
      "Block-style list agent.",
      "",
    ].join("\n"),
  );

  // Make iflowcn unhealthy so the second entry in the preference list
  // is the one chosen — this distinguishes the fallback path from the
  // preferred-list path.
  const providerHealthMap = new Map([
    [
      "iflowcn",
      {
        state: "quota" as const,
        until: Date.now() + 60_000,
        retryCount: 1,
      },
    ],
  ]);

  const decision = await recommendTaskModelRoute(
    tempDirectory,
    {
      subagent_type: "block_list_agent",
      prompt: "Apply a small fix.",
    },
    [
      buildModelRegistryEntry("qwen3-coder-plus", ["implementation_worker"], "strong", [
        { provider: "iflowcn", model: "iflowcn/qwen3-coder-plus", priority: 1 },
      ]),
      buildModelRegistryEntry("glm-4.7", ["implementation_worker"], "strong", [
        { provider: "opencode-go", model: "opencode-go/glm-4.7", priority: 1 },
      ]),
    ],
    providerHealthMap,
    new Map(),
    Date.now(),
  );

  assert.equal(decision.selectedModelRoute, "opencode-go/glm-4.7");
  assert.match(decision.reasoning, /Preferred model from agent metadata/);
});

test("recommendTaskModelRoute_whenPreferredRouteIsFiltered_usesNextVisibleMatchingRegistryModel", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "aicoder-model-routing-"));
  await writeAgentMetadata(
    tempDirectory,
    "implementation_lead",
    [
      "---",
      "routing_role: implementation_worker",
      "---",
      "",
      "Implementation lead.",
      "",
    ].join("\n"),
  );

  const decision = await recommendTaskModelRoute(
    tempDirectory,
    {
      subagent_type: "implementation_lead",
      prompt: "Continue autonomous iteration for dr-repo until done.",
    },
    [
      buildModelRegistryEntry("grok-4.20-review", ["implementation_worker"], "strong", [
        { provider: "togetherai", model: "togetherai/some-paid-model", priority: 1 },
      ]),
      buildModelRegistryEntry("qwen3-coder-plus", ["implementation_worker"], "strong", [
        { provider: "iflowcn", model: "iflowcn/qwen3-coder-plus", priority: 1 },
      ]),
    ],
    new Map(),
    new Map(),
    Date.now(),
  );

  assert.equal(decision.selectedModelRoute, "iflowcn/qwen3-coder-plus");
});

test("recommendTaskModelRoute_whenBestRegistryPathIsHit_returnsSinglePrefixedRoute", async () => {
  // Regression: the `best` (selectBestModelForRoleAndTask) fallback path
  // in recommendTaskModelRoute used to interpolate
  // `${primaryRoute.provider}/${primaryRoute.model}` which produced
  // `iflowcn/iflowcn/qwen3-coder-plus` — a corrupt double-prefixed
  // composite, because provider_order[].model is already composite by
  // registry convention. This test pins the single-prefix contract by
  // constructing a task prompt that matches a best_for keyword so the
  // `best` branch is live (not fallthrough to last-resort).
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "aicoder-model-routing-"));

  const decision = await recommendTaskModelRoute(
    tempDirectory,
    {
      // No agent metadata on disk → no preferred models.
      subagent_type: "implementation_lead",
      // "coding" is an exact substring match for best_for below, so the
      // selectBestModelForRoleAndTask task filter returns the entry and
      // the `best` branch is exercised.
      prompt: "coding task",
    },
    [
      {
        id: "qwen3-coder-plus",
        enabled: true,
        description: "qwen3-coder-plus description",
        capability_tier: "strong",
        cost_tier: "free",
        billing_mode: "free",
        latency_tier: "standard",
        concurrency: 1,
        quota_visibility: "system-observed",
        best_for: ["coding"],
        not_for: [],
        default_roles: ["implementation_worker"],
        provider_order: [
          { provider: "iflowcn", model: "iflowcn/qwen3-coder-plus", priority: 1 },
        ],
        notes: [],
      },
    ],
    new Map(),
    new Map(),
    Date.now(),
  );

  // Must be the single-prefix composite, never "iflowcn/iflowcn/...".
  assert.equal(decision.selectedModelRoute, "iflowcn/qwen3-coder-plus");
  assert.doesNotMatch(decision.selectedModelRoute, /^[^/]+\/[^/]+\//);
});

test("recommendTaskModelRoute_whenBestEntryPrimaryRouteIsHiddenOrUnhealthy_fallsThroughToLastResort", async () => {
  // Regression: the `best` branch of recommendTaskModelRoute used to
  // grab `best.provider_order[0]` unconditionally and return it, even
  // when that route was a hidden/paid provider (togetherai, xai,
  // cerebras, cloudflare-ai-gateway) or a route whose provider/route
  // health was actively penalized. The caller then tried to use an
  // invisible or dead route as the canonical "best" choice, guaranteeing
  // an immediate inference failure. This test pins the visible+healthy
  // walk: the best entry's primary route is togetherai (hidden), the
  // secondary is iflowcn with an unhealthy provider, and the tertiary
  // is opencode-go (visible + healthy). The chosen route must be the
  // tertiary — NOT togetherai, NOT iflowcn. A secondary entry's
  // visible+healthy route can also satisfy the contract as long as the
  // result is never the hidden or unhealthy route.
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "aicoder-model-routing-"));

  const providerHealthMap = new Map([
    [
      "iflowcn",
      {
        state: "quota" as const,
        until: Date.now() + 60_000,
        retryCount: 1,
      },
    ],
  ]);

  const decision = await recommendTaskModelRoute(
    tempDirectory,
    {
      // No agent metadata on disk → no preferred models.
      subagent_type: "implementation_lead",
      // Prompt="coding" so selectBestModelForRoleAndTask's substring
      // filter (`best_for.some(bf => bf.includes(lowerTask))`) actually
      // matches the `best_for: ["coding tasks"]` entry below and the
      // `best` branch truly runs (not the last-resort fallback).
      prompt: "coding",
    },
    [
      {
        id: "qwen3-coder-plus",
        enabled: true,
        description: "qwen3-coder-plus description",
        capability_tier: "strong",
        cost_tier: "free",
        billing_mode: "free",
        latency_tier: "standard",
        concurrency: 1,
        quota_visibility: "system-observed",
        best_for: ["coding tasks"],
        not_for: [],
        default_roles: ["implementation_worker"],
        provider_order: [
          // Hidden paid route — must be skipped.
          { provider: "togetherai", model: "togetherai/qwen3-coder-plus", priority: 1 },
          // Provider-level unhealthy — must be skipped.
          { provider: "iflowcn", model: "iflowcn/qwen3-coder-plus", priority: 2 },
          // Visible + healthy — this is the correct choice.
          { provider: "opencode-go", model: "opencode-go/qwen3-coder-plus", priority: 3 },
        ],
        notes: [],
      },
    ],
    providerHealthMap,
    new Map(),
    Date.now(),
  );

  assert.equal(decision.selectedModelRoute, "opencode-go/qwen3-coder-plus");
});

test("findCuratedFallbackRoute_whenNextRouteIsHiddenPaidProvider_skipsToVisibleRoute", () => {
  // Regression: buildProviderHealthSystemPrompt emits a "Curated fallbacks"
  // block that tells the agent which route to use when provider X is
  // backed-off. That block used to call findCuratedFallbackRoute with
  // only provider-level health and NO visibility filter, so it would
  // happily suggest `openrouter/xiaomi/mimo-v2-pro` (a paid, non-:free
  // openrouter route that filterVisibleProviderRoutes hides everywhere
  // else in the plugin). The agent would then try to use a route the
  // rest of the curation layer actively blocks.
  //
  // This mirrors the real config/models.jsonc shape for the mimo-v2-pro
  // entry at the time of writing: primary xiaomi-token-plan-ams, then
  // minimax, then the paid openrouter route, then opencode-go visible
  // fallback.
  const entry: ModelRegistryEntry = {
    id: "mimo-v2-pro",
    enabled: true,
    description: "mimo-v2-pro description",
    capability_tier: "frontier",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: ["long_context"],
    not_for: [],
    default_roles: ["long_context_reader"],
    provider_order: [
      { provider: "xiaomi-token-plan-ams", model: "xiaomi-token-plan-ams/mimo-v2-pro", priority: 1 },
      { provider: "minimax", model: "minimax/MiniMax-M2.7", priority: 2 },
      { provider: "openrouter", model: "openrouter/xiaomi/mimo-v2-pro", priority: 3 },
      { provider: "opencode-go", model: "opencode-go/mimo-v2-pro", priority: 4 },
    ],
    notes: [],
  };

  const now = Date.now();
  const providerHealthMap = new Map([
    [
      "xiaomi-token-plan-ams",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
    [
      "minimax",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);

  const fallback = findCuratedFallbackRoute(
    entry,
    "xiaomi-token-plan-ams",
    providerHealthMap,
    new Map(),
    now,
  );

  assert.equal(fallback, "opencode-go/mimo-v2-pro");
  // Pin the negative: the paid openrouter route must NEVER be surfaced
  // as a curated fallback — it's hidden everywhere else in the plugin.
  assert.notEqual(fallback, "openrouter/xiaomi/mimo-v2-pro");
});

test("findCuratedFallbackRoute_whenRouteIsMarkedUnhealthyAtRouteLevel_skipsIt", () => {
  // Regression: findCuratedFallbackRoute used to ignore modelRouteHealthMap
  // entirely. A route penalized at the route level (e.g. model_not_found
  // for a specific provider/model pair, while the provider as a whole is
  // still healthy for other models) would still be emitted as the curated
  // fallback — sending the agent back to a route we just proved dead.
  const entry: ModelRegistryEntry = {
    id: "example",
    enabled: true,
    description: "example",
    capability_tier: "strong",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: [],
    not_for: [],
    default_roles: ["implementation_worker"],
    provider_order: [
      { provider: "iflowcn", model: "iflowcn/some-model", priority: 1 },
      { provider: "opencode-go", model: "opencode-go/some-model-dead", priority: 2 },
      { provider: "opencode-go", model: "opencode-go/some-model-live", priority: 3 },
    ],
    notes: [],
  };

  const now = Date.now();
  const providerHealthMap = new Map([
    [
      "iflowcn",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  const modelRouteHealthMap = new Map([
    [
      "opencode-go/some-model-dead",
      { state: "model_not_found" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);

  const fallback = findCuratedFallbackRoute(
    entry,
    "iflowcn",
    providerHealthMap,
    modelRouteHealthMap,
    now,
  );

  assert.equal(fallback, "opencode-go/some-model-live");
});

test("expireHealthMaps_whenRouteEntryExpired_dropsRouteEntry", () => {
  // Regression: the `experimental.chat.system.transform` hook used to
  // expire only `providerHealthMap`, leaving stale `modelRouteHealthMap`
  // entries in place forever. They leak memory in long-running plugin
  // sessions AND persist across restarts via `persistProviderHealth`,
  // which rewrites providerHealth.json from these maps on every error
  // event. The fix extracted a shared `expireHealthMaps` helper that
  // walks BOTH maps.
  const now = Date.now();
  const providerHealthMap = new Map([
    [
      "iflowcn",
      { state: "quota" as const, until: now - 1, retryCount: 1 },
    ],
    [
      "ollama-cloud",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  const modelRouteHealthMap = new Map([
    [
      "opencode-go/dead-route",
      { state: "model_not_found" as const, until: now - 1, retryCount: 1 },
    ],
    [
      "opencode-go/live-route",
      { state: "timeout" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);

  expireHealthMaps(providerHealthMap, modelRouteHealthMap, now);

  // Provider expiration (preserved behavior).
  assert.equal(providerHealthMap.has("iflowcn"), false);
  assert.equal(providerHealthMap.has("ollama-cloud"), true);
  // Route expiration (the new fix).
  assert.equal(modelRouteHealthMap.has("opencode-go/dead-route"), false);
  assert.equal(modelRouteHealthMap.has("opencode-go/live-route"), true);
});

test("expireHealthMaps_whenKeyMissingEntryIsInfinite_neverExpires", () => {
  // `key_missing` entries use `until = Number.POSITIVE_INFINITY` to
  // stay active for the full process lifetime (credentials don't
  // appear mid-run). Pin that they are never dropped even far in
  // the future.
  const providerHealthMap = new Map([
    [
      "openrouter",
      {
        state: "key_missing" as const,
        until: Number.POSITIVE_INFINITY,
        retryCount: 0,
      },
    ],
  ]);

  expireHealthMaps(providerHealthMap, new Map(), Date.now() + 365 * 24 * 60 * 60 * 1000);

  assert.equal(providerHealthMap.has("openrouter"), true);
});

test("clearSessionHangState_whenSessionTerminates_dropsFromAllThreeSessionMaps", () => {
  // Regression: the session.error and assistant.message.completed
  // handlers used to only `sessionStartTimeMap.delete(sessionID)`.
  // `sessionActiveProviderMap` and `sessionActiveModelMap` were
  // populated on every `chat.params` call but NEVER cleared, leaking
  // one entry per session for the full lifetime of the plugin process.
  // Not a correctness bug (the hang-detector short-circuits on missing
  // start time) but a real unbounded memory growth bug in long-running
  // autopilot processes.
  const sessionStartTimeMap = new Map<string, number>([
    ["session-a", 1000],
    ["session-b", 2000],
  ]);
  const sessionActiveProviderMap = new Map<string, string>([
    ["session-a", "ollama-cloud"],
    ["session-b", "iflowcn"],
  ]);
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >([
    ["session-a", { id: "glm-4.7", providerID: "ollama-cloud" }],
    ["session-b", { id: "qwen3-coder-plus", providerID: "iflowcn" }],
  ]);

  clearSessionHangState(
    "session-a",
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  // session-a is fully gone from all three maps.
  assert.equal(sessionStartTimeMap.has("session-a"), false);
  assert.equal(sessionActiveProviderMap.has("session-a"), false);
  assert.equal(sessionActiveModelMap.has("session-a"), false);
  // session-b is untouched.
  assert.equal(sessionStartTimeMap.has("session-b"), true);
  assert.equal(sessionActiveProviderMap.has("session-b"), true);
  assert.equal(sessionActiveModelMap.has("session-b"), true);
});

// M118 pin A — isolated drift surface 1: `sessionStartTimeMap.delete`.
// Only the start-time map carries an entry for the terminating session;
// the other two maps are EMPTY. A sabotage that drops ONLY the
// `sessionActiveProviderMap.delete` or ONLY the `sessionActiveModelMap.delete`
// line cannot fire this pin because neither delete has anything to do
// on an empty map — `.delete(sessionID)` on an absent key is a no-op
// and `.has(sessionID)` still returns `false`. Only a sabotage that
// drops `sessionStartTimeMap.delete` leaves `has("session-a") === true`
// on the one populated map and fires this assertion uniquely.
test("clearSessionHangState_whenOnlyStartTimeMapHasEntry_dropsStartTimeSpecifically", () => {
  const sessionStartTimeMap = new Map<string, number>([["session-a", 1000]]);
  const sessionActiveProviderMap = new Map<string, string>();
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >();

  clearSessionHangState(
    "session-a",
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.equal(sessionStartTimeMap.has("session-a"), false);
});

// M118 pin B — isolated drift surface 2: `sessionActiveProviderMap.delete`.
// Only the provider map is populated. A sabotage that drops only the
// start-time delete or only the model delete cannot fire this pin
// (both other maps are empty → deletes are no-ops on absent keys).
// Only a sabotage that drops `sessionActiveProviderMap.delete` leaves
// `has("session-a") === true` on the populated map and fires this
// assertion uniquely.
test("clearSessionHangState_whenOnlyProviderMapHasEntry_dropsProviderSpecifically", () => {
  const sessionStartTimeMap = new Map<string, number>();
  const sessionActiveProviderMap = new Map<string, string>([
    ["session-a", "ollama-cloud"],
  ]);
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >();

  clearSessionHangState(
    "session-a",
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.equal(sessionActiveProviderMap.has("session-a"), false);
});

// M118 pin C — isolated drift surface 3: `sessionActiveModelMap.delete`.
// Only the model map is populated. Symmetric to pins A and B: only a
// sabotage that drops `sessionActiveModelMap.delete` leaves
// `has("session-a") === true` on the populated map and fires this
// assertion uniquely. Sabotages on either of the other two lines are
// no-ops because those maps are empty.
test("clearSessionHangState_whenOnlyModelMapHasEntry_dropsModelSpecifically", () => {
  const sessionStartTimeMap = new Map<string, number>();
  const sessionActiveProviderMap = new Map<string, string>();
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >([["session-a", { id: "glm-4.7", providerID: "ollama-cloud" }]]);

  clearSessionHangState(
    "session-a",
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.equal(sessionActiveModelMap.has("session-a"), false);
});

test("serializeHealthEntryForPersistence_whenUntilIsInfinity_emitsNeverString", () => {
  // M81 pin: `key_missing` entries store `until: Number.POSITIVE_INFINITY`
  // in memory, but `JSON.stringify(Infinity)` emits `null`, which
  // `parsePersistedHealthEntry` rejects as a missing field. The
  // serializer MUST convert infinity to the sentinel string `"never"`
  // so the on-disk form round-trips cleanly through the load path.
  // A sabotage that forgets the conversion fires this pin alone.
  const serialized = serializeHealthEntryForPersistence({
    state: "key_missing",
    until: Number.POSITIVE_INFINITY,
    retryCount: 0,
  });

  assert.equal(serialized.until, "never");
});

test("serializeHealthEntryForPersistence_whenUntilIsFinite_passesNumberThrough", () => {
  // M81 pin: finite `until` timestamps must serialize verbatim as
  // numbers — a sabotage that incorrectly stringifies all `until`
  // values (e.g. `String(until)` or a blanket `"never"`) fires this
  // pin alone. Isolated from the infinity-conversion pin so the two
  // failure modes partition cleanly.
  const serialized = serializeHealthEntryForPersistence({
    state: "quota",
    until: 1_700_000_000_000,
    retryCount: 3,
  });

  assert.equal(serialized.until, 1_700_000_000_000);
});

test("serializeHealthEntryForPersistence_whenCalled_preservesStateAndRetryCount", () => {
  // M81 pin: the spread must carry `state` and `retryCount` through
  // unchanged — a sabotage that switches from `{...health, until: ...}`
  // to explicit field listing and forgets one of the fields (or typos
  // one) fires this pin alone. Pins 1 and 2 test `until` only, so
  // this pin specifically covers the spread-preservation contract.
  const serialized = serializeHealthEntryForPersistence({
    state: "no_credit",
    until: 1_700_000_000_000,
    retryCount: 7,
  });

  assert.equal(serialized.state, "no_credit");
  assert.equal(serialized.retryCount, 7);
});

test("serializeHealthEntryForPersistence_whenCalled_returnsFreshObjectLeavingInputUntilUnmutated", () => {
  // M111 drift pin 1/3 — return value is a FRESH object, input is
  // NOT mutated. A regression to `Object.assign(health, {until: ...})`
  // or `health.until = "never"; return health;` would lobotomize the
  // in-memory handle: the `providerHealthMap` entry's `until` would
  // become the string `"never"`, and every downstream reader that
  // does `until > now` would silently evaluate to `false`, leaking
  // `key_missing` entries out of the health gate. The three M81 pins
  // only inspect the `serialized` return — they never re-read the
  // input — so this regression passes all three. This pin checks
  // both fresh-object identity AND input immutability.
  const inputHealth: ProviderHealth = {
    state: "key_missing",
    until: Number.POSITIVE_INFINITY,
    retryCount: 0,
  };
  const serialized = serializeHealthEntryForPersistence(inputHealth);
  assert.notEqual(serialized, inputHealth);
  assert.equal(inputHealth.until, Number.POSITIVE_INFINITY);
  assert.equal(serialized.until, "never");
});

test("serializeHealthEntryForPersistence_whenInputHasUnknownForwardCompatField_carriesItThroughTheSpread", () => {
  // M111 drift pin 2/3 — forward-compat: the `{...health, until: ...}`
  // spread form is load-bearing because it auto-propagates future
  // schema additions (say, a `lastError` string or a `firstObserved`
  // timestamp) into the persisted form without touching this
  // function. A regression to explicit field listing
  // (`return {state, until, retryCount: ...}`) would silently drop
  // the new field. M81 pin #3 only asserts `state` and `retryCount`
  // and would pass that regression. This pin uses `as unknown as` to
  // inject a non-schema field; the test is about the runtime spread,
  // not TypeScript's static view of the shape.
  const inputWithExtra = {
    state: "quota" as const,
    until: 1_700_000_000_000,
    retryCount: 4,
    futureField: "forward-compat-breadcrumb",
  } as unknown as ProviderHealth;
  const serialized = serializeHealthEntryForPersistence(inputWithExtra);
  assert.equal(
    (serialized as unknown as { futureField: string }).futureField,
    "forward-compat-breadcrumb",
  );
});

test("serializeHealthEntryForPersistence_whenUntilIsNaN_passesThroughAsNaNNotNeverSentinel", () => {
  // M111 drift pin 3/3 — strict `=== Number.POSITIVE_INFINITY` check.
  // A "defensive generalization" to `!Number.isFinite(until)` would
  // fold NaN AND `-Infinity` AND `+Infinity` into `"never"`, silently
  // corrupting the load path: NaN / -Infinity are invalid in-memory
  // states and MUST remain observable so `parsePersistedHealthEntry`'s
  // finite check rejects them on reload, not silently re-hydrates
  // them as `key_missing`-equivalent permanent penalties. M81 pin #1
  // uses exactly `Number.POSITIVE_INFINITY` and passes under both the
  // strict and the generalized forms. This pin discriminates.
  const serialized = serializeHealthEntryForPersistence({
    state: "quota",
    until: Number.NaN,
    retryCount: 0,
  });
  assert.notEqual(serialized.until, "never");
  assert.equal(Number.isNaN(serialized.until), true);
});

test("assembleHealthAwareSystemPrompts_whenBothPromptsPresent_returnsProviderFirst", () => {
  // M87 pin: both builders returned non-null strings. The helper
  // must return a length-2 array with provider-health FIRST and
  // available-models SECOND — the canonical transform-hook order.
  // A sabotage that reverses the order (or rebuilds the array
  // differently) fires this pin alone — pins 2 and 3 each have
  // only one non-null input, so their arrays are length-1 and
  // insensitive to order.
  const result = assembleHealthAwareSystemPrompts(
    "PROVIDER_HEALTH_BODY",
    "AVAILABLE_MODELS_BODY",
  );
  assert.deepEqual(result, ["PROVIDER_HEALTH_BODY", "AVAILABLE_MODELS_BODY"]);
});

test("assembleHealthAwareSystemPrompts_whenProviderHealthIsNull_returnsAvailableOnly", () => {
  // M87 pin: provider-health builder returned null. The helper
  // must drop it and return a length-1 array with only the
  // available-models body. A sabotage that drops the null filter
  // on the provider-health input fires this pin alone — pin 1
  // has both non-null so the filter is a no-op, and pin 3 is
  // broken on the other axis.
  const result = assembleHealthAwareSystemPrompts(null, "AVAILABLE_MODELS_BODY");
  assert.deepEqual(result, ["AVAILABLE_MODELS_BODY"]);
});

test("assembleHealthAwareSystemPrompts_whenAvailableModelsIsNull_returnsProviderOnly", () => {
  // M87 pin: available-models builder returned null. The helper
  // must drop it and return a length-1 array with only the
  // provider-health body. A sabotage that drops the null filter
  // on the available-models input fires this pin alone — pin 1
  // has both non-null and pin 2 is broken on the other axis.
  const result = assembleHealthAwareSystemPrompts("PROVIDER_HEALTH_BODY", null);
  assert.deepEqual(result, ["PROVIDER_HEALTH_BODY"]);
});

test("shouldRecordImmediateTimeoutPenalty_whenAllConditionsHold_returnsTrue", () => {
  // M86 pin: below-threshold timeout + provider + model → take the
  // synchronous immediate-penalty branch. A sabotage that hardcodes
  // the timeout comparison (e.g. `return 2000 < THRESHOLD && ...`)
  // fires this pin alone — pins 2 and 3 already expect false.
  assert.equal(
    shouldRecordImmediateTimeoutPenalty(
      HANG_TIMEOUT_IMMEDIATE_THRESHOLD_MS - 500,
      true,
      true,
    ),
    true,
  );
});

test("shouldRecordImmediateTimeoutPenalty_whenProviderIDIsMissing_returnsFalse", () => {
  // M86 pin: below-threshold timeout but missing providerID must
  // return false. A sabotage that drops the `&& hasProviderID`
  // conjunct fires this pin alone — pin 1 still has a providerID
  // and pin 3 is broken on the model axis, so both continue to
  // behave correctly under this sabotage.
  assert.equal(
    shouldRecordImmediateTimeoutPenalty(
      HANG_TIMEOUT_IMMEDIATE_THRESHOLD_MS - 500,
      false,
      true,
    ),
    false,
  );
});

test("shouldRecordImmediateTimeoutPenalty_whenModelIsMissing_returnsFalse", () => {
  // M86 pin: below-threshold timeout but missing model must return
  // false. A sabotage that drops the `&& hasModel` conjunct fires
  // this pin alone — pin 1 still has a model and pin 2 is broken
  // on the providerID axis.
  assert.equal(
    shouldRecordImmediateTimeoutPenalty(
      HANG_TIMEOUT_IMMEDIATE_THRESHOLD_MS - 500,
      true,
      false,
    ),
    false,
  );
});

test("extractAssistantMessageCompletedPayload_whenShapeIsValid_returnsNarrowedTuple", () => {
  // M85 pin: a well-formed `assistant.message.completed` event with
  // `properties.sessionID` and `properties.tokens` must return the
  // narrowed `{sessionID, tokens}` tuple. Any sabotage that short-
  // circuits the helper to `return undefined` fires this pin alone —
  // pins 2 and 3 already expect `undefined` for their broken inputs.
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  const result = extractAssistantMessageCompletedPayload({
    type: "assistant.message.completed",
    properties: { sessionID: "sess-1", tokens },
  });
  assert.deepEqual(result, { sessionID: "sess-1", tokens });
});

test("extractAssistantMessageCompletedPayload_whenSessionIDIsMissing_returnsUndefined", () => {
  // M85 pin: a payload with `tokens` but no `sessionID` must return
  // `undefined`. A sabotage that drops the `sessionID` string check
  // fires this pin alone — pin 1 still has a valid sessionID; pin 3
  // is broken at the `tokens` step so the sessionID check is moot.
  const result = extractAssistantMessageCompletedPayload({
    type: "assistant.message.completed",
    properties: { tokens: { input: 0, output: 0 } },
  });
  assert.equal(result, undefined);
});

test("extractAssistantMessageCompletedPayload_whenTokensIsMissing_returnsUndefined", () => {
  // M85 pin: a payload with `sessionID` but no `tokens` must return
  // `undefined`. A sabotage that drops the `tokens` object check
  // fires this pin alone — pin 1 still has valid tokens; pin 2 is
  // broken at the `sessionID` step so the tokens check is moot.
  const result = extractAssistantMessageCompletedPayload({
    type: "assistant.message.completed",
    properties: { sessionID: "sess-1" },
  });
  assert.equal(result, undefined);
});

test("extractAssistantMessageCompletedPayload_whenTypeTagIsWrong_returnsUndefined", () => {
  // M105 drift pin: the `type` field check is load-bearing, not
  // redundant. A sabotage that drops the check would leak off-type
  // events (keepalive frames, lifecycle events that share the
  // properties shape) into `isZeroTokenQuotaSignal` and silently
  // fire false quota penalties. The M85 pins all use the correct
  // type tag so none of them exercise this path.
  const result = extractAssistantMessageCompletedPayload({
    type: "session.keepalive",
    properties: { sessionID: "sess-1", tokens: { input: 0, output: 0 } },
  });
  assert.equal(result, undefined);
});

test("extractAssistantMessageCompletedPayload_whenSessionIDIsEmptyString_returnsUndefined", () => {
  // M105 drift pin: empty-string sessionID is rejected even though
  // `typeof "" === "string"`. The `.length === 0` clause is the only
  // guard preventing empty keys from reaching
  // `readAndClearSessionHangState`'s Map<string, ...> lookups, where
  // an empty string would silently collide across every session map.
  // The M85 "missing sessionID" pin passes `undefined` and never
  // reaches the length clause.
  const result = extractAssistantMessageCompletedPayload({
    type: "assistant.message.completed",
    properties: { sessionID: "", tokens: { input: 0, output: 0 } },
  });
  assert.equal(result, undefined);
});

test("extractAssistantMessageCompletedPayload_whenShapeIsValid_returnsTokensByStrictReferenceNotCopy", () => {
  // M105 drift pin: the returned `tokens` must be the exact input
  // object by reference. Downstream consumers (notably
  // `isZeroTokenQuotaSignal`) walk nested values, and a future
  // defensive `{ ...tokens }` wrap would break reference-stability
  // callers rely on for diffing/caching. The M85 deepEqual pin
  // cannot distinguish identity from structural equality.
  const tokens = { input: 0, output: 0, cache: { read: 0, write: 0 } };
  const result = extractAssistantMessageCompletedPayload({
    type: "assistant.message.completed",
    properties: { sessionID: "sess-1", tokens },
  });
  assert.ok(result, "result must be defined for a well-formed payload");
  assert.strictEqual(
    result.tokens,
    tokens,
    "tokens must be returned by strict reference, not as a defensive copy",
  );
});

test("extractSessionErrorApiErrorContext_whenShapeIsValid_returnsNarrowedTuple", () => {
  // M88 pin: a well-formed `session.error` envelope with APIError,
  // sessionID, statusCode, and a mixed-case message must return the
  // narrowed `{sessionID, statusCode, lowerMessage}` tuple with the
  // message already case-folded. A sabotage that short-circuits the
  // helper to `return undefined` fires this pin alone.
  const result = extractSessionErrorApiErrorContext({
    sessionID: "sess-1",
    error: {
      name: "APIError",
      data: { statusCode: 429, message: "Rate Limit EXCEEDED" },
    },
  });
  assert.deepEqual(result, {
    sessionID: "sess-1",
    statusCode: 429,
    lowerMessage: "rate limit exceeded",
  });
});

test("extractSessionErrorApiErrorContext_whenErrorNameIsWrong_returnsUndefined", () => {
  // M88 pin: a payload whose `error.name` is not "APIError" must
  // return `undefined` — downstream classifiers assume the APIError
  // `data.statusCode`/`data.message` shape and will silently
  // misclassify other error types. A sabotage that drops the
  // `error.name !== "APIError"` check fires this pin alone — pin 1
  // still has name "APIError" and pin 3 is broken on sessionID.
  const result = extractSessionErrorApiErrorContext({
    sessionID: "sess-1",
    error: {
      name: "NotFoundError",
      data: { statusCode: 404, message: "not found" },
    },
  });
  assert.equal(result, undefined);
});

test("extractSessionErrorApiErrorContext_whenSessionIDIsMissing_returnsUndefined", () => {
  // M88 pin: an APIError payload missing `sessionID` must return
  // `undefined` — the classification handler needs sessionID to
  // key the route-health maps. A sabotage that drops the
  // sessionID string check fires this pin alone — pin 1 still has
  // a sessionID and pin 2 is broken on the error name.
  const result = extractSessionErrorApiErrorContext({
    error: {
      name: "APIError",
      data: { statusCode: 429, message: "rate limit" },
    },
  });
  assert.equal(result, undefined);
});

test("extractSessionErrorApiErrorContext_whenSessionIDIsEmptyString_returnsUndefined", () => {
  // M113 pin: an APIError envelope whose `sessionID` is present but an
  // empty string must be rejected. The pre-existing
  // `_whenSessionIDIsMissing` pin omits the field entirely and fails
  // at the `typeof !== "string"` limb without ever reaching the
  // `.length === 0` limb. A sabotage that drops the length clause
  // — reading it as defensive overkill — would emit a context with
  // `sessionID: ""`, which collapses every downstream per-session
  // route-health `Map.set` into a single shared bucket.
  const result = extractSessionErrorApiErrorContext({
    sessionID: "",
    error: {
      name: "APIError",
      data: { statusCode: 429, message: "rate limit" },
    },
  });
  assert.equal(result, undefined);
});

test("extractSessionErrorApiErrorContext_whenStatusCodeIsNaN_defaultsToZero", () => {
  // M113 pin: a raw statusCode of `NaN` must not leak through — the
  // `Number.isFinite` guard must collapse it to the `0` default. A
  // refactor that simplifies the guard to `typeof === "number" ? : 0`
  // would let NaN through, which then cascades into the numeric
  // dispatch table downstream where `NaN === 429` is false for every
  // branch. The pre-existing pins all pass finite integers, so this
  // invariant is otherwise unpinned.
  const result = extractSessionErrorApiErrorContext({
    sessionID: "sess-1",
    error: {
      name: "APIError",
      data: { statusCode: Number.NaN, message: "rate limit" },
    },
  });
  assert.deepEqual(result, {
    sessionID: "sess-1",
    statusCode: 0,
    lowerMessage: "rate limit",
  });
});

test("extractSessionErrorApiErrorContext_whenDataIsMissing_returnsZeroStatusAndEmptyMessage", () => {
  // M113 pin: an APIError envelope without a `.data` property must
  // not throw — the `dataObj` fallback must resolve to `{}` so
  // statusCode defaults to `0` and lowerMessage defaults to `""`.
  // A refactor that assumes `.data` is always present (e.g.
  // `const dataObj = errorObj.data as Record<string, unknown>`)
  // would crash on `dataObj.statusCode` when opencode emits an
  // auth-failure or connection-error APIError with no `.data`
  // envelope. Pre-existing pins all ship a populated `.data`.
  const result = extractSessionErrorApiErrorContext({
    sessionID: "sess-1",
    error: {
      name: "APIError",
    },
  });
  assert.deepEqual(result, {
    sessionID: "sess-1",
    statusCode: 0,
    lowerMessage: "",
  });
});

test("extractSessionErrorExplicitModel_whenShapeIsValid_returnsNarrowedTuple", () => {
  // M84 pin: a well-formed `{model: {id, providerID}}` payload must
  // return the narrowed `{id, providerID}` tuple verbatim. A sabotage
  // that hardcodes `return undefined` fires this pin alone — pins 2
  // and 3 already expect `undefined` for their malformed inputs.
  const result = extractSessionErrorExplicitModel({
    sessionID: "sess-1",
    error: { name: "APIError" },
    model: { id: "claude-3.5-sonnet", providerID: "openrouter" },
  });

  assert.deepEqual(result, { id: "claude-3.5-sonnet", providerID: "openrouter" });
});

test("extractSessionErrorExplicitModel_whenModelIsMissingId_returnsUndefined", () => {
  // M84 pin: a candidate model with `providerID` but no `id` must be
  // rejected. A sabotage that drops the `typeof candidateObj.id !==
  // "string"` check fires this pin alone — pin 1's input has both
  // fields, and pin 3's input lacks `providerID` so a missing-id
  // sabotage still returns `undefined` via the providerID check.
  const result = extractSessionErrorExplicitModel({
    model: { providerID: "openrouter" },
  });

  assert.equal(result, undefined);
});

test("extractSessionErrorExplicitModel_whenModelIsMissingProviderID_returnsUndefined", () => {
  // M84 pin: a candidate model with `id` but no `providerID` must be
  // rejected. A sabotage that drops the `typeof candidateObj.providerID
  // !== "string"` check fires this pin alone — pin 1's input has
  // both fields, and pin 2's input lacks `id` so a missing-providerID
  // sabotage still returns `undefined` via the id check.
  const result = extractSessionErrorExplicitModel({
    model: { id: "claude-3.5-sonnet" },
  });

  assert.equal(result, undefined);
});

test("extractSessionErrorExplicitModel_whenSessionErrorIsNull_returnsUndefinedWithoutThrowing", () => {
  // M112 drift pin 1/3 — outer-object null-guard. `typeof null ===
  // "object"` in JavaScript, so without the explicit
  // `sessionError === null` disjunction the very next line's
  // `(sessionError as Record<string, unknown>).model` would throw
  // `TypeError: Cannot read properties of null`. Opencode emits
  // `session.error` with `properties: null` in older versions when
  // the error shape is not fully populated. A "simplification"
  // refactor that drops the null disjunction as "redundant with
  // typeof" passes every M84 pin (their inputs are real objects)
  // but crashes on pre-populated error events. Pin: null input
  // returns undefined, no throw.
  const result = extractSessionErrorExplicitModel(null);
  assert.equal(result, undefined);
});

test("extractSessionErrorExplicitModel_whenDotModelIsNull_returnsUndefinedWithoutThrowing", () => {
  // M112 drift pin 2/3 — inner `.model` null-guard. Same foot-gun
  // at the inner layer: `sessionError.model = null` is a real shape
  // opencode emits for pre-bind failures (no model attached yet).
  // Without the `candidate === null` disjunction, the next line's
  // `(candidate as Record<string, unknown>).id` throws. A defensive-
  // simplification refactor passes every M84 pin (which use either
  // a missing `.model` key or a populated object) but crashes on
  // pre-bind session.error events. Pin: `{model: null}` returns
  // undefined, no throw.
  const result = extractSessionErrorExplicitModel({
    sessionID: "sess-1",
    error: { name: "APIError" },
    model: null,
  });
  assert.equal(result, undefined);
});

test("extractSessionErrorExplicitModel_whenInputModelCarriesExtraFields_returnsStrictTwoKeyTuple", () => {
  // M112 drift pin 3/3 — strict-narrow contract: extra fields on
  // `candidate.model` must be DROPPED, not forwarded. The current
  // `return { id: ..., providerID: ... }` explicitly lists the
  // two fields. A "simpler" refactor to `return candidateObj as ...`
  // or `return { ...candidateObj }` would leak any extras the
  // opencode event carries (version breadcrumbs, debug tags,
  // telemetry markers) into the downstream classification path.
  // This is the forward-compat INVERSE of M111's serializer
  // surface: at narrowing gates, shape must be SHED (strict),
  // not PRESERVED (wide). M84 pins use inputs with no extras so
  // shape-leak is invisible. Pin: assert the result has exactly
  // two keys — no leak.
  const result = extractSessionErrorExplicitModel({
    sessionID: "sess-1",
    error: { name: "APIError" },
    model: {
      id: "claude-3.5-sonnet",
      providerID: "openrouter",
      internalDebugTag: "leak-canary",
      telemetrySpanId: "trace-xyz",
    },
  });
  assert.deepEqual(result, {
    id: "claude-3.5-sonnet",
    providerID: "openrouter",
  });
  // Explicit key-set assertion so a `{...candidateObj}` leak is
  // caught even if deepEqual is ever weakened.
  assert.deepEqual(Object.keys(result ?? {}).sort(), ["id", "providerID"]);
});

test("classifyPersistedHealthKey_whenKeyHasNoSlash_returnsProvider", () => {
  // M83 pin: raw provider IDs (no slash) must classify as "provider".
  // A sabotage that hardcodes `"route"` for every key fires this pin
  // alone — pins 2 and 3 still see their expected `"route"` value.
  assert.equal(classifyPersistedHealthKey("iflowcn"), "provider");
  assert.equal(classifyPersistedHealthKey("ollama-cloud"), "provider");
});

test("classifyPersistedHealthKey_whenKeyHasExactlyOneSlash_returnsRoute", () => {
  // M83 pin: standard 2-segment composite keys (one slash) must
  // classify as "route". Paired with pin 3 to catch a sabotage that
  // tightens the predicate to `split("/").length > 2` — that sabotage
  // would misclassify exactly-one-slash keys as "provider", firing
  // this pin alone while pin 3 still passes.
  assert.equal(
    classifyPersistedHealthKey("iflowcn/qwen3-coder-plus"),
    "route",
  );
  assert.equal(
    classifyPersistedHealthKey("ollama-cloud/glm-5"),
    "route",
  );
});

test("classifyPersistedHealthKey_whenKeyHasMultipleSlashes_returnsRoute", () => {
  // M83 pin: multi-segment composite keys (two or more slashes, which
  // `composeRouteKey` produces when the opencode runtime model id
  // already contains a `/` — e.g. openrouter aggregator routes) must
  // still classify as "route". Paired with pin 2 to catch the
  // inverse sabotage: `split("/").length === 2` would misclassify
  // multi-segment keys as "provider", firing this pin alone while
  // pin 2 still passes. Round-trips through `composeRouteKey` to pin
  // the convention lock-step: if `composeRouteKey` ever changes its
  // delimiter, the round-trip here breaks before the read-side
  // classifier can silently diverge in production.
  assert.equal(
    classifyPersistedHealthKey("openrouter/anthropic/claude-3.5-sonnet"),
    "route",
  );
  assert.equal(
    classifyPersistedHealthKey(
      composeRouteKey({ provider: "openrouter", model: "meta/llama-3-70b" }),
    ),
    "route",
  );
});

test("loadRegistryAndLookupEntryForInputModel_whenEntryMatches_returnsRegistryAndEntry", async () => {
  // M82 pin: when the injected loader resolves with a registry that
  // contains a matching entry, the helper returns BOTH the registry
  // object (unchanged, same reference) AND the looked-up entry. A
  // sabotage that hardcodes `entry: undefined` fires this pin alone —
  // the misses in pins 2 and 3 still produce `undefined` naturally.
  const matchingEntry = buildModelRegistryEntry(
    "test-model",
    ["build"],
    "fast",
    [{ provider: "ollama-cloud", model: "ollama-cloud/test-model", priority: 1 }],
  );
  const fakeRegistry = {
    version: 1,
    defaults: { fields: [] },
    models: [matchingEntry],
  };

  const result = await loadRegistryAndLookupEntryForInputModel(
    "/fake/root",
    { id: "test-model", providerID: "ollama-cloud" },
    async () => fakeRegistry,
  );

  assert.strictEqual(result.registry, fakeRegistry);
  assert.strictEqual(result.entry, matchingEntry);
});

test("loadRegistryAndLookupEntryForInputModel_whenProviderIdMismatches_returnsUndefinedEntry", async () => {
  // M82 pin: if the helper's narrowing silently drops `providerID` and
  // lookups collapse to id-only, a runtime model whose id matches a
  // registry row but whose provider differs would false-positive match.
  // This pin passes a registry entry whose id equals the input id but
  // whose provider differs; the correct helper returns `undefined`
  // because `findRegistryEntryByModel` normalises both sides via
  // `composeRouteKey`. A sabotage that passes `{ id: inputModel.id }`
  // (dropping providerID) fires this pin alone — pin 1 still passes
  // because its registry entry matches on both fields, and pin 3 still
  // produces undefined for its own reason.
  const wrongProviderEntry = buildModelRegistryEntry(
    "shared-id",
    ["build"],
    "fast",
    [{ provider: "ollama-cloud", model: "ollama-cloud/shared-id", priority: 1 }],
  );
  const fakeRegistry = {
    version: 1,
    defaults: { fields: [] },
    models: [wrongProviderEntry],
  };

  const result = await loadRegistryAndLookupEntryForInputModel(
    "/fake/root",
    { id: "shared-id", providerID: "openrouter" },
    async () => fakeRegistry,
  );

  assert.strictEqual(result.registry, fakeRegistry);
  assert.strictEqual(result.entry, undefined);
});

test("loadRegistryAndLookupEntryForInputModel_whenLoaderCalled_forwardsControlPlaneRootVerbatim", async () => {
  // M82 pin: the `controlPlaneRootDirectory` argument MUST be forwarded
  // to the loader unchanged. A sabotage that hardcodes the path (e.g.
  // `loadFn("")` or `loadFn(".")`) fires this pin alone — pins 1 and
  // 2 do not inspect the captured root argument because their
  // injected loaders ignore it.
  let capturedRoot: string | null = null;
  const fakeRegistry = {
    version: 1,
    defaults: { fields: [] },
    models: [] as ModelRegistryEntry[],
  };

  await loadRegistryAndLookupEntryForInputModel(
    "/very/specific/root/path",
    { id: "anything", providerID: "anything" },
    async (root) => {
      capturedRoot = root;
      return fakeRegistry;
    },
  );

  assert.equal(capturedRoot, "/very/specific/root/path");
});

test("logPluginHookFailure_whenCalled_forwardsMessageContainingHookName", () => {
  // M80 pin: the logged message MUST include the hook name verbatim
  // so operators can grep "chat.params hook failed" without knowing
  // the plugin's message template. A sabotage that drops the
  // `${hookName}` interpolation fires this pin alone.
  const captured: { message: string; error: unknown }[] = [];
  const logFn = (message: string, error: unknown) => {
    captured.push({ message, error });
  };

  logPluginHookFailure("chat.params", new Error("boom"), logFn);

  assert.equal(captured.length, 1);
  const first = captured[0];
  assert.ok(first);
  assert.match(first.message, /chat\.params/);
});

test("logPluginHookFailure_whenCalled_forwardsErrorReferenceVerbatim", () => {
  // M80 pin: the error must pass through unmodified so stack traces
  // and custom properties survive the swallow. A sabotage that wraps
  // the error (e.g. `String(error)` or `new Error(error.message)`)
  // fires this pin alone — reference equality fails before message
  // matching has a chance.
  const captured: { message: string; error: unknown }[] = [];
  const logFn = (message: string, error: unknown) => {
    captured.push({ message, error });
  };
  const boom = new Error("boom");

  logPluginHookFailure("experimental.chat.system.transform", boom, logFn);

  assert.equal(captured.length, 1);
  const first = captured[0];
  assert.ok(first);
  assert.strictEqual(first.error, boom);
});

test("logPluginHookFailure_whenCalled_invokesLogFnExactlyOnce", () => {
  // M80 pin: exactly one log line per failure. A sabotage that
  // double-logs (e.g. logs the hook name and the error on separate
  // calls) fires this pin alone — the other two pins pass because
  // the first call still has the right message and error shape.
  let callCount = 0;
  const logFn = (_message: string, _error: unknown) => {
    callCount += 1;
  };

  logPluginHookFailure("chat.params", new Error("boom"), logFn);

  assert.equal(callCount, 1);
});

test("bindSessionHangState_whenCalled_populatesAllThreeMapsAtomically", () => {
  // M79 symmetry pin: the three-map write triplet must stay in sync.
  // Dropping any one write silently desynchronises the hang detector —
  // this pin catches a missing provider, model, OR start-time write
  // by asserting all three maps contain the expected entry afterward.
  const sessionStartTimeMap = new Map<string, number>();
  const sessionActiveProviderMap = new Map<string, string>();
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >();

  bindSessionHangState(
    "s1",
    "iflowcn",
    { id: "qwen3-coder-plus", providerID: "iflowcn" },
    5000,
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.equal(sessionStartTimeMap.get("s1"), 5000);
  assert.equal(sessionActiveProviderMap.get("s1"), "iflowcn");
  assert.deepEqual(sessionActiveModelMap.get("s1"), {
    id: "qwen3-coder-plus",
    providerID: "iflowcn",
  });
});

test("bindSessionHangState_whenReBoundForSameSession_overwritesEveryMap", () => {
  // M79 second pin: re-binding the same session (e.g. a turn restart
  // through chat.params) must overwrite every entry in all three maps,
  // not skip fields that are already set. Catches a "write only if
  // absent" drift where one of the three writes grows a `.has()` guard.
  const sessionStartTimeMap = new Map<string, number>([["s1", 1000]]);
  const sessionActiveProviderMap = new Map<string, string>([["s1", "openrouter"]]);
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >([["s1", { id: "old-model", providerID: "openrouter" }]]);

  bindSessionHangState(
    "s1",
    "ollama-cloud",
    { id: "glm-4.7", providerID: "ollama-cloud" },
    9000,
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.equal(sessionStartTimeMap.get("s1"), 9000);
  assert.equal(sessionActiveProviderMap.get("s1"), "ollama-cloud");
  assert.deepEqual(sessionActiveModelMap.get("s1"), {
    id: "glm-4.7",
    providerID: "ollama-cloud",
  });
});

test("bindSessionHangState_whenCalledForSecondSession_leavesFirstSessionIntact", () => {
  // M79 third pin: session isolation. Binding session B must not
  // touch session A's entries in any of the three maps. Symmetric
  // to the `clearSessionHangState_*` isolation pin so the write-side
  // and read-side helpers both pin the same invariant.
  const sessionStartTimeMap = new Map<string, number>([["s1", 1000]]);
  const sessionActiveProviderMap = new Map<string, string>([["s1", "iflowcn"]]);
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >([["s1", { id: "qwen3-coder-plus", providerID: "iflowcn" }]]);

  bindSessionHangState(
    "s2",
    "ollama-cloud",
    { id: "glm-4.7", providerID: "ollama-cloud" },
    2000,
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  // s1 fully intact.
  assert.equal(sessionStartTimeMap.get("s1"), 1000);
  assert.equal(sessionActiveProviderMap.get("s1"), "iflowcn");
  assert.deepEqual(sessionActiveModelMap.get("s1"), {
    id: "qwen3-coder-plus",
    providerID: "iflowcn",
  });
  // s2 is fully bound.
  assert.equal(sessionStartTimeMap.get("s2"), 2000);
  assert.equal(sessionActiveProviderMap.get("s2"), "ollama-cloud");
});

// M120 pin A — isolated drift surface 1: `sessionActiveProviderMap.set`.
// Asserts ONLY the provider-map binding post-call, so a sabotage that
// drops only the model-map write (pin B) or only the start-time write
// (pin C) leaves the provider map intact and this pin still passes.
// Only a sabotage that drops `sessionActiveProviderMap.set` leaves the
// provider map empty and fires this assertion uniquely.
test("bindSessionHangState_whenCalled_writesProviderBindingSpecifically", () => {
  const sessionStartTimeMap = new Map<string, number>();
  const sessionActiveProviderMap = new Map<string, string>();
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >();

  bindSessionHangState(
    "s1",
    "iflowcn",
    { id: "qwen3-coder-plus", providerID: "iflowcn" },
    5000,
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.equal(sessionActiveProviderMap.get("s1"), "iflowcn");
});

// M120 pin B — isolated drift surface 2: `sessionActiveModelMap.set`.
// Asserts ONLY the model-map binding post-call. Symmetric to pin A:
// only a sabotage that drops `sessionActiveModelMap.set` leaves the
// model map empty and fires this assertion uniquely.
test("bindSessionHangState_whenCalled_writesModelTupleBindingSpecifically", () => {
  const sessionStartTimeMap = new Map<string, number>();
  const sessionActiveProviderMap = new Map<string, string>();
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >();

  bindSessionHangState(
    "s1",
    "iflowcn",
    { id: "qwen3-coder-plus", providerID: "iflowcn" },
    5000,
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.deepEqual(sessionActiveModelMap.get("s1"), {
    id: "qwen3-coder-plus",
    providerID: "iflowcn",
  });
});

// M120 pin C — isolated drift surface 3: `sessionStartTimeMap.set`.
// Asserts ONLY the start-time anchor post-call. Only a sabotage that
// drops `sessionStartTimeMap.set` leaves the start-time map empty
// and fires this assertion uniquely.
test("bindSessionHangState_whenCalled_writesStartTimeAnchorSpecifically", () => {
  const sessionStartTimeMap = new Map<string, number>();
  const sessionActiveProviderMap = new Map<string, string>();
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >();

  bindSessionHangState(
    "s1",
    "iflowcn",
    { id: "qwen3-coder-plus", providerID: "iflowcn" },
    5000,
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.equal(sessionStartTimeMap.get("s1"), 5000);
});

test("readAndClearSessionHangState_whenFullyBound_returnsTupleAndClearsMaps", () => {
  // M78 pin: the helper MUST read providerID/model BEFORE clearing the
  // maps. If a future edit swaps the order the returned tuple would be
  // `{undefined, undefined}` and every classification branch in the two
  // event hooks would silently early-return — no health penalty, no
  // test failure, no runtime error. This pin fires on that regression.
  const sessionStartTimeMap = new Map<string, number>([["s1", 1000]]);
  const sessionActiveProviderMap = new Map<string, string>([["s1", "iflowcn"]]);
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >([["s1", { id: "qwen3-coder-plus", providerID: "iflowcn" }]]);

  const result = readAndClearSessionHangState(
    "s1",
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.equal(result.providerID, "iflowcn");
  assert.deepEqual(result.model, { id: "qwen3-coder-plus", providerID: "iflowcn" });
  // Ordering invariant: maps cleared AFTER the read.
  assert.equal(sessionStartTimeMap.has("s1"), false);
  assert.equal(sessionActiveProviderMap.has("s1"), false);
  assert.equal(sessionActiveModelMap.has("s1"), false);
});

test("readAndClearSessionHangState_whenModelMapMissing_returnsProviderButUndefinedModel", () => {
  // M78 asymmetric split: session bound in the provider map but not yet
  // in the model map (can happen if chat.params short-circuited after
  // writing providerID but before writing the model tuple). The helper
  // must still report the provider AND still clear every map.
  const sessionStartTimeMap = new Map<string, number>([["s2", 2000]]);
  const sessionActiveProviderMap = new Map<string, string>([["s2", "openrouter"]]);
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >();

  const result = readAndClearSessionHangState(
    "s2",
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.equal(result.providerID, "openrouter");
  assert.equal(result.model, undefined);
  assert.equal(sessionStartTimeMap.has("s2"), false);
  assert.equal(sessionActiveProviderMap.has("s2"), false);
});

test("readAndClearSessionHangState_whenUnknownSession_returnsUndefinedTupleWithoutThrowing", () => {
  // M78 third pin: unknown session id (silent death, double-fire,
  // or an event for a session that was never bound). The helper must
  // be total — returning `{undefined, undefined}` is a valid signal
  // that the caller should early-return with no penalty. Does not
  // throw, does not leak per-call state.
  const sessionStartTimeMap = new Map<string, number>([["other", 9999]]);
  const sessionActiveProviderMap = new Map<string, string>([["other", "deepseek"]]);
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >([["other", { id: "ds-chat", providerID: "deepseek" }]]);

  const result = readAndClearSessionHangState(
    "ghost",
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.equal(result.providerID, undefined);
  assert.equal(result.model, undefined);
  // Unrelated session untouched.
  assert.equal(sessionStartTimeMap.has("other"), true);
  assert.equal(sessionActiveProviderMap.has("other"), true);
  assert.equal(sessionActiveModelMap.has("other"), true);
});

test("readAndClearSessionHangState_whenOnlyProviderMapPopulated_returnsProviderAfterRead", () => {
  // M121 asymmetric pin A: isolates the
  // `sessionActiveProviderMap.get(sessionID)` read. Only the provider
  // map is populated — if the read is dropped OR reordered after the
  // delegated clear, `result.providerID` collapses to `undefined` and
  // this pin fires alone among the three new M121 pins. Pre-existing
  // M78 pins fire as additive coverage but do not localise the surface.
  const sessionStartTimeMap = new Map<string, number>();
  const sessionActiveProviderMap = new Map<string, string>([["s1", "iflowcn"]]);
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >();

  const result = readAndClearSessionHangState(
    "s1",
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.equal(result.providerID, "iflowcn");
});

test("readAndClearSessionHangState_whenOnlyModelMapPopulated_returnsModelAfterRead", () => {
  // M121 asymmetric pin B: isolates the
  // `sessionActiveModelMap.get(sessionID)` read. Only the model map is
  // populated — if the read is dropped OR reordered after the clear,
  // `result.model` collapses to `undefined` and this pin fires alone.
  const sessionStartTimeMap = new Map<string, number>();
  const sessionActiveProviderMap = new Map<string, string>();
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >([["s1", { id: "qwen3-coder-plus", providerID: "iflowcn" }]]);

  const result = readAndClearSessionHangState(
    "s1",
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.deepEqual(result.model, { id: "qwen3-coder-plus", providerID: "iflowcn" });
});

test("readAndClearSessionHangState_whenAllMapsPopulated_delegationClearsStartTimeMap", () => {
  // M121 asymmetric pin C: isolates the `clearSessionHangState(...)`
  // delegation. All three maps are populated; the ONLY assertion is
  // that the start-time map entry is gone after the call. A drift
  // that drops the delegation entirely leaves `sessionStartTimeMap`
  // still containing "s1" and this pin fires alone — the two read
  // pins are unaffected because their assertions are on the returned
  // tuple, not on the map state.
  const sessionStartTimeMap = new Map<string, number>([["s1", 1000]]);
  const sessionActiveProviderMap = new Map<string, string>([["s1", "iflowcn"]]);
  const sessionActiveModelMap = new Map<
    string,
    { id: string; providerID: string }
  >([["s1", { id: "qwen3-coder-plus", providerID: "iflowcn" }]]);

  readAndClearSessionHangState(
    "s1",
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );

  assert.equal(sessionStartTimeMap.has("s1"), false);
});

test("buildProviderHealthSystemPrompt_whenOnlyRoutePenaltiesExist_emitsRouteSection", () => {
  // Regression: the transform hook used to short-circuit on
  // `providerHealthMap.size === 0`, so a route-level penalty
  // (model_not_found, route-level quota from zero-token completion,
  // timeout from the hang detector) never surfaced in the agent
  // system prompt. The agent kept using a just-killed route with
  // zero warning.
  const now = Date.now();
  const entry: ModelRegistryEntry = {
    id: "qwen3-coder-plus",
    enabled: true,
    description: "qwen3-coder-plus description",
    capability_tier: "strong",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: [],
    not_for: [],
    default_roles: ["implementation_worker"],
    provider_order: [
      { provider: "iflowcn", model: "iflowcn/qwen3-coder-plus", priority: 1 },
      { provider: "opencode-go", model: "opencode-go/qwen3-coder-plus", priority: 2 },
    ],
    notes: [],
  };
  const modelRouteHealthMap = new Map([
    [
      "iflowcn/qwen3-coder-plus",
      { state: "model_not_found" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);

  const prompt = buildProviderHealthSystemPrompt(
    [entry],
    new Map(),
    modelRouteHealthMap,
    now,
  );

  assert.notEqual(prompt, null);
  assert.match(prompt as string, /Route iflowcn\/qwen3-coder-plus \[MODEL NOT FOUND\]/);
  // The suggested fallback must be the visible+healthy sibling route,
  // not the dead one. findCuratedFallbackRoute already skips the dead
  // route via modelRouteHealthMap consultation (M24).
  assert.match(
    prompt as string,
    /Curated fallback for qwen3-coder-plus: opencode-go\/qwen3-coder-plus/,
  );
});

test("buildProviderHealthSystemPrompt_whenNoPenalties_returnsNull", () => {
  const prompt = buildProviderHealthSystemPrompt([], new Map(), new Map(), Date.now());
  assert.equal(prompt, null);
});

test("isAgentVisibleHealthState_whenStateIsKeyMissing_returnsFalse", () => {
  assert.equal(isAgentVisibleHealthState("key_missing"), false);
});

test("isAgentVisibleHealthState_whenStateIsTransientPenalty_returnsTrue", () => {
  assert.equal(isAgentVisibleHealthState("quota"), true);
  assert.equal(isAgentVisibleHealthState("key_dead"), true);
  assert.equal(isAgentVisibleHealthState("no_credit"), true);
  assert.equal(isAgentVisibleHealthState("model_not_found"), true);
  assert.equal(isAgentVisibleHealthState("timeout"), true);
});

test("buildProviderHealthSystemPrompt_whenOnlyKeyMissingPenaltiesExist_returnsNull", () => {
  // M59 regression pin. Before M58 wired `initializeProviderHealthState`
  // into the factory, `key_missing` entries were effectively never
  // installed at runtime and this code path was dormant. After M58,
  // every cold start installs `key_missing` for every uncredentialed
  // curated provider — on a realistic install that's 15–25 entries.
  // Surfacing each of them as its own "Provider X [KEY MISSING] until
  // never. Curated fallbacks: ..." section on every agent turn was a
  // semantic and cost bug: the agent can't route to a key_missing
  // provider in the first place (isProviderHealthy already skips them
  // upstream), the label `PROVIDER_QUOTA_STATUS_HEADER` conflates
  // permanent plumbing state with transient backoff the agent might
  // retry through, and the per-entry findCuratedFallbackRoute loop adds
  // nontrivial CPU cost to every turn. Fix filters key_missing out of
  // the system prompt via `isAgentVisibleHealthState`.
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const providerHealthMap = new Map([
    [
      "opencode",
      {
        state: "key_missing" as const,
        until: Number.POSITIVE_INFINITY,
        retryCount: 0,
      },
    ],
    [
      "iflowcn",
      {
        state: "key_missing" as const,
        until: Number.POSITIVE_INFINITY,
        retryCount: 0,
      },
    ],
  ]);

  const prompt = buildProviderHealthSystemPrompt(
    [entry],
    providerHealthMap,
    new Map(),
    now,
  );

  assert.equal(prompt, null);
});

test("buildProviderHealthSystemPrompt_whenQuotaAndKeyMissingMixed_omitsKeyMissingFromSections", () => {
  // Same M59 pin, mixed case. One transient `quota` entry (the agent
  // must see this — it affects a route they might otherwise retry),
  // one permanent `key_missing` entry (plumbing, must not appear). The
  // output must contain the quota provider and must NOT mention the
  // key_missing one.
  const now = Date.now();
  const quotaEntry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const keyMissingEntry: ModelRegistryEntry = buildModelRegistryEntry(
    "kimi-k2-thinking",
    ["deep_reviewer"],
    "frontier",
    [
      {
        provider: "kimi-for-coding",
        model: "kimi-for-coding/kimi-k2-thinking",
        priority: 1,
      },
    ],
  );

  const providerHealthMap = new Map([
    [
      "opencode",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
    [
      "kimi-for-coding",
      {
        state: "key_missing" as const,
        until: Number.POSITIVE_INFINITY,
        retryCount: 0,
      },
    ],
  ]);

  const prompt = buildProviderHealthSystemPrompt(
    [quotaEntry, keyMissingEntry],
    providerHealthMap,
    new Map(),
    now,
  );

  assert.notEqual(prompt, null);
  assert.match(prompt as string, /Provider opencode \[QUOTA BACKOFF\]/);
  assert.equal(
    (prompt as string).includes("kimi-for-coding"),
    false,
    "key_missing provider must not appear in agent-visible system prompt",
  );
  assert.equal(
    (prompt as string).includes("KEY MISSING"),
    false,
    "key_missing label must not leak into agent-visible system prompt",
  );
});

test("hasAgentVisiblePenalty_whenBothMapsEmpty_returnsFalse", () => {
  assert.equal(hasAgentVisiblePenalty(new Map(), new Map(), Date.now()), false);
});

test("hasAgentVisiblePenalty_whenOnlyKeyMissingEntries_returnsFalse", () => {
  // Post-M58 cold-start shape: every uncredentialed curated provider
  // lands in providerHealthMap with state=key_missing and until=Infinity.
  // The caller must treat this as "nothing worth surfacing" so the
  // agent-visible system-prompt builders can skip their work.
  const now = Date.now();
  const providerHealthMap = new Map([
    [
      "iflowcn",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
    [
      "kimi-for-coding",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
  ]);
  assert.equal(hasAgentVisiblePenalty(providerHealthMap, new Map(), now), false);
});

test("hasAgentVisiblePenalty_whenTransientProviderPenaltyLive_returnsTrue", () => {
  // Any single live transient penalty in either map must flip the
  // guard. Asserts each of the five transient states individually so a
  // future additional transient state has to come through this test
  // rather than being silently filtered out.
  const now = Date.now();
  const states = ["quota", "key_dead", "no_credit", "model_not_found", "timeout"] as const;
  for (const state of states) {
    const providerHealthMap = new Map([
      ["opencode", { state, until: now + 60_000, retryCount: 1 }],
    ]);
    assert.equal(
      hasAgentVisiblePenalty(providerHealthMap, new Map(), now),
      true,
      `transient state ${state} must be agent-visible`,
    );
  }
});

test("hasAgentVisiblePenalty_whenOnlyRouteLevelPenaltyLive_returnsTrue", () => {
  // Route-level penalties count. M27 fix at a different call site: a
  // zero-token-quota signal lands in modelRouteHealthMap only, and the
  // agent needs to see the availability impact even though the
  // provider map is clean.
  const now = Date.now();
  const modelRouteHealthMap = new Map([
    [
      "opencode/glm-5.1",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  assert.equal(
    hasAgentVisiblePenalty(new Map(), modelRouteHealthMap, now),
    true,
  );
});

test("hasAgentVisiblePenalty_whenAllTransientEntriesAreExpired_returnsFalse", () => {
  // Expired entries (until <= now) must not count. Without this guard
  // the experimental.chat.system.transform hook would push a stale
  // "alternative models" section even though expireHealthMaps has
  // already finished sweeping.
  const now = Date.now();
  const providerHealthMap = new Map([
    ["opencode", { state: "quota" as const, until: now - 1, retryCount: 1 }],
  ]);
  const modelRouteHealthMap = new Map([
    [
      "iflowcn/glm-5.1",
      { state: "timeout" as const, until: now - 1, retryCount: 1 },
    ],
  ]);
  assert.equal(
    hasAgentVisiblePenalty(providerHealthMap, modelRouteHealthMap, now),
    false,
  );
});

test("hasAgentVisiblePenalty_whenKeyMissingAndLiveQuotaMixed_returnsTrue", () => {
  // Mixed case: one permanent key_missing entry, one live transient
  // quota entry. Must return true — the quota is agent-visible even
  // though the key_missing is not.
  const now = Date.now();
  const providerHealthMap = new Map([
    [
      "kimi-for-coding",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
    ["opencode", { state: "quota" as const, until: now + 60_000, retryCount: 1 }],
  ]);
  assert.equal(hasAgentVisiblePenalty(providerHealthMap, new Map(), now), true);
});

test("formatPenaltySectionPrefix_whenCalled_containsProviderQuotaStatusHeader", () => {
  // Pin 1 (header constant): asserts the result contains the exact
  // `## Provider health status` banner. A sabotage that drops the
  // header from the return array fires this pin alone — pins 2 and 3
  // check substrings within the synopsis line, which is not affected
  // by the header's presence.
  const health: ProviderHealth = { state: "quota", until: 1700000000000, retryCount: 0 };
  const result = formatPenaltySectionPrefix("Provider openrouter", health);
  assert.ok(result.includes("## Provider health status"));
});

test("formatPenaltySectionPrefix_whenStateIsQuota_synopsisContainsQuotaBackoffLabel", () => {
  // Pin 2 (healthStateLabel call): asserts the synopsis contains
  // `[QUOTA BACKOFF]` — the human-readable label for `state: "quota"`.
  // A sabotage that interpolates raw `health.state` produces
  // `[quota]` (lowercase) and fires this pin alone — pin 1 still
  // finds the header, and pin 3 still finds the ISO string because
  // the until field is untouched.
  const health: ProviderHealth = { state: "quota", until: 1700000000000, retryCount: 0 };
  const result = formatPenaltySectionPrefix("Provider openrouter", health);
  const synopsis = result.find((line) => line.startsWith("Provider openrouter"));
  assert.ok(synopsis !== undefined);
  assert.ok(synopsis.includes("[QUOTA BACKOFF]"));
});

test("formatPenaltySectionPrefix_whenUntilIsFinite_synopsisContainsISO8601String", () => {
  // Pin 3 (formatHealthExpiry call): asserts the synopsis contains
  // the ISO-8601 string for `until: 1700000000000`, specifically
  // `2023-11-14T22:13:20.000Z`. A sabotage that interpolates raw
  // `health.until` produces the literal string `"1700000000000"`
  // and fires this pin alone — pin 1 still finds the header, and
  // pin 2 still finds `[QUOTA BACKOFF]` because the state label
  // derivation is independent of the until formatter.
  const health: ProviderHealth = { state: "quota", until: 1700000000000, retryCount: 0 };
  const result = formatPenaltySectionPrefix("Provider openrouter", health);
  const synopsis = result.find((line) => line.startsWith("Provider openrouter"));
  assert.ok(synopsis !== undefined);
  assert.ok(synopsis.includes(new Date(1700000000000).toISOString()));
});

test("collectAgentVisibleLivePenalties_whenOnlyProviderMapHasLiveEntry_returnsProvidersOnly", () => {
  // Pin 1 (provider filter): provider map has one live quota + one
  // key_missing; route map empty. Expects result.providers.length === 1
  // (the key_missing entry filtered out) and result.routes.length === 0.
  // A sabotage that drops the provider filter would include the
  // key_missing entry and push providers.length to 2; a sabotage on the
  // route filter has no effect (route map is empty either way).
  const now = 2_000_000_000_000;
  const providerHealthMap = new Map<string, ProviderHealth>();
  providerHealthMap.set("provA", { state: "quota", until: now + 60_000, retryCount: 0 });
  providerHealthMap.set("provB", { state: "key_missing", until: Number.POSITIVE_INFINITY, retryCount: 0 });
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const result = collectAgentVisibleLivePenalties(providerHealthMap, modelRouteHealthMap, now);
  assert.notEqual(result, null);
  assert.equal(result?.providers.length, 1);
  assert.equal(result?.providers[0]?.[0], "provA");
  assert.equal(result?.routes.length, 0);
});

test("collectAgentVisibleLivePenalties_whenOnlyRouteMapHasLiveEntry_returnsRoutesOnly", () => {
  // Pin 2 (route filter, mirror of pin 1): route map has one live
  // quota + one key_missing; provider map empty. Expects
  // result.routes.length === 1 and result.providers.length === 0. A
  // sabotage that drops the route filter would include key_missing
  // and push routes.length to 2; a sabotage on the provider filter
  // has no effect (provider map is empty either way). The mirror
  // shape catches the classic "refactor touches one branch and
  // forgets the other" asymmetric drift.
  const now = 2_000_000_000_000;
  const providerHealthMap = new Map<string, ProviderHealth>();
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  modelRouteHealthMap.set("openrouter/foo:free", { state: "quota", until: now + 60_000, retryCount: 0 });
  modelRouteHealthMap.set("openrouter/bar:free", { state: "key_missing", until: Number.POSITIVE_INFINITY, retryCount: 0 });
  const result = collectAgentVisibleLivePenalties(providerHealthMap, modelRouteHealthMap, now);
  assert.notEqual(result, null);
  assert.equal(result?.routes.length, 1);
  assert.equal(result?.routes[0]?.[0], "openrouter/foo:free");
  assert.equal(result?.providers.length, 0);
});

test("collectAgentVisibleLivePenalties_whenBothMapsEmpty_returnsNullSentinel", () => {
  // Pin 3 (both-empty null sentinel): both maps are EMPTY (not merely
  // filtered-to-empty). This isolates the null-gate drift surface
  // from the two filter drift surfaces — dropping either filter
  // has no effect on an empty map, but dropping the
  // `both empty → null` gate would return `{providers: [], routes: []}`
  // instead of null and fire this pin alone.
  const now = 2_000_000_000_000;
  const providerHealthMap = new Map<string, ProviderHealth>();
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const result = collectAgentVisibleLivePenalties(providerHealthMap, modelRouteHealthMap, now);
  assert.equal(result, null);
});

test("buildProviderHealthSummaryForTool_whenEntryPresent_preservesStateField", () => {
  // Pin 1 (state field): the `state` key is the "what's broken" signal
  // the agent reads in the no-recommendation branch. A sabotage that
  // drops the field silently produces a summary without WHY each
  // provider is penalized. Uses a single-entry map so sabotages that
  // filter entries still leave this entry present.
  const providerHealthMap = new Map<string, ProviderHealth>();
  providerHealthMap.set("provA", { state: "quota", until: 1700000000000, retryCount: 2 });
  const result = buildProviderHealthSummaryForTool(providerHealthMap);
  assert.equal(result.provA?.state, "quota");
});

test("buildProviderHealthSummaryForTool_whenEntryPresent_formatsUntilViaFormatHealthExpiry", () => {
  // Pin 2 (formatter call): the `formatHealthExpiry(h.until)` call is
  // load-bearing — passing raw `h.until` emits unix epoch ms (and
  // Infinity encodes as JSON null, hiding key_missing). Uses a
  // single-entry map so sabotages that filter entries still leave
  // this entry present.
  const providerHealthMap = new Map<string, ProviderHealth>();
  providerHealthMap.set("provA", { state: "quota", until: 1700000000000, retryCount: 2 });
  const result = buildProviderHealthSummaryForTool(providerHealthMap);
  assert.equal(result.provA?.until, new Date(1700000000000).toISOString());
});

test("buildProviderHealthSummaryForTool_whenMapHasTwoEntries_preservesAllKeys", () => {
  // Pin 3 (no-filter policy): the summary is an UNFILTERED pass-through,
  // unlike `buildAgentVisibleBackoffStatus`. A sabotage that copies a
  // filter from the sibling helper silently drops key_missing entries
  // — EXACTLY the entries the agent needs in the no-recommendation
  // case. Uses a two-entry map with one live and one key_missing so
  // ANY filter drop surfaces as a missing key.
  const providerHealthMap = new Map<string, ProviderHealth>();
  providerHealthMap.set("provA", { state: "quota", until: 1700000000000, retryCount: 0 });
  providerHealthMap.set("provB", { state: "key_missing", until: Number.POSITIVE_INFINITY, retryCount: 0 });
  const result = buildProviderHealthSummaryForTool(providerHealthMap);
  assert.deepEqual(Object.keys(result).sort(), ["provA", "provB"]);
});

test("buildAgentVisibleBackoffStatus_whenBothMapsEmpty_returnsEmpty", () => {
  // Baseline: nothing in either map returns an empty object.
  const result = buildAgentVisibleBackoffStatus(new Map(), new Map(), Date.now());
  assert.deepEqual(result, {});
});

test("buildAgentVisibleBackoffStatus_whenOnlyKeyMissingEntries_returnsEmpty", () => {
  // Headline integration pin for M63. Post-M58 shape: a freshly-booted
  // plugin with no credentials has `providerHealthMap` pre-populated
  // with key_missing entries for every uncredentialed curated provider.
  // The tool's contract is "return CURRENTLY PENALIZED providers" —
  // key_missing is permanent plumbing state, not a transient penalty,
  // and the agent has nothing to retry through. Pre-M63 the handler
  // emitted the full roster labeled as "currently penalized", making
  // the tool output useless for answering "what's broken right now".
  // Post-M63, filter via `isAgentVisibleHealthState` → empty object.
  const providerHealthMap = new Map([
    [
      "iflowcn",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
    [
      "opencode",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
    [
      "kimi-for-coding",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
  ]);
  const result = buildAgentVisibleBackoffStatus(
    providerHealthMap,
    new Map(),
    Date.now(),
  );
  assert.deepEqual(
    result,
    {},
    "post-M58 fresh-boot key_missing roster must not be emitted as 'currently penalized'",
  );
});

test("buildAgentVisibleBackoffStatus_whenLiveQuotaPenalty_includesProviderEntry", () => {
  // Transient provider-level quota must be emitted with type:"provider"
  // and the full state/until/retryCount shape the agent expects.
  const now = Date.now();
  const providerHealthMap = new Map([
    ["opencode", { state: "quota" as const, until: now + 60_000, retryCount: 2 }],
  ]);
  const result = buildAgentVisibleBackoffStatus(
    providerHealthMap,
    new Map(),
    now,
  );
  assert.equal(Object.keys(result).length, 1);
  const entry = result["opencode"]!;
  assert.equal(entry.state, "quota");
  assert.equal(entry.type, "provider");
  assert.equal(entry.retryCount, 2);
  assert.ok(entry.until && entry.until !== "never");
});

test("buildAgentVisibleBackoffStatus_whenMixedKeyMissingAndLiveQuota_filtersKeyMissingOnly", () => {
  // Sibling pin for the headline: when a real transient quota is live
  // AND the permanent key_missing roster is present, the tool must
  // emit ONLY the quota entry. Prevents regressing the M63 filter into
  // "suppress everything when key_missing is present" — the quota is
  // actionable, the key_missing is not, and the agent needs the
  // actionable entry on its own with no noise.
  const now = Date.now();
  const providerHealthMap = new Map([
    [
      "iflowcn",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
    ["opencode", { state: "quota" as const, until: now + 60_000, retryCount: 1 }],
    [
      "kimi-for-coding",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
  ]);
  const result = buildAgentVisibleBackoffStatus(
    providerHealthMap,
    new Map(),
    now,
  );
  assert.equal(Object.keys(result).length, 1);
  assert.ok(result["opencode"]);
  assert.equal(result["opencode"]!.state, "quota");
  assert.equal(result["iflowcn"], undefined);
  assert.equal(result["kimi-for-coding"], undefined);
});

test("buildAgentVisibleBackoffStatus_whenRouteLevelPenaltyLive_includesRouteEntry", () => {
  // Route-level penalties (model_not_found, zero-token quota, hang
  // timeout) must surface in the output with type:"model_route". The
  // pre-M63 handler covered route entries too; this pin ensures the
  // M63 refactor preserved that coverage.
  const now = Date.now();
  const modelRouteHealthMap = new Map([
    [
      "openrouter/xiaomi/dead-model",
      { state: "model_not_found" as const, until: now + 6 * 60 * 60_000, retryCount: 1 },
    ],
  ]);
  const result = buildAgentVisibleBackoffStatus(
    new Map(),
    modelRouteHealthMap,
    now,
  );
  assert.equal(Object.keys(result).length, 1);
  const entry = result["openrouter/xiaomi/dead-model"]!;
  assert.equal(entry.state, "model_not_found");
  assert.equal(entry.type, "model_route");
});

test("buildAgentVisibleBackoffStatus_whenEntriesExpired_excludesExpired", () => {
  // Defensive pin: even if the caller forgot to call
  // `expireHealthMaps` first, the helper must not emit entries whose
  // `until <= now`. The tool description says "currently penalized" —
  // expired is not current.
  const now = Date.now();
  const providerHealthMap = new Map([
    ["opencode", { state: "quota" as const, until: now - 1000, retryCount: 1 }],
    ["iflowcn", { state: "key_dead" as const, until: now + 60_000, retryCount: 1 }],
  ]);
  const result = buildAgentVisibleBackoffStatus(
    providerHealthMap,
    new Map(),
    now,
  );
  assert.equal(Object.keys(result).length, 1);
  assert.ok(result["iflowcn"]);
  assert.equal(result["opencode"], undefined);
});

test("buildAvailableModelsSystemPrompt_whenOnlyKeyMissingPenaltiesExist_returnsNull", () => {
  // Headline integration pin for M60. Post-M58 the factory installs a
  // key_missing entry for every uncredentialed curated provider. The
  // pre-M60 guard `size === 0 && size === 0` was dead wiring
  // (providerHealthMap is always non-empty), so the function fell
  // through to a full registry walk and emitted an
  // "Alternative models by role" section into the agent-visible system
  // prompt on every single turn — even on a freshly-booted plugin
  // with nothing actually wrong. Post-M60, `hasAgentVisiblePenalty`
  // gates the block: when every entry is permanent plumbing, return null.
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [{ provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 }],
  );
  const providerHealthMap = new Map([
    [
      "iflowcn",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
    [
      "kimi-for-coding",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
  ]);
  const prompt = buildAvailableModelsSystemPrompt(
    [entry],
    providerHealthMap,
    new Map(),
    now,
  );
  assert.equal(
    prompt,
    null,
    "alternative-models block must not fire when every health entry is permanent plumbing",
  );
});

test("buildAvailableModelsSystemPrompt_whenQuotaAndKeyMissingMixed_returnsAlternatives", () => {
  // Sibling pin for M60. One live transient quota (there IS a real
  // problem) plus a bunch of permanent key_missing entries. The
  // alternative-models block SHOULD fire — the agent needs to know
  // what else is routable while the quota backoff is in effect.
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [{ provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 }],
  );
  const providerHealthMap = new Map([
    [
      "iflowcn",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
    [
      "kimi-for-coding",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
  ]);
  const prompt = buildAvailableModelsSystemPrompt(
    [entry],
    providerHealthMap,
    new Map(),
    now,
  );
  assert.notEqual(
    prompt,
    null,
    "alternative-models block must fire when a live transient penalty exists",
  );
  assert.match(prompt as string, /architect: glm-5\.1/);
});

test("buildAvailableModelsSystemPrompt_whenPrimaryRouteIsHiddenPaid_walksToVisibleSibling", () => {
  // Regression: this function used to take `entry.provider_order[0]`
  // as "the primary route" and only check provider-level health. If
  // the first route was a hidden paid provider (the real mimo-v2-pro
  // case in config/models.jsonc: the first openrouter route is the
  // paid xiaomi/mimo-v2-pro), the entry was either listed under a
  // route the rest of the plugin actively blocks, or skipped entirely
  // depending on whether the hidden provider happened to be marked
  // unhealthy. Same bug class as M23/M24 at the agent-visible prompt
  // layer. Fix walks filterVisibleProviderRoutes and checks both
  // provider AND route health.
  const now = Date.now();
  const entry: ModelRegistryEntry = {
    id: "mimo-v2-pro",
    enabled: true,
    description: "mimo-v2-pro",
    capability_tier: "frontier",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: [],
    not_for: [],
    default_roles: ["long_context_reader"],
    provider_order: [
      // Hidden paid route — must NOT be the route we use to judge availability.
      { provider: "togetherai", model: "togetherai/mimo-v2-pro", priority: 1 },
      // Visible + healthy sibling.
      { provider: "opencode-go", model: "opencode-go/mimo-v2-pro", priority: 2 },
    ],
    notes: [],
  };
  // Seed a route-only penalty on an UNRELATED entry so the outer
  // "any health map nonempty" guard is triggered without any
  // provider-level penalty or any penalty on this entry.
  const modelRouteHealthMap = new Map([
    [
      "iflowcn/qwen3-coder-plus",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);

  const prompt = buildAvailableModelsSystemPrompt(
    [entry],
    new Map(),
    modelRouteHealthMap,
    now,
  );

  assert.notEqual(prompt, null);
  assert.match(prompt as string, /long_context_reader: mimo-v2-pro \(free\)/);
});

test("buildAvailableModelsSystemPrompt_whenOnlyVisibleRouteIsUnhealthyAtRouteLevel_skipsEntry", () => {
  // Regression: previously only provider-level health was considered,
  // so an entry whose only visible route had `model_not_found` or
  // route-level quota was still listed as "available" despite being
  // provably dead. Fix consults modelRouteHealthMap.
  const now = Date.now();
  const entry: ModelRegistryEntry = {
    id: "dead-model",
    enabled: true,
    description: "dead-model",
    capability_tier: "strong",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: [],
    not_for: [],
    default_roles: ["implementation_worker"],
    provider_order: [
      { provider: "iflowcn", model: "iflowcn/dead-model", priority: 1 },
    ],
    notes: [],
  };
  const modelRouteHealthMap = new Map([
    [
      "iflowcn/dead-model",
      { state: "model_not_found" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);

  const prompt = buildAvailableModelsSystemPrompt(
    [entry],
    new Map(),
    modelRouteHealthMap,
    now,
  );

  // The whole prompt collapses to null because no entries survive
  // the route-health filter and the roleToModels map is empty.
  assert.equal(prompt, null);
});

test("computeRegistryEntryHealthReport_whenPrimaryVisibleRouteIsRouteUnhealthy_reportsRouteScope", () => {
  // Regression (M29): listCuratedModels previously read provider_order[0]
  // raw and only checked provider health, so an entry whose primary
  // visible route had model_not_found or a zero-token quota looked
  // "healthy" to the agent and kept getting routed to. Fix: walk
  // filterVisibleProviderRoutes + consult modelRouteHealthMap, emit a
  // scope:"route" entry so the agent can distinguish.
  const now = Date.now();
  const entry: ModelRegistryEntry = {
    id: "dead-primary",
    enabled: true,
    description: "dead-primary",
    capability_tier: "strong",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: [],
    not_for: [],
    default_roles: ["implementation_worker"],
    provider_order: [
      { provider: "iflowcn", model: "iflowcn/dead-primary", priority: 1 },
    ],
    notes: [],
  };
  const providerHealthMap = new Map();
  const modelRouteHealthMap = new Map([
    [
      "iflowcn/dead-primary",
      { state: "model_not_found" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);

  const report = computeRegistryEntryHealthReport(
    entry,
    providerHealthMap,
    modelRouteHealthMap,
    now,
  );

  assert.ok(report);
  assert.equal(report.state, "model_not_found");
  assert.equal(report.scope, "route");
});

test("computeRegistryEntryHealthReport_whenPrimaryRouteIsHiddenPaid_walksToVisibleSibling", () => {
  // Regression (M29): previously provider_order[0] was used raw. If the
  // primary was a hidden paid route (e.g. openrouter/xiaomi/mimo-v2-pro)
  // and that route had a route-level penalty, the report lied about the
  // visible fallback's health. Fix: filter to visible first, report on
  // the first visible route's health.
  const now = Date.now();
  const entry: ModelRegistryEntry = {
    id: "mimo-v2-pro",
    enabled: true,
    description: "mimo-v2-pro",
    capability_tier: "frontier",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: [],
    not_for: [],
    default_roles: ["architect"],
    provider_order: [
      { provider: "openrouter", model: "openrouter/xiaomi/mimo-v2-pro", priority: 1 },
      { provider: "opencode-go", model: "opencode-go/mimo-v2-pro", priority: 2 },
    ],
    notes: [],
  };
  // Hidden paid primary's provider (openrouter) is marked dead at the
  // provider level; visible fallback (opencode-go) is healthy. HEAD code
  // read provider_order[0] raw, found openrouter unhealthy, and reported
  // scope:"provider" as if the whole entry was dead.
  const providerHealthMap = new Map([
    [
      "openrouter",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);

  const report = computeRegistryEntryHealthReport(
    entry,
    providerHealthMap,
    new Map(),
    now,
  );

  // Visible primary (opencode-go/mimo-v2-pro) is healthy → null report.
  assert.equal(report, null);
});

test("composeRouteKey_whenRegistryEntryIsUnprefixed_producesCompositeKey", () => {
  // Regression (M30): three longcat entries in models.jsonc store
  // provider_order[].model without the `longcat/` prefix
  // (LongCat-Flash-Chat, LongCat-Flash-Thinking, LongCat-Flash-Lite).
  // Session event handlers (session.error, assistant.message.completed,
  // chat.params hang timer) all key modelRouteHealthMap on the COMPOSITE
  // form `${providerID}/${model.id}` = "longcat/LongCat-Flash-Chat", but
  // read sites historically used `providerRoute.model` verbatim —
  // looking up "LongCat-Flash-Chat" (undefined). Route-level penalties
  // on longcat models were silently invisible. This helper normalizes.
  assert.equal(
    composeRouteKey({ provider: "longcat", model: "LongCat-Flash-Chat" }),
    "longcat/LongCat-Flash-Chat",
  );
  // Already-composite entries pass through unchanged.
  assert.equal(
    composeRouteKey({ provider: "ollama-cloud", model: "ollama-cloud/glm-5" }),
    "ollama-cloud/glm-5",
  );
  // Nested composites (openrouter/xiaomi/mimo-v2-pro) also pass through.
  assert.equal(
    composeRouteKey({ provider: "openrouter", model: "openrouter/xiaomi/mimo-v2-pro" }),
    "openrouter/xiaomi/mimo-v2-pro",
  );
});

test("composeRouteKey_whenProviderNameIsPrefixOfModelIdWithoutSlash_wrapsInsteadOfPassingThrough", () => {
  // M115 pin: the `startsWith(${provider}/)` check MUST include the
  // trailing slash — otherwise a provider whose name is a literal
  // prefix of a sibling model id (e.g. provider `"llama"` with model
  // `"llama3-8b"`) would be misclassified as already-composite and
  // pass through verbatim, producing a bare-key write that
  // `classifyPersistedHealthKey` misclassifies as a provider id.
  // The pre-existing pin's three cases (longcat/LongCat, ollama-
  // cloud/glm-5, openrouter/xiaomi/mimo) have no name-collision, so
  // this surface is only caught by an explicit collision pin.
  assert.equal(
    composeRouteKey({ provider: "llama", model: "llama3-8b" }),
    "llama/llama3-8b",
  );
});

test("composeRouteKey_whenModelHasMismatchedProviderPrefix_wrapsInCurrentProviderNamespace", () => {
  // M115 pin: a model id that is composite but whose prefix is a
  // DIFFERENT provider (aggregator-resolved id threaded through a
  // gateway) must still be wrapped in the CURRENT provider's
  // namespace, NOT passed through as the foreign composite. A
  // refactor to `.includes("/")` or `.split("/").length >= 2` as a
  // "simpler composite detector" would return the foreign composite
  // verbatim and the penalty recorded under the current provider's
  // id would land on the wrong composite key — invisible to the
  // current provider's health readers. The pre-existing pin never
  // tests a mismatched prefix.
  assert.equal(
    composeRouteKey({
      provider: "cloudflare-ai-gateway",
      model: "openrouter/xiaomi/mimo-v2-pro",
    }),
    "cloudflare-ai-gateway/openrouter/xiaomi/mimo-v2-pro",
  );
});

test("composeRouteKey_whenAppliedTwice_isIdempotentFixedPoint", () => {
  // M115 pin: writers and readers routinely round-trip route keys
  // through the helper (lookupRouteHealthByIdentifiers →
  // buildRouteHealthEntry → composeRouteKey again). The idempotency
  // contract — applying the helper twice equals applying it once —
  // must hold for every input shape or those round trips diverge.
  // A refactor that dropped the `startsWith` short-circuit (always
  // wrap) would break idempotency by double-prefixing on the second
  // call. The pre-existing pin's assertions all check single-call
  // outputs and never compose the helper with itself.
  const inputs: { provider: string; model: string }[] = [
    { provider: "longcat", model: "LongCat-Flash-Chat" },
    { provider: "ollama-cloud", model: "ollama-cloud/glm-5" },
    { provider: "openrouter", model: "xiaomi/mimo-v2-pro" },
    { provider: "openrouter", model: "openrouter/xiaomi/mimo-v2-pro" },
  ];
  for (const input of inputs) {
    const once = composeRouteKey(input);
    const twice = composeRouteKey({ provider: input.provider, model: once });
    assert.equal(
      twice,
      once,
      `composeRouteKey must be idempotent for ${JSON.stringify(input)}`,
    );
  }
});

test("isAgentVisibleLivePenalty_whenEntryLiveAndAgentVisible_returnsTrue", () => {
  // M69: canonical happy path — a live transient penalty that the agent
  // can route around (quota, key_dead, no_credit, model_not_found, timeout)
  // must be surfaced.
  assert.equal(
    isAgentVisibleLivePenalty({ state: "quota", until: 2_000 }, 1_000),
    true,
  );
  assert.equal(
    isAgentVisibleLivePenalty({ state: "model_not_found", until: 5_000 }, 1_000),
    true,
  );
});

test("isAgentVisibleLivePenalty_whenEntryExpired_returnsFalse", () => {
  // M69: expiration-gate pin — an entry with `until <= now` is already
  // past its backoff window and must not be surfaced. The strict `>`
  // comparison mirrors M29 route-level expiration semantics where a
  // boundary tick counts as expired.
  assert.equal(
    isAgentVisibleLivePenalty({ state: "quota", until: 1_000 }, 1_000),
    false,
  );
  assert.equal(
    isAgentVisibleLivePenalty({ state: "quota", until: 500 }, 1_000),
    false,
  );
});

test("isAgentVisibleLivePenalty_whenEntryIsKeyMissing_returnsFalse", () => {
  // M69: structural-plumbing pin — `key_missing` sentinels are installed
  // at boot by `initializeProviderHealthState` for every uncredentialed
  // curated provider, with `until: Number.POSITIVE_INFINITY`. They are
  // live (not expired), but the agent cannot route around a missing
  // credential — surfacing them floods every system prompt. The M59
  // `isAgentVisibleHealthState` gate excludes them; this predicate
  // inherits the gate.
  assert.equal(
    isAgentVisibleLivePenalty(
      { state: "key_missing", until: Number.POSITIVE_INFINITY },
      1_000,
    ),
    false,
  );
});

test("isAgentVisibleLivePenalty_whenKeyMissingButAlsoExpired_returnsFalse", () => {
  // M69: both-gates pin — `key_missing` with a finite past `until` (a
  // broken or hand-rolled test fixture) must still be excluded. The
  // predicate must not short-circuit on `until > now` alone.
  assert.equal(
    isAgentVisibleLivePenalty({ state: "key_missing", until: 500 }, 1_000),
    false,
  );
});

test("recordRouteHealthPenalty_whenCalled_writesHealthToRouteMap", () => {
  // M68: map-set invariant — the helper must write the new health entry
  // under the exact routeKey passed in, overwriting any prior entry.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const providerHealthMap = new Map<string, ProviderHealth>();
  const health: ModelRouteHealth = {
    state: "model_not_found",
    until: 42_000_000,
    retryCount: 3,
  };

  recordRouteHealthPenalty(
    modelRouteHealthMap,
    providerHealthMap,
    "iflowcn/dead-model",
    health,
    () => {},
  );

  assert.deepEqual(modelRouteHealthMap.get("iflowcn/dead-model"), health);
});

test("recordRouteHealthPenalty_whenCalled_invokesPersistFnWithBothMaps", () => {
  // M68: persistence-pairing invariant — the helper MUST invoke persistFn
  // with both the provider map AND the route map after writing the entry.
  // Any writer that does `map.set` without the persist call silently drops
  // the penalty on plugin reload. A spy proves the pair is enforced here
  // so future writers cannot forget it by inlining only half the pattern.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const providerHealthMap = new Map<string, ProviderHealth>([
    ["iflowcn", { state: "key_missing", until: Number.POSITIVE_INFINITY, retryCount: 0 }],
  ]);
  let persistCalls = 0;
  let observedProviderMap: Map<string, ProviderHealth> | null = null;
  let observedRouteMap: Map<string, ModelRouteHealth> | null = null;

  recordRouteHealthPenalty(
    modelRouteHealthMap,
    providerHealthMap,
    "iflowcn/kimi-k2-0905",
    { state: "quota", until: 1_000, retryCount: 1 },
    (providerMap, routeMap) => {
      persistCalls += 1;
      observedProviderMap = providerMap;
      observedRouteMap = routeMap;
    },
  );

  assert.equal(persistCalls, 1);
  // Reference equality: the helper must pass the LIVE maps so the
  // persister serializes the post-write state, not a stale snapshot.
  assert.equal(observedProviderMap, providerHealthMap);
  assert.equal(observedRouteMap, modelRouteHealthMap);
});

test("recordRouteHealthPenalty_whenMapHasExistingEntry_overwritesItBeforePersistFires", () => {
  // M68: write-ordering invariant — the map.set MUST happen BEFORE the
  // persistFn invocation, otherwise the persister serializes the pre-write
  // state and the new penalty is dropped on the next reload. A spy that
  // reads the live map at call time proves the order.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    [
      "ollama-cloud/glm-5",
      { state: "quota", until: 500, retryCount: 1 },
    ],
  ]);
  const providerHealthMap = new Map<string, ProviderHealth>();
  const newHealth: ModelRouteHealth = {
    state: "model_not_found",
    until: 9_000_000,
    retryCount: 2,
  };
  let snapshotAtPersist: ModelRouteHealth | undefined;

  recordRouteHealthPenalty(
    modelRouteHealthMap,
    providerHealthMap,
    "ollama-cloud/glm-5",
    newHealth,
    (_providerMap, routeMap) => {
      snapshotAtPersist = routeMap.get("ollama-cloud/glm-5");
    },
  );

  // By the time the persister fires, the overwrite is already visible.
  assert.deepEqual(snapshotAtPersist, newHealth);
  // And the post-call state matches.
  assert.deepEqual(modelRouteHealthMap.get("ollama-cloud/glm-5"), newHealth);
});

test("recordProviderHealthPenalty_whenCalled_writesHealthToProviderMap", () => {
  // M73: provider-layer map-set invariant — the helper must write the new
  // ProviderHealth entry under the exact providerID passed in, overwriting
  // any prior entry. Symmetric with the M68 route-layer pin.
  const providerHealthMap = new Map<string, ProviderHealth>();
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const health: ProviderHealth = {
    state: "no_credit",
    until: 42_000_000,
    retryCount: 3,
  };

  recordProviderHealthPenalty(
    providerHealthMap,
    modelRouteHealthMap,
    "openrouter",
    health,
    () => {},
  );

  assert.deepEqual(providerHealthMap.get("openrouter"), health);
});

test("recordProviderHealthPenalty_whenCalled_invokesPersistFnWithBothMaps", () => {
  // M73: persistence-pairing invariant — the helper MUST invoke persistFn
  // with both the provider map AND the route map after writing the entry.
  // Any provider-layer writer that does `providerHealthMap.set` without
  // the persist call silently drops the penalty on plugin reload. A spy
  // proves the pair is enforced here so future writers cannot forget it
  // by inlining only half the pattern. Symmetric with the M68 route-layer
  // persistence-pairing pin.
  const providerHealthMap = new Map<string, ProviderHealth>();
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    ["iflowcn/kimi-k2-0905", { state: "quota", until: 5_000, retryCount: 1 }],
  ]);
  let persistCalls = 0;
  let observedProviderMap: Map<string, ProviderHealth> | null = null;
  let observedRouteMap: Map<string, ModelRouteHealth> | null = null;

  recordProviderHealthPenalty(
    providerHealthMap,
    modelRouteHealthMap,
    "openrouter",
    { state: "quota", until: 2_000, retryCount: 1 },
    (providerMap, routeMap) => {
      persistCalls += 1;
      observedProviderMap = providerMap;
      observedRouteMap = routeMap;
    },
  );

  assert.equal(persistCalls, 1);
  // Reference equality: the helper must pass the LIVE maps so the
  // persister serializes the post-write state, not a stale snapshot.
  // Critically, `modelRouteHealthMap` is passed through unchanged so a
  // provider-layer write also re-snapshots any pending route-layer
  // entries — the atomic-snapshot shape M68 established.
  assert.equal(observedProviderMap, providerHealthMap);
  assert.equal(observedRouteMap, modelRouteHealthMap);
});

test("recordProviderHealthPenalty_whenMapHasExistingEntry_overwritesItBeforePersistFires", () => {
  // M73: write-ordering invariant — the providerHealthMap.set MUST happen
  // BEFORE the persistFn invocation, otherwise the persister serializes
  // the pre-write state and the new penalty is dropped on the next
  // reload. A spy that reads the live map at call time proves the order.
  // Symmetric with the M68 route-layer write-ordering pin.
  const providerHealthMap = new Map<string, ProviderHealth>([
    ["openrouter", { state: "quota", until: 500, retryCount: 1 }],
  ]);
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const newHealth: ProviderHealth = {
    state: "key_dead",
    until: 9_000_000,
    retryCount: 2,
  };
  let snapshotAtPersist: ProviderHealth | undefined;

  recordProviderHealthPenalty(
    providerHealthMap,
    modelRouteHealthMap,
    "openrouter",
    newHealth,
    (providerMap, _routeMap) => {
      snapshotAtPersist = providerMap.get("openrouter");
    },
  );

  // By the time the persister fires, the overwrite is already visible.
  assert.deepEqual(snapshotAtPersist, newHealth);
  assert.deepEqual(providerHealthMap.get("openrouter"), newHealth);
});

test("recordRouteHealthByIdentifiers_whenCalled_writesEntryUnderCompositeRouteKey", () => {
  // M75: the wrapper must thread (providerID, modelID) through
  // `buildRouteHealthEntry` so the write lands under the composite route
  // key. A future refactor that forgot to pass the builder's result into
  // `recordRouteHealthPenalty` would produce a no-op write that this pin
  // catches.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const providerHealthMap = new Map<string, ProviderHealth>();

  recordRouteHealthByIdentifiers(
    modelRouteHealthMap,
    providerHealthMap,
    "iflowcn",
    "kimi-k2-0905",
    "quota",
    60 * 60 * 1000,
    10_000,
    () => {},
  );

  const entry = modelRouteHealthMap.get("iflowcn/kimi-k2-0905");
  assert.ok(entry, "entry must be written under composite route key");
  assert.equal(entry!.state, "quota");
  assert.equal(entry!.until, 10_000 + 60 * 60 * 1000);
  assert.equal(entry!.retryCount, 1);
});

test("recordRouteHealthByIdentifiers_whenExistingEntryHasLongerUntil_preservesM43MergeInvariant", () => {
  // M75 + M43: the wrapper must feed `buildRouteHealthEntry` the result
  // of `lookupRouteHealthByIdentifiers` so the preserve-longer merge
  // fires. A refactor that inlined the build but skipped the lookup
  // (passing `undefined` as `existing`) would silently shrink an active
  // longer penalty — the exact M43 bug at the route layer. This pin
  // simulates a pre-existing `model_not_found` entry (6h) and asserts a
  // shorter quota (1h) incoming penalty loses the merge.
  const existingLongerUntil = 5_000 + 6 * 60 * 60 * 1000;
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    [
      "openrouter/xiaomi/mimo-v2-pro",
      { state: "model_not_found", until: existingLongerUntil, retryCount: 1 },
    ],
  ]);
  const providerHealthMap = new Map<string, ProviderHealth>();

  recordRouteHealthByIdentifiers(
    modelRouteHealthMap,
    providerHealthMap,
    "openrouter",
    "xiaomi/mimo-v2-pro",
    "quota",
    60 * 60 * 1000,
    5_000,
    () => {},
  );

  const entry = modelRouteHealthMap.get("openrouter/xiaomi/mimo-v2-pro");
  assert.ok(entry);
  // Longer penalty dominates: state and until stay at the pre-existing
  // `model_not_found` values, retryCount increments so repeat failures
  // remain observable.
  assert.equal(entry!.state, "model_not_found");
  assert.equal(entry!.until, existingLongerUntil);
  assert.equal(entry!.retryCount, 2);
});

test("recordRouteHealthByIdentifiers_whenCalled_invokesPersistFnThroughM68RecordWrapper", () => {
  // M75 + M68: the wrapper must delegate the write-and-persist pair to
  // `recordRouteHealthPenalty`, not a raw `map.set`. A refactor that
  // inlined the set but skipped the M68 helper would break the
  // durability-pair invariant — the penalty would live in memory but
  // vanish on plugin reload. A spy asserts persistFn fires exactly once
  // with reference equality to both live maps.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const providerHealthMap = new Map<string, ProviderHealth>();
  let persistCalls = 0;
  let observedProviderMap: Map<string, ProviderHealth> | null = null;
  let observedRouteMap: Map<string, ModelRouteHealth> | null = null;

  recordRouteHealthByIdentifiers(
    modelRouteHealthMap,
    providerHealthMap,
    "ollama-cloud",
    "glm-5",
    "timeout",
    60 * 60 * 1000,
    0,
    (providerMap, routeMap) => {
      persistCalls += 1;
      observedProviderMap = providerMap;
      observedRouteMap = routeMap;
    },
  );

  assert.equal(persistCalls, 1);
  assert.equal(observedProviderMap, providerHealthMap);
  assert.equal(observedRouteMap, modelRouteHealthMap);
});

test("recordModelNotFoundRouteHealthByIdentifiers_whenCalled_writesSixHourModelNotFoundEntry", () => {
  // M76: the model-not-found sibling must thread (providerID, modelID)
  // into `buildModelNotFoundRouteHealth`, which bakes in `"model_not_found"`
  // state and the dedicated 6h `ROUTE_MODEL_NOT_FOUND_DURATION_MS`. A
  // future refactor that accidentally called `buildRouteHealthEntry` with
  // the quota duration would produce a 1h window — exactly the bug
  // `buildModelNotFoundRouteHealth` was introduced to prevent.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const providerHealthMap = new Map<string, ProviderHealth>();

  recordModelNotFoundRouteHealthByIdentifiers(
    modelRouteHealthMap,
    providerHealthMap,
    "openrouter",
    "xiaomi/gone-tomorrow",
    42_000,
    () => {},
  );

  const entry = modelRouteHealthMap.get("openrouter/xiaomi/gone-tomorrow");
  assert.ok(entry, "entry must be written under composite route key");
  assert.equal(entry!.state, "model_not_found");
  assert.equal(entry!.until, 42_000 + ROUTE_MODEL_NOT_FOUND_DURATION_MS);
  assert.equal(entry!.retryCount, 1);
});

test("recordModelNotFoundRouteHealthByIdentifiers_whenExistingQuotaEntryShorter_overridesWithLongerModelNotFound", () => {
  // M76 + M43: the wrapper must thread the existing entry through
  // `buildModelNotFoundRouteHealth`, which inherits the preserve-longer
  // merge from `buildRouteHealthEntry`. A pre-existing 1h quota penalty
  // must lose to an incoming 6h model_not_found penalty (the incoming
  // penalty has the longer `until`). This pins the lookup-wiring + merge
  // path for the model-not-found branch.
  const now = 1_000;
  const shorterExistingUntil = now + 60 * 60 * 1000; // 1h
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    [
      "openrouter/xiaomi/gone-tomorrow",
      { state: "quota", until: shorterExistingUntil, retryCount: 3 },
    ],
  ]);
  const providerHealthMap = new Map<string, ProviderHealth>();

  recordModelNotFoundRouteHealthByIdentifiers(
    modelRouteHealthMap,
    providerHealthMap,
    "openrouter",
    "xiaomi/gone-tomorrow",
    now,
    () => {},
  );

  const entry = modelRouteHealthMap.get("openrouter/xiaomi/gone-tomorrow");
  assert.ok(entry);
  // Longer penalty dominates: 6h wins over 1h, state flips, retryCount
  // increments off the 3 the prior entry had.
  assert.equal(entry!.state, "model_not_found");
  assert.equal(entry!.until, now + ROUTE_MODEL_NOT_FOUND_DURATION_MS);
  assert.equal(entry!.retryCount, 4);
});

test("recordModelNotFoundRouteHealthByIdentifiers_whenCalled_invokesPersistFnThroughM68RecordWrapper", () => {
  // M76 + M68: the wrapper must delegate to `recordRouteHealthPenalty`
  // so the durability-pair invariant holds for the model-not-found
  // branch. A spy asserts persistFn fires exactly once with reference
  // equality to both live maps — same shape as the M75 persist pin.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const providerHealthMap = new Map<string, ProviderHealth>();
  let persistCalls = 0;
  let observedProviderMap: Map<string, ProviderHealth> | null = null;
  let observedRouteMap: Map<string, ModelRouteHealth> | null = null;

  recordModelNotFoundRouteHealthByIdentifiers(
    modelRouteHealthMap,
    providerHealthMap,
    "iflowcn",
    "phantom-model-v2",
    0,
    (providerMap, routeMap) => {
      persistCalls += 1;
      observedProviderMap = providerMap;
      observedRouteMap = routeMap;
    },
  );

  assert.equal(persistCalls, 1);
  assert.equal(observedProviderMap, providerHealthMap);
  assert.equal(observedRouteMap, modelRouteHealthMap);
});

test("recordModelNotFoundRouteHealthByIdentifiers_whenCalled_persistFnObservesRouteEntryAlreadyWritten", () => {
  // M114 pin: the durability-pair contract requires `map.set` to
  // happen BEFORE `persistFn` is invoked — a refactor that fired
  // persistFn first for "lower-latency flush" would let persistFn
  // serialize a pre-write snapshot that omits the new penalty. Pin 3
  // only counts invocations and captures references; a swapped
  // ordering is visible only from inside the persistFn closure. This
  // pin inspects `modelRouteHealthMap` at the moment persistFn fires
  // and asserts the new entry is already present and matches.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const providerHealthMap = new Map<string, ProviderHealth>();
  let entryVisibleInsidePersistFn: ModelRouteHealth | undefined;

  recordModelNotFoundRouteHealthByIdentifiers(
    modelRouteHealthMap,
    providerHealthMap,
    "iflowcn",
    "phantom-model-v2",
    100_000,
    (_providerMap, routeMap) => {
      entryVisibleInsidePersistFn = routeMap.get("iflowcn/phantom-model-v2");
    },
  );

  assert.ok(
    entryVisibleInsidePersistFn,
    "persistFn must observe the new route entry already written",
  );
  assert.equal(entryVisibleInsidePersistFn!.state, "model_not_found");
  assert.equal(
    entryVisibleInsidePersistFn!.until,
    100_000 + ROUTE_MODEL_NOT_FOUND_DURATION_MS,
  );
});

test("recordModelNotFoundRouteHealthByIdentifiers_whenCalled_leavesProviderHealthMapUnmutated", () => {
  // M114 pin: the model-not-found branch is deliberately route-level
  // only — a structural "this model does not exist at this provider"
  // must NOT also penalize the provider. A refactor that "defensively"
  // mirrored the write into `providerHealthMap` would silently
  // quarantine every healthy sibling route through the same provider
  // whenever any one model returned a model_not_found error. M76
  // pins never assert the post-call state of `providerHealthMap`.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const providerHealthMap = new Map<string, ProviderHealth>();

  recordModelNotFoundRouteHealthByIdentifiers(
    modelRouteHealthMap,
    providerHealthMap,
    "openrouter",
    "typo-model-v3",
    0,
    () => {},
  );

  assert.equal(
    providerHealthMap.size,
    0,
    "providerHealthMap must remain empty — model_not_found is route-level only",
  );
  assert.equal(
    modelRouteHealthMap.size,
    1,
    "exactly one route-level entry must be written",
  );
});

test("recordModelNotFoundRouteHealthByIdentifiers_whenCalledTwiceWithUnprefixedModelID_carriesRetryCountAcrossLookup", () => {
  // M114 pin: the pre-write lookup must thread the SAME
  // `(providerID, modelID)` pair passed to the builder so a second
  // call finds the first call's entry via the composite-key
  // `composeRouteKey` round trip. M76 pin 2 pre-populates a map with
  // an aggregator-composite key and exercises the merge, but it
  // never tests write-then-lookup under an UNPREFIXED modelID where
  // both paths must agree on `provider/model` composition. A
  // refactor that broke the lookup threading (e.g. `map.get(modelID)`
  // with the raw id) would pass pin 2 because pin 2's map already
  // contains the composite key, but would fail here: the second call
  // would miss its own prior write and reset retryCount to 1.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const providerHealthMap = new Map<string, ProviderHealth>();

  recordModelNotFoundRouteHealthByIdentifiers(
    modelRouteHealthMap,
    providerHealthMap,
    "iflowcn",
    "phantom-v9",
    10_000,
    () => {},
  );
  recordModelNotFoundRouteHealthByIdentifiers(
    modelRouteHealthMap,
    providerHealthMap,
    "iflowcn",
    "phantom-v9",
    20_000,
    () => {},
  );

  const entry = modelRouteHealthMap.get("iflowcn/phantom-v9");
  assert.ok(entry, "entry must live under the composite route key");
  assert.equal(
    entry!.retryCount,
    2,
    "second call must find first call's entry via symmetric lookup and increment retryCount",
  );
});

test("lookupRouteHealthByIdentifiers_whenEntryStoredUnderCompositeKey_returnsEntry", () => {
  // M67: the helper is the single source of truth for "find existing
  // route health for this (providerID, modelID) pair". It must compose
  // the composite key the same way writers do, otherwise a writer that
  // inlines its own `${providerID}/${modelID}` string and this helper
  // drift apart and the M43 preserve-longer invariant silently evaporates.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    [
      "ollama-cloud/glm-5",
      { state: "quota", until: 1_000_000, retryCount: 2 },
    ],
  ]);
  const entry = lookupRouteHealthByIdentifiers(
    modelRouteHealthMap,
    "ollama-cloud",
    "glm-5",
  );
  assert.deepEqual(entry, { state: "quota", until: 1_000_000, retryCount: 2 });
});

test("lookupRouteHealthByIdentifiers_whenModelIsAlreadyCompositePrefixed_doesNotDoubleNest", () => {
  // M67: models.jsonc sometimes stores `model` as the already-composite
  // `${provider}/${model}` form (ollama-cloud/glm-5, openrouter/xiaomi/...).
  // `composeRouteKey` is idempotent for that case, and this helper must
  // inherit the idempotence — otherwise a double-nested read would miss
  // entries writers wrote once.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    [
      "ollama-cloud/glm-5",
      { state: "model_not_found", until: 2_000_000, retryCount: 1 },
    ],
  ]);
  const entry = lookupRouteHealthByIdentifiers(
    modelRouteHealthMap,
    "ollama-cloud",
    "ollama-cloud/glm-5",
  );
  assert.deepEqual(entry, {
    state: "model_not_found",
    until: 2_000_000,
    retryCount: 1,
  });
});

test("lookupRouteHealthByIdentifiers_whenNoEntryExists_returnsUndefined", () => {
  // M67: a miss must return `undefined` so `buildRouteHealthEntry` /
  // `buildModelNotFoundRouteHealth` see the fresh-entry shape and start
  // the retry counter at 1 via `(existing?.retryCount ?? 0) + 1`.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const entry = lookupRouteHealthByIdentifiers(
    modelRouteHealthMap,
    "iflowcn",
    "kimi-k2-0905",
  );
  assert.equal(entry, undefined);
});

test("lookupRouteHealthByIdentifiers_whenLongcatEntryIsUnprefixed_findsCompositeKey", () => {
  // M67: the exact M30 drift shape. Writers canonicalize via
  // `composeRouteKey` so longcat entries land at "longcat/LongCat-Flash-Chat"
  // regardless of whether the registry model was stored with or without
  // the `longcat/` prefix. The lookup helper must normalize the same way
  // so a read for `{provider: "longcat", model: "LongCat-Flash-Chat"}`
  // still finds the composite-keyed entry.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    [
      "longcat/LongCat-Flash-Chat",
      { state: "quota", until: 3_000_000, retryCount: 5 },
    ],
  ]);
  const entry = lookupRouteHealthByIdentifiers(
    modelRouteHealthMap,
    "longcat",
    "LongCat-Flash-Chat",
  );
  assert.deepEqual(entry, { state: "quota", until: 3_000_000, retryCount: 5 });
});

test("findLiveRoutePenalty_whenMapEmpty_returnsNull", () => {
  // M70 boundary pin: no entry at all → null, regardless of `now`.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  const result = findLiveRoutePenalty(
    modelRouteHealthMap,
    "ollama-cloud",
    "glm-5",
    1_000_000,
  );
  assert.equal(result, null);
});

test("findLiveRoutePenalty_whenEntryExpired_returnsNull", () => {
  // M70 boundary pin: an entry whose `until` is at-or-before `now` is
  // treated as expired. `<=` matches `isRouteCurrentlyHealthy` and
  // `expireHealthMaps` so the helper is consistent with the rest of the
  // health-map machinery.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    ["ollama-cloud/glm-5", { state: "quota", until: 1_000_000, retryCount: 2 }],
  ]);
  const result = findLiveRoutePenalty(
    modelRouteHealthMap,
    "ollama-cloud",
    "glm-5",
    1_000_000,
  );
  assert.equal(result, null);
});

test("findLiveRoutePenalty_whenEntryLive_returnsEntry", () => {
  // M70 boundary pin: a live entry is returned verbatim so callers can
  // read `state`, `until`, and `retryCount` for scope reporting.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    ["ollama-cloud/glm-5", { state: "quota", until: 2_000_000, retryCount: 3 }],
  ]);
  const result = findLiveRoutePenalty(
    modelRouteHealthMap,
    "ollama-cloud",
    "glm-5",
    1_000_000,
  );
  assert.deepEqual(result, { state: "quota", until: 2_000_000, retryCount: 3 });
});

test("findLiveRoutePenalty_whenModelIsAlreadyCompositePrefixed_doesNotDoubleNest", () => {
  // M70 drift-shape pin: the helper must route through
  // `lookupRouteHealthByIdentifiers` (M67) so composite-key normalization
  // is shared with writers. Writers canonicalize via `composeRouteKey`,
  // which is idempotent: when the runtime model id ALREADY contains the
  // provider prefix (e.g. `{provider: "ollama-cloud", model: "ollama-cloud/glm-5"}`),
  // the stored key is `"ollama-cloud/glm-5"`, NOT
  // `"ollama-cloud/ollama-cloud/glm-5"`. A naive `${providerID}/${modelID}`
  // reader would build the double-nested key, miss the stored entry, and
  // report a live penalty as absent — exactly the M30 bug pattern this
  // test pins against.
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    ["ollama-cloud/glm-5", { state: "model_not_found", until: 9_000_000, retryCount: 1 }],
  ]);
  const result = findLiveRoutePenalty(
    modelRouteHealthMap,
    "ollama-cloud",
    "ollama-cloud/glm-5",
    1_000_000,
  );
  assert.deepEqual(result, { state: "model_not_found", until: 9_000_000, retryCount: 1 });
});

test("findLiveRoutePenalty_whenEntryLive_returnsTheInsertedObjectByReferenceIdentity", () => {
  // M110 drift pin 1/3 — return-by-reference, NOT a defensive copy.
  // Callers rely on reference identity to detect "same penalty as last
  // check" without deep-comparing, and to see later retry-count bumps
  // through the captured handle. A `{...routeHealth}` spread for
  // "safety" would still pass the pre-existing deepEqual pin but break
  // `===` identity. Parallel twin of the M104 provider-level surface.
  const insertedEntry: ModelRouteHealth = {
    state: "quota",
    until: 9_000_000,
    retryCount: 4,
  };
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    ["ollama-cloud/glm-5", insertedEntry],
  ]);
  const result = findLiveRoutePenalty(
    modelRouteHealthMap,
    "ollama-cloud",
    "glm-5",
    1_000_000,
  );
  assert.equal(result, insertedEntry);
});

test("findLiveRoutePenalty_whenEntryExpired_leavesMapUntouched", () => {
  // M110 drift pin 2/3 — read-only on expired hit. Deletion is the
  // job of `expireHealthMaps`, NOT findLive. A "helpful" cleanup-on-
  // read regression would still pass pin #2 (which only asserts the
  // null return) but would reset the retry-count escalation ladder
  // mid-turn. Parallel twin of the M104 provider-level surface.
  const expiredEntry: ModelRouteHealth = {
    state: "quota",
    until: 1_000_000,
    retryCount: 2,
  };
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    ["ollama-cloud/glm-5", expiredEntry],
  ]);
  const result = findLiveRoutePenalty(
    modelRouteHealthMap,
    "ollama-cloud",
    "glm-5",
    1_000_000,
  );
  assert.equal(result, null);
  // The expired entry MUST still be in the map under its original key.
  assert.equal(modelRouteHealthMap.size, 1);
  assert.equal(modelRouteHealthMap.get("ollama-cloud/glm-5"), expiredEntry);
});

test("findLiveRoutePenalty_whenMultiSegmentModelWithoutMatchingPrefix_wrapsIntoCompositeKey", () => {
  // M110 drift pin 3/3 — multi-segment non-prefixed model MUST be
  // wrapped, not passed through. Openrouter aggregator routes present
  // model ids like `"anthropic/claude-3.5-sonnet"` under
  // `provider="openrouter"`; the stored key is
  // `"openrouter/anthropic/claude-3.5-sonnet"` (three segments). The
  // pre-existing composite-idempotence pin uses a model whose prefix
  // already matches the provider, so wrap vs no-wrap looks identical.
  // A `if (model.includes("/")) return model;` simplification of
  // `composeRouteKey` would silently miss the stored entry for the
  // inverse case. This pin is the tripwire.
  const openrouterAggregatorEntry: ModelRouteHealth = {
    state: "model_not_found",
    until: 9_000_000,
    retryCount: 1,
  };
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>([
    ["openrouter/anthropic/claude-3.5-sonnet", openrouterAggregatorEntry],
  ]);
  const result = findLiveRoutePenalty(
    modelRouteHealthMap,
    "openrouter",
    "anthropic/claude-3.5-sonnet",
    1_000_000,
  );
  assert.deepEqual(result, {
    state: "model_not_found",
    until: 9_000_000,
    retryCount: 1,
  });
});

test("findLiveProviderPenalty_whenMapEmpty_returnsNull", () => {
  // M71 boundary pin: no entry → null regardless of `now`.
  const providerHealthMap = new Map<string, ProviderHealth>();
  const result = findLiveProviderPenalty(providerHealthMap, "openrouter", 1_000_000);
  assert.equal(result, null);
});

test("findLiveProviderPenalty_whenEntryExpired_returnsNull", () => {
  // M71 boundary pin: `until <= now` counts as expired (matches the
  // `findLiveRoutePenalty` M70 boundary and the rest of the expiry
  // machinery). The boundary tick `until === now` MUST return null.
  const providerHealthMap = new Map<string, ProviderHealth>([
    ["openrouter", { state: "quota", until: 1_000_000, retryCount: 2 }],
  ]);
  const result = findLiveProviderPenalty(providerHealthMap, "openrouter", 1_000_000);
  assert.equal(result, null);
});

test("findLiveProviderPenalty_whenEntryLive_returnsEntry", () => {
  // M71: live entry is returned verbatim so `computeRegistryEntryHealthReport`
  // can read `state` and `until` for scope reporting.
  const providerHealthMap = new Map<string, ProviderHealth>([
    ["openrouter", { state: "no_credit", until: 2_000_000, retryCount: 4 }],
  ]);
  const result = findLiveProviderPenalty(providerHealthMap, "openrouter", 1_000_000);
  assert.deepEqual(result, { state: "no_credit", until: 2_000_000, retryCount: 4 });
});

test("findLiveProviderPenalty_whenKeyMissingEntry_returnsEntryForAnyNow", () => {
  // M71 structural pin: key_missing state uses `until: Number.POSITIVE_INFINITY`
  // per `initializeProviderHealthState` (M58). The helper must treat it as
  // perpetually live so `isProviderHealthy` (which delegates to this helper)
  // returns false for uncredentialed providers — the whole reason M58
  // installs key_missing entries at boot. A regression that flipped the
  // boundary to `until < now` would still catch this (Infinity is not less
  // than any finite `now`), but a regression that swapped the condition to
  // `until > 0` or similar would break this pin.
  const providerHealthMap = new Map<string, ProviderHealth>([
    ["iflowcn", { state: "key_missing", until: Number.POSITIVE_INFINITY, retryCount: 0 }],
  ]);
  const result = findLiveProviderPenalty(providerHealthMap, "iflowcn", 9_999_999_999_999);
  assert.deepEqual(result, {
    state: "key_missing",
    until: Number.POSITIVE_INFINITY,
    retryCount: 0,
  });
});

test("findLiveProviderPenalty_whenEntryLive_returnsEntryByStrictReferenceNotCopy", () => {
  // M104 identity pin: the live-entry path must return the exact object
  // installed in the map, not a spread/clone. Callers (notably
  // `computeRegistryEntryHealthReport`) rely on reference stability so
  // later retryCount mutations by `computeProviderHealthUpdate` are
  // visible through the captured handle. A spread sabotage would still
  // pass every deepEqual pin but would silently break this invariant.
  const installedHealth: ProviderHealth = {
    state: "no_credit",
    until: 2_000_000,
    retryCount: 4,
  };
  const providerHealthMap = new Map<string, ProviderHealth>([
    ["openrouter", installedHealth],
  ]);
  const result = findLiveProviderPenalty(providerHealthMap, "openrouter", 1_000_000);
  assert.strictEqual(
    result,
    installedHealth,
    "live entry must be returned by strict reference, not as a defensive copy",
  );
});

test("findLiveProviderPenalty_whenEntryExpired_doesNotMutateInputMap", () => {
  // M104 read-only pin: the expired branch must leave the map
  // untouched. Cleanup is the sole responsibility of `expireHealthMaps`
  // (invoked once per chat turn). A regression that deleted the
  // expired entry on read would reset the retryCount escalation ladder
  // whenever an unrelated caller probed an expired entry mid-turn.
  const expiredHealth: ProviderHealth = {
    state: "quota",
    until: 500_000,
    retryCount: 3,
  };
  const providerHealthMap = new Map<string, ProviderHealth>([
    ["openrouter", expiredHealth],
  ]);
  const result = findLiveProviderPenalty(providerHealthMap, "openrouter", 1_000_000);
  assert.equal(result, null);
  assert.ok(
    providerHealthMap.has("openrouter"),
    "expired entry must remain in the map — findLive is read-only, expireHealthMaps owns cleanup",
  );
  assert.strictEqual(
    providerHealthMap.get("openrouter"),
    expiredHealth,
    "expired entry must be the same object — no silent replacement",
  );
});

test("findLiveProviderPenalty_whenProviderIdHasMixedCase_doesNotCaseFoldTheLookup", () => {
  // M104 exact-key pin: the helper must NOT normalize case. Provider
  // IDs are canonical slugs passed verbatim from session state by the
  // `provider.models` hook. Any defensive `.toLowerCase()` would still
  // pass the lowercase-ID pins but silently turn a mixed-case probe
  // into a false hit, which would bypass `isProviderHealthy` checks
  // for any caller that happened to capitalize the provider ID.
  const providerHealthMap = new Map<string, ProviderHealth>([
    ["openrouter", { state: "quota", until: 2_000_000, retryCount: 1 }],
  ]);
  const result = findLiveProviderPenalty(providerHealthMap, "OpenRouter", 1_000_000);
  assert.equal(
    result,
    null,
    "mixed-case provider ID must NOT match a lowercase map key — exact keying only",
  );
});

test("findRegistryEntryByModel_whenRuntimeIdIsRawAndRegistryIsComposite_returnsEntry", () => {
  // Common case: runtime delivers `{id: "glm-5", providerID: "ollama-cloud"}`
  // and registry route is composite "ollama-cloud/glm-5". Pin that the
  // shared `composeRouteKey` normalization keeps the common case green.
  const entries: ModelRegistryEntry[] = [
    buildModelRegistryEntry("glm-5", ["implementation_worker"], "strong", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5", priority: 1 },
    ]),
  ];

  const match = findRegistryEntryByModel(entries, {
    id: "glm-5",
    providerID: "ollama-cloud",
  });

  assert.ok(match);
  assert.equal(match?.id, "glm-5");
});

test("findRegistryEntryByModel_whenRuntimeIdIsRawAndRegistryIsUnprefixed_returnsEntry", () => {
  // Longcat-shape edge: runtime `{id: "LongCat-Flash-Chat", providerID: "longcat"}`
  // and registry authored WITHOUT the `longcat/` prefix. The old
  // defensive OR branch caught this; post-M47 it is now caught by
  // composeRouteKey normalizing BOTH sides to "longcat/LongCat-Flash-Chat".
  const entries: ModelRegistryEntry[] = [
    buildModelRegistryEntry("longcat-flash-chat", ["oracle"], "strong", [
      { provider: "longcat", model: "LongCat-Flash-Chat", priority: 1 },
    ]),
  ];

  const match = findRegistryEntryByModel(entries, {
    id: "LongCat-Flash-Chat",
    providerID: "longcat",
  });

  assert.ok(match);
  assert.equal(match?.id, "longcat-flash-chat");
});

test("findRegistryEntryByModel_whenRuntimeIdIsAlreadyCompositeAndRegistryIsUnprefixed_returnsEntry", () => {
  // Headline regression (M47): four-way shape cartesian worst case.
  // Runtime delivers an already-composite id (e.g. because an adjacent
  // plugin's `provider.models` hook rewrote it) AND the matching
  // registry row is authored without the `provider/` prefix. Old code
  // produced "longcat/longcat/LongCat-Flash-Chat" on the synthetic
  // composite path and `"LongCat-Flash-Chat" !== "longcat/LongCat-Flash-Chat"`
  // on the defensive branch — no match, entry dropped on the floor.
  // With `composeRouteKey` on both sides (idempotent via the
  // `.startsWith(${provider}/)` guard), both normalize to
  // "longcat/LongCat-Flash-Chat" and the entry is found.
  const entries: ModelRegistryEntry[] = [
    buildModelRegistryEntry("longcat-flash-chat", ["oracle"], "strong", [
      { provider: "longcat", model: "LongCat-Flash-Chat", priority: 1 },
    ]),
  ];

  const match = findRegistryEntryByModel(entries, {
    id: "longcat/LongCat-Flash-Chat",
    providerID: "longcat",
  });

  assert.ok(match);
  assert.equal(match?.id, "longcat-flash-chat");
});

test("findRegistryEntryByModel_whenRuntimeIdIsAlreadyCompositeAndRegistryIsComposite_returnsEntry", () => {
  // Fourth cartesian cell: both sides composite. Must still match
  // without the runtime side getting double-prefixed to
  // "ollama-cloud/ollama-cloud/glm-5".
  const entries: ModelRegistryEntry[] = [
    buildModelRegistryEntry("glm-5", ["implementation_worker"], "strong", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5", priority: 1 },
    ]),
  ];

  const match = findRegistryEntryByModel(entries, {
    id: "ollama-cloud/glm-5",
    providerID: "ollama-cloud",
  });

  assert.ok(match);
  assert.equal(match?.id, "glm-5");
});

test("findRegistryEntryByModel_whenRuntimeModelIsNotInRegistry_returnsUndefined", () => {
  // Negative pin: the post-M47 helper must still return undefined for
  // genuinely unknown models — the composeRouteKey reuse must not
  // accidentally become a catch-all match.
  const entries: ModelRegistryEntry[] = [
    buildModelRegistryEntry("glm-5", ["implementation_worker"], "strong", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5", priority: 1 },
    ]),
  ];

  const match = findRegistryEntryByModel(entries, {
    id: "unknown-model",
    providerID: "some-provider",
  });

  assert.equal(match, undefined);
});

test("computeRegistryEntryHealthReport_whenLongcatEntryIsUnprefixed_detectsRouteLevelPenaltyFromCompositeKey", () => {
  // Regression (M30): the longcat-flash-chat registry entry stores
  // `provider_order[0].model = "LongCat-Flash-Chat"` (unprefixed per
  // models.jsonc). The write path records penalties as the COMPOSITE
  // `"longcat/LongCat-Flash-Chat"` (session.error and
  // assistant.message.completed use `${providerID}/${model.id}`). The
  // read path used `.model` directly, so `modelRouteHealthMap.get(...)`
  // looked up "LongCat-Flash-Chat" and found nothing — agent-facing
  // health reports lied about longcat models being live when they were
  // provably dead. Post-fix: composeRouteKey normalizes reads.
  //
  // `computeRegistryEntryHealthReport` is the cleanest exported read
  // site to anchor this regression: `findCuratedFallbackRoute` can't
  // be used because longcat is also a substring-blocked fallback (see
  // `isFallbackBlocked`), which would filter the route for a different
  // reason and mask the regression.
  const now = Date.now();
  const entry: ModelRegistryEntry = {
    id: "longcat-flash-chat",
    enabled: true,
    description: "longcat-flash-chat",
    capability_tier: "strong",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: [],
    not_for: [],
    default_roles: ["implementation_worker"],
    provider_order: [
      { provider: "longcat", model: "LongCat-Flash-Chat", priority: 1 },
    ],
    notes: [],
  };
  // Write-side composite key — exactly what session.error would set.
  const modelRouteHealthMap = new Map([
    [
      "longcat/LongCat-Flash-Chat",
      { state: "model_not_found" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);

  const report = computeRegistryEntryHealthReport(
    entry,
    new Map(),
    modelRouteHealthMap,
    now,
  );

  assert.ok(report);
  assert.equal(report.state, "model_not_found");
  assert.equal(report.scope, "route");
});

test("isRouteCurrentlyHealthy_whenNeitherProviderNorRouteBlocked_returnsTrue", () => {
  const now = Date.now();
  const route = { provider: "opencode", model: "opencode/glm-5.1-free" };
  assert.equal(
    isRouteCurrentlyHealthy(route, new Map(), new Map(), now),
    true,
  );
});

test("isRouteCurrentlyHealthy_whenProviderKeyMissing_returnsFalse", () => {
  const now = Date.now();
  const route = { provider: "opencode", model: "opencode/glm-5.1-free" };
  const providerHealthMap = new Map([
    [
      "opencode",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
  ]);
  assert.equal(
    isRouteCurrentlyHealthy(route, providerHealthMap, new Map(), now),
    false,
  );
});

test("isRouteCurrentlyHealthy_whenProviderHealthExpired_returnsTrue", () => {
  // Stale provider penalty whose `until` is in the past is treated as
  // expired by isProviderHealthy. Pins that the helper does NOT do its
  // own naive `providerHealthMap.has(id)` check (the pre-M31 bug shape).
  const now = Date.now();
  const route = { provider: "opencode", model: "opencode/glm-5.1-free" };
  const providerHealthMap = new Map([
    [
      "opencode",
      { state: "quota" as const, until: now - 1000, retryCount: 1 },
    ],
  ]);
  assert.equal(
    isRouteCurrentlyHealthy(route, providerHealthMap, new Map(), now),
    true,
  );
});

test("isRouteCurrentlyHealthy_whenRouteLevelPenaltyActive_returnsFalse", () => {
  // Provider-level check passes but the composite route-health entry
  // blocks the specific route. Pins that the helper walks BOTH maps,
  // not just the provider one — same bug class as the M29/M31 cascade.
  const now = Date.now();
  const route = { provider: "openrouter", model: "openrouter/qwen/qwen3-coder:free" };
  const modelRouteHealthMap = new Map([
    [
      "openrouter/qwen/qwen3-coder:free",
      { state: "model_not_found" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  assert.equal(
    isRouteCurrentlyHealthy(route, new Map(), modelRouteHealthMap, now),
    false,
  );
});

test("isRouteCurrentlyHealthy_whenRouteLevelPenaltyExpired_returnsTrue", () => {
  const now = Date.now();
  const route = { provider: "openrouter", model: "openrouter/qwen/qwen3-coder:free" };
  const modelRouteHealthMap = new Map([
    [
      "openrouter/qwen/qwen3-coder:free",
      { state: "timeout" as const, until: now - 5_000, retryCount: 1 },
    ],
  ]);
  assert.equal(
    isRouteCurrentlyHealthy(route, new Map(), modelRouteHealthMap, now),
    true,
  );
});

test("isRouteCurrentlyHealthy_whenRouteKeyComposedFromPlainModelID_matchesComposedForm", () => {
  // longcat publishes `LongCat-Flash-Chat` as an unprefixed model id. The
  // canonical route key is `longcat/LongCat-Flash-Chat` (per
  // composeRouteKey). Pins that the helper normalizes via composeRouteKey
  // and finds the penalty regardless of whether the incoming route.model
  // was prefixed — same invariant that M31 fixed for the write-side.
  const now = Date.now();
  const route = { provider: "longcat", model: "LongCat-Flash-Chat" };
  const modelRouteHealthMap = new Map([
    [
      "longcat/LongCat-Flash-Chat",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  assert.equal(
    isRouteCurrentlyHealthy(route, new Map(), modelRouteHealthMap, now),
    false,
  );
});

test("findFirstHealthyRouteInEntry_whenNoVisibleRoutes_returnsNull", () => {
  // Entry with only hidden paid routes — filterVisibleProviderRoutes
  // removes them all, so the helper has nothing to scan.
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "hidden-only",
    ["architect"],
    "frontier",
    [
      { provider: "xai", model: "xai/grok-4", priority: 1 },
      { provider: "cerebras", model: "cerebras/llama4", priority: 2 },
    ],
  );
  assert.equal(
    findFirstHealthyRouteInEntry(entry, new Map(), new Map(), now),
    null,
  );
});

test("findFirstHealthyRouteInEntry_whenPrimaryHealthy_returnsPrimary", () => {
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const route = findFirstHealthyRouteInEntry(entry, new Map(), new Map(), now);
  assert.ok(route);
  assert.equal(route.provider, "opencode");
});

test("findFirstHealthyRouteInEntry_whenPrimaryBlockedButSiblingHealthy_returnsSibling", () => {
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const providerHealthMap = new Map([
    [
      "opencode",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
  ]);
  const route = findFirstHealthyRouteInEntry(
    entry,
    providerHealthMap,
    new Map(),
    now,
  );
  assert.ok(route);
  assert.equal(route.provider, "iflowcn");
});

test("findFirstHealthyRouteInEntry_whenEveryVisibleRouteBlocked_returnsNull", () => {
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const providerHealthMap = new Map([
    [
      "opencode",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
    [
      "iflowcn",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  assert.equal(
    findFirstHealthyRouteInEntry(entry, providerHealthMap, new Map(), now),
    null,
  );
});

test("findFirstHealthyRouteInEntry_whenPrimaryProviderHealthyButRouteLevelBlocked_returnsSibling", () => {
  // Route-level penalty (model_not_found, zero-token-quota, timeout)
  // must skip past the primary even though the primary's PROVIDER is
  // healthy. Regression shape for the M29/M30 class at this helper.
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const modelRouteHealthMap = new Map([
    [
      "opencode/glm-5.1-free",
      { state: "model_not_found" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  const route = findFirstHealthyRouteInEntry(
    entry,
    new Map(),
    modelRouteHealthMap,
    now,
  );
  assert.ok(route);
  assert.equal(route.provider, "iflowcn");
});

test("buildRoleRecommendationRoutes_whenEntryHasNoVisibleRoutes_returnsEmptyPayload", () => {
  // Defensive: a curated entry whose every route is hidden by
  // `filterVisibleProviderRoutes` (all paid/blocked providers) must
  // return `{primaryRoute: null, primaryHealthy: false,
  // alternativeRoutes: []}`. The tool handler relies on this shape so
  // the agent never sees a dangling `{ primaryRoute: undefined }` slot.
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "hidden-only",
    ["architect"],
    "frontier",
    [
      { provider: "togetherai", model: "togetherai/whatever", priority: 1 },
      { provider: "xai", model: "xai/grok-4", priority: 2 },
    ],
  );
  const result = buildRoleRecommendationRoutes(entry, new Map(), new Map(), now);
  assert.equal(result.primaryRoute, null);
  assert.equal(result.primaryHealthy, false);
  assert.deepEqual(result.alternativeRoutes, []);
});

test("buildRoleRecommendationRoutes_whenPrimaryHealthy_returnsPrimaryAndRestAsAlternatives", () => {
  // Clean happy path: primary visible route is healthy, so it's
  // returned as `primaryRoute` with `primaryHealthy: true` and every
  // other visible route lands in `alternativeRoutes`.
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 1 },
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 2 },
    ],
  );
  const result = buildRoleRecommendationRoutes(entry, new Map(), new Map(), now);
  assert.ok(result.primaryRoute);
  assert.equal(result.primaryRoute.provider, "iflowcn");
  assert.equal(result.primaryHealthy, true);
  assert.equal(result.alternativeRoutes.length, 1);
  assert.equal(result.alternativeRoutes[0]!.route.provider, "opencode");
});

test("buildRoleRecommendationRoutes_whenPrimaryKeyMissingButSiblingHealthy_returnsSiblingAsPrimary", () => {
  // Headline integration pin for M62. Post-M58 shipping shape:
  // `opencode/glm-5.1-free` primary with `iflowcn/glm-5.1` sibling,
  // opencode is key_missing at boot. Pre-M62, the tool reported the
  // opencode route as `primaryRoute` with `primaryProviderHealthy:
  // false` even though iflowcn was happily serving traffic. Agents
  // received a dead route in the single slot the tool is supposed to
  // populate with a working recommendation. Post-M62, the helper
  // promotes the first healthy route (iflowcn) to `primaryRoute`
  // with `primaryHealthy: true`, and the opencode route lands in
  // `alternativeRoutes` with `healthy: false` so the agent still sees
  // why it was demoted.
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const providerHealthMap = new Map([
    [
      "opencode",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
  ]);
  const result = buildRoleRecommendationRoutes(
    entry,
    providerHealthMap,
    new Map(),
    now,
  );
  assert.ok(result.primaryRoute);
  assert.equal(
    result.primaryRoute.provider,
    "iflowcn",
    "helper must promote the first healthy route to primary, not report the key_missing opencode route",
  );
  assert.equal(result.primaryHealthy, true);
  assert.equal(result.alternativeRoutes.length, 1);
  assert.equal(result.alternativeRoutes[0]!.route.provider, "opencode");
  assert.equal(
    result.alternativeRoutes[0]!.healthy,
    false,
    "demoted opencode route must still surface its unhealthy state in alternativeRoutes",
  );
});

test("buildRoleRecommendationRoutes_whenPrimaryRouteLevelBlockedButSiblingHealthy_returnsSibling", () => {
  // Route-level penalty on the primary (model_not_found / zero-token
  // quota / timeout) must also trigger the demotion, not just
  // provider-level health. Regression shape for the M29/M30 class at
  // the single-recommendation tool.
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const modelRouteHealthMap = new Map([
    [
      "opencode/glm-5.1-free",
      { state: "model_not_found" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  const result = buildRoleRecommendationRoutes(
    entry,
    new Map(),
    modelRouteHealthMap,
    now,
  );
  assert.ok(result.primaryRoute);
  assert.equal(result.primaryRoute.provider, "iflowcn");
  assert.equal(result.primaryHealthy, true);
  assert.equal(result.alternativeRoutes.length, 1);
  assert.equal(result.alternativeRoutes[0]!.route.provider, "opencode");
  assert.equal(result.alternativeRoutes[0]!.healthy, false);
});

test("buildRoleRecommendationRoutes_whenEveryVisibleRouteBlocked_fallsBackToFirstVisibleWithUnhealthyFlag", () => {
  // Defensive fallback: `selectBestModelForRoleAndTask` is supposed to
  // filter out entries where every visible route is blocked, but if
  // that contract ever cracks the helper must still return a
  // renderable shape — `primaryRoute = visibleRoutes[0]`,
  // `primaryHealthy = false`, and every remaining visible route in
  // `alternativeRoutes`. The agent still sees the block reason via
  // `primaryProviderHealthy: false` and can surface it to the user
  // instead of crashing on a null primary.
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const providerHealthMap = new Map([
    [
      "opencode",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
    [
      "iflowcn",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  const result = buildRoleRecommendationRoutes(
    entry,
    providerHealthMap,
    new Map(),
    now,
  );
  assert.ok(result.primaryRoute);
  assert.equal(
    result.primaryRoute.provider,
    "opencode",
    "with no healthy routes anywhere, fall back to visibleRoutes[0] so the shape stays renderable",
  );
  assert.equal(result.primaryHealthy, false);
  assert.equal(result.alternativeRoutes.length, 1);
  assert.equal(result.alternativeRoutes[0]!.route.provider, "iflowcn");
  assert.equal(result.alternativeRoutes[0]!.healthy, false);
});

test("computeRegistryEntryHealthReport_whenPrimaryKeyMissingButSiblingHealthy_returnsNull", () => {
  // Headline integration pin for M61. Post-M58 shape: a curated entry
  // whose primary visible route lives on an uncredentialed provider
  // (opencode in this test — freshly-booted plugin with no oauth) and
  // whose secondary visible route lives on a credentialed provider
  // (iflowcn). The router would transparently use iflowcn. Pre-M61,
  // the report returned `{state: "key_missing", until: "never", scope:
  // "provider"}` and any agent calling `list_curated_models` saw the
  // entry as permanently blocked. Post-M61, return null — the entry
  // is routable, there is nothing to report.
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const providerHealthMap = new Map([
    [
      "opencode",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
  ]);
  const report = computeRegistryEntryHealthReport(
    entry,
    providerHealthMap,
    new Map(),
    now,
  );
  assert.equal(
    report,
    null,
    "entry with a healthy visible sibling must not be reported as blocked",
  );
});

test("computeRegistryEntryHealthReport_whenEveryVisibleRouteKeyMissing_reportsProviderScope", () => {
  // Sibling pin for M61. All visible routes' providers are key_missing —
  // the entry is genuinely unusable, and the report must surface that
  // so the agent understands WHY it can't be routed to. Prevents the
  // fix from regressing into "always return null when any key_missing
  // is present on the primary".
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const providerHealthMap = new Map([
    [
      "opencode",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
    [
      "iflowcn",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
  ]);
  const report = computeRegistryEntryHealthReport(
    entry,
    providerHealthMap,
    new Map(),
    now,
  );
  assert.ok(report);
  assert.equal(report.state, "key_missing");
  assert.equal(report.until, "never");
  assert.equal(report.scope, "provider");
});

test("computeRegistryEntryHealthReport_whenPrimaryTransientQuotaButSiblingHealthy_returnsNull", () => {
  // M61 behavior change: transient penalties on the primary ALSO stop
  // being reported when a healthy sibling exists. The rationale is the
  // same as the key_missing case — the router is actually going to
  // use the sibling, so the entry is functionally healthy. An agent
  // reading `list_curated_models` cares about "can I route to this"
  // not "which specific route is alive right now". Prevents a subtle
  // regression where the M61 fix was narrowed to only filter
  // key_missing and transient penalties continued to over-report.
  const now = Date.now();
  const entry: ModelRegistryEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const providerHealthMap = new Map([
    [
      "opencode",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  const report = computeRegistryEntryHealthReport(
    entry,
    providerHealthMap,
    new Map(),
    now,
  );
  assert.equal(report, null);
});

test("selectBestModelForRoleAndTask_whenLongTaskPromptContainsBestForToken_keepsMatchingCandidate", () => {
  // Headline regression (M46): the task-filter substring direction was
  // reversed. `bf.toLowerCase().includes(lowerTask)` asked "does the
  // short best_for label contain the entire long prompt" — virtually
  // never true on real traffic, so the `best` branch filtered out
  // every candidate on every realistic prompt and control always fell
  // through to the last-resort scan (bypassing tier + billing ranking).
  // Correct direction: does the task prompt mention the best_for
  // label. This test pins that a realistic multi-sentence prompt that
  // mentions "coding" as one word matches a candidate whose best_for
  // includes "coding".
  const now = Date.now();
  const candidate: ModelRegistryEntry = {
    id: "qwen3-coder",
    enabled: true,
    description: "qwen3-coder",
    capability_tier: "strong",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: ["coding", "refactor"],
    not_for: [],
    default_roles: ["implementation_worker"],
    provider_order: [
      { provider: "ollama-cloud", model: "ollama-cloud/qwen3-coder", priority: 1 },
    ],
    notes: [],
  };

  const best = selectBestModelForRoleAndTask(
    [candidate],
    new Map(),
    new Map(),
    now,
    null,
    "Please investigate the streaming cancellation bug in our coding agent's token counter and land a minimal fix with a regression test.",
    null,
  );

  assert.ok(best);
  assert.equal(best.id, "qwen3-coder");
});

test("selectBestModelForRoleAndTask_whenTaskPromptMentionsNoBestForTokenOrRole_returnsNull", () => {
  // Negative regression (M46): symmetric pin that the task filter
  // STILL filters when there's genuinely no overlap. Previously the
  // test suite couldn't tell if the filter was always-on or always-off
  // because the existing happy-path tests passed via fall-through to
  // last-resort. With the reversed direction, a prompt with no overlap
  // against best_for or default_roles must return null — letting
  // recommendTaskModelRoute's last-resort branch take over cleanly.
  const now = Date.now();
  const candidate: ModelRegistryEntry = {
    id: "qwen3-coder",
    enabled: true,
    description: "qwen3-coder",
    capability_tier: "strong",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: ["coding", "refactor"],
    not_for: [],
    default_roles: ["implementation_worker"],
    provider_order: [
      { provider: "ollama-cloud", model: "ollama-cloud/qwen3-coder", priority: 1 },
    ],
    notes: [],
  };

  const best = selectBestModelForRoleAndTask(
    [candidate],
    new Map(),
    new Map(),
    now,
    null,
    "deploy the staging kubernetes cluster and rotate the database credentials",
    null,
  );

  assert.equal(best, null);
});

test("selectBestModelForRoleAndTask_whenCandidateHasDeadVisibleRoutes_ranksLowerThanCandidateWithLiveRoutes", () => {
  // Regression (M31): ranking previously only counted provider-level
  // unhealthy routes. Two candidates at the same capability tier and
  // billing mode — one with its single visible route dead at the route
  // level (model_not_found) and one with its single visible route fully
  // live — were ranked equal, and sort stability picked the first. With
  // route health in the counter, the all-live candidate wins correctly.
  const now = Date.now();
  const deadCandidate: ModelRegistryEntry = {
    id: "dead-route-strong",
    enabled: true,
    description: "dead-route-strong",
    capability_tier: "strong",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: ["coding"],
    not_for: [],
    default_roles: ["implementation_worker"],
    provider_order: [
      { provider: "iflowcn", model: "iflowcn/dead-strong", priority: 1 },
    ],
    notes: [],
  };
  const liveCandidate: ModelRegistryEntry = {
    id: "live-route-strong",
    enabled: true,
    description: "live-route-strong",
    capability_tier: "strong",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: ["coding"],
    not_for: [],
    default_roles: ["implementation_worker"],
    provider_order: [
      { provider: "ollama-cloud", model: "ollama-cloud/live-strong", priority: 1 },
    ],
    notes: [],
  };
  const modelRouteHealthMap = new Map([
    [
      "iflowcn/dead-strong",
      { state: "model_not_found" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);

  // Deliberately pass deadCandidate first so sort stability would favor
  // it under the old provider-only counter.
  const best = selectBestModelForRoleAndTask(
    [deadCandidate, liveCandidate],
    new Map(),
    modelRouteHealthMap,
    now,
    "implementation_worker",
    null,
    "strong",
  );

  assert.ok(best);
  assert.equal(best.id, "live-route-strong");
});

test("recommendTaskModelRoute_whenLastResortMustSkipRouteLevelDeadRoute_returnsNextHealthyRoute", async () => {
  // Regression (M32): the "last resort" loop at the end of
  // recommendTaskModelRoute previously only checked provider health. If
  // the `best` branch returned null (task filter eliminated all
  // candidates) and the first visible route of the first role-matched
  // entry was provider-healthy but route-level dead (model_not_found,
  // zero-token quota, hang timeout), it was returned as the "healthy
  // visible route" and the caller got a route that was guaranteed to
  // fail on inference. Same bug class as M29/M31 at the terminal path.
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "aicoder-model-routing-"));

  // No agent metadata → preferredModels=[], role=null. Pair this with a
  // task prompt that cannot match any candidate's best_for/default_roles
  // substring, so selectBestModelForRoleAndTask returns null and control
  // falls through to the last-resort scan.
  const modelRouteHealthMap = new Map([
    [
      "iflowcn/dead-last-resort",
      { state: "model_not_found" as const, until: Date.now() + 60_000, retryCount: 1 },
    ],
  ]);

  const decision = await recommendTaskModelRoute(
    tempDirectory,
    {
      subagent_type: "zzz_nonexistent_agent",
      prompt: "zzz_completely_orthogonal_task_description_nothing_matches",
      complexity: "large",
    },
    [
      buildModelRegistryEntry("last-resort-entry", ["implementation_worker"], "strong", [
        { provider: "iflowcn", model: "iflowcn/dead-last-resort", priority: 1 },
        { provider: "ollama-cloud", model: "ollama-cloud/live-last-resort", priority: 2 },
      ]),
    ],
    new Map(),
    modelRouteHealthMap,
    Date.now(),
  );

  assert.equal(decision.selectedModelRoute, "ollama-cloud/live-last-resort");
  assert.match(decision.reasoning, /Fallback to first healthy visible route/);
});

test("filterProviderModelsByRouteHealth_whenRawModelHasRouteLevelPenalty_isExcludedFromOpencodeModelMap", () => {
  // Regression: the openrouter `provider.models` hook used to only consult
  // `providerHealthMap` for the provider as a whole. A specific route with
  // a route-level penalty (model_not_found, zero-token quota, hang timeout)
  // was still returned to opencode's router as available, and the router
  // would pick it, fail, re-record the penalty, and loop — the penalty was
  // effectively invisible at the only layer where opencode actually routes.
  const enabledRawModelIDs = new Set(["xiaomi/mimo-v2-pro", "stepfun/step-3.5-flash:free"]);
  const providerModels = {
    "xiaomi/mimo-v2-pro": { id: "xiaomi/mimo-v2-pro", label: "paid" },
    "stepfun/step-3.5-flash:free": { id: "stepfun/step-3.5-flash:free", label: "free" },
    "never-enabled-model": { id: "never-enabled-model", label: "not in registry" },
  };
  const modelRouteHealthMap = new Map([
    ["openrouter/xiaomi/mimo-v2-pro", {
      state: "model_not_found" as const,
      until: Date.now() + 60_000,
      retryCount: 1,
    }],
  ]);

  const filtered = filterProviderModelsByRouteHealth(
    providerModels,
    enabledRawModelIDs,
    "openrouter",
    modelRouteHealthMap,
    Date.now(),
  );

  assert.deepEqual(
    Object.keys(filtered).sort(),
    ["stepfun/step-3.5-flash:free"],
    "route-penalized model should be excluded; healthy free route should remain; never-enabled should be excluded",
  );
});

test("filterProviderModelsByRouteHealth_whenRouteLevelPenaltyHasExpired_keepsModelAvailable", () => {
  // Symmetry check: an expired penalty (until <= now) must NOT block the
  // route. The expireHealthMaps sweep eventually deletes it, but between
  // sweeps the filter is the gate readers see — it must treat `until <= now`
  // as "penalty lifted" or the plugin races itself.
  const enabledRawModelIDs = new Set(["stepfun/step-3.5-flash:free"]);
  const providerModels = {
    "stepfun/step-3.5-flash:free": { id: "stepfun/step-3.5-flash:free" },
  };
  const now = Date.now();
  const modelRouteHealthMap = new Map([
    ["openrouter/stepfun/step-3.5-flash:free", {
      state: "model_not_found" as const,
      until: now - 1, // already expired
      retryCount: 1,
    }],
  ]);

  const filtered = filterProviderModelsByRouteHealth(
    providerModels,
    enabledRawModelIDs,
    "openrouter",
    modelRouteHealthMap,
    now,
  );

  assert.deepEqual(Object.keys(filtered), ["stepfun/step-3.5-flash:free"]);
});

test("inferTaskComplexity_whenPromptContainsCarefullyUnrelatedToFull_doesNotClassifyAsLarge", () => {
  // Regression: the previous implementation used `.includes()` substring
  // matching, so "carefully" (which contains "full" as an inner substring)
  // flipped a trivial review task into the large/frontier tier, wasting
  // expensive routing on what should be medium or small.
  // Post-M50: the prompt also mentions "typo", which is now a `small`
  // signal (previously unreachable — the `small` row in the tierMap was
  // dead code before M50 added the SMALL_COMPLEXITY regex path). The
  // test intent is unchanged ("don't classify as large") so small is
  // the more correct answer here — a typo fix is the canonical small
  // task and the tiny/fast tier was specifically sized for this shape.
  assert.equal(
    inferTaskComplexity(
      "Please carefully review this one-line typo fix in the README.",
      null,
    ),
    "small",
  );
});

test("inferTaskComplexity_whenPromptContainsBeautifullyUnrelatedToFull_doesNotClassifyAsLarge", () => {
  // Additional word-boundary coverage: "beautifully" contains the literal
  // 4-char "full" as an inner substring. The old `.includes("full")` check
  // flipped this to large; the leading-boundary regex must not.
  assert.equal(
    inferTaskComplexity(
      "beautifully format this one-liner",
      null,
    ),
    "medium",
  );
});

test("inferTaskComplexity_whenPromptUsesRefactoringInflection_stillClassifiesAsLarge", () => {
  // Word-boundary is LEADING only so inflections still match: "refactoring",
  // "refactored", "systems", "completed" should all count as large signals.
  assert.equal(
    inferTaskComplexity(
      "I'm refactoring the authentication module",
      null,
    ),
    "large",
  );
});

test("inferTaskComplexity_whenPromptUsesEndToEndLiteralPhrase_classifiesAsLarge", () => {
  // `end-to-end` contains a hyphen which is not a JS word char; it is
  // matched via a literal substring check, not the regex path.
  assert.equal(
    inferTaskComplexity(
      "Write an end-to-end test for the checkout flow",
      null,
    ),
    "large",
  );
});

test("inferTaskComplexity_whenPromptMentionsTypo_classifiesAsSmall", () => {
  // Dead-row regression pin: the tierMap declared a `small` row but
  // `inferTaskComplexity` never produced it. Trivial mechanical prompts
  // like "fix typo" got routed into the medium tier (standard+strong)
  // when they should land in the tiny+fast+standard tier. This pin
  // fires if a future refactor drops the SMALL regex path entirely.
  assert.equal(
    inferTaskComplexity("Fix typo in README", null),
    "small",
  );
});

test("inferTaskComplexity_whenPromptMentionsRename_classifiesAsSmall", () => {
  // Mechanical rename is a bounded local change — does not warrant
  // frontier/strong-tier capacity.
  assert.equal(
    inferTaskComplexity("Rename foo to bar in the user module", null),
    "small",
  );
});

test("inferTaskComplexity_whenPromptMentionsRenamesInflection_stillClassifiesAsSmall", () => {
  // Leading word boundary only — the regex must still match inflections
  // like "renames" / "renaming" / "renamed". Mirrors the corresponding
  // inflection regression pin for `refactoring`.
  assert.equal(
    inferTaskComplexity(
      "This commit renames the config key and updates two call sites",
      null,
    ),
    "small",
  );
});

test("inferTaskComplexity_whenPromptMentionsTrivial_classifiesAsSmall", () => {
  // Explicit operator signal — "trivial" as a hint from a human author
  // should be honored.
  assert.equal(
    inferTaskComplexity("Trivial fix for the dead link in docs", null),
    "small",
  );
});

test("inferTaskComplexity_whenPromptMentionsWhitespace_classifiesAsSmall", () => {
  // Deliberately avoid LARGE stems like "across" in the prompt so the
  // SMALL path is the only one that trips. "Strip trailing whitespace
  // across touched files" would land in `large` via the `across` stem.
  assert.equal(
    inferTaskComplexity("Strip trailing whitespace in config.yaml", null),
    "small",
  );
});

test("inferTaskComplexity_whenPromptMentionsMinor_classifiesAsSmall", () => {
  // "minor" is a common author signal for bounded edits.
  assert.equal(
    inferTaskComplexity("Minor version bump in package.json", null),
    "small",
  );
});

test("inferTaskComplexity_whenPromptMentionsBothTypoAndFix_prefersSmallOverMedium", () => {
  // Tie-break pin: "fix typo" matches BOTH medium ("fix") and small
  // ("typo"). Small must win because the SMALL check runs before MEDIUM
  // in the cascade — otherwise a trivial mechanical op would silently
  // keep routing to standard+strong capacity.
  assert.equal(
    inferTaskComplexity("Fix typo in the error message", null),
    "small",
  );
});

test("inferTaskComplexity_whenPromptMentionsRefactorAndRename_prefersLargeOverSmall", () => {
  // Scope-dominance pin: a prompt that mentions both a large-scope
  // signal (`refactor`) and a small-scope mechanic (`rename`) must
  // classify as large. The rename is the mechanic, the refactor is
  // the scope — scope dominates.
  assert.equal(
    inferTaskComplexity(
      "Refactor and rename the payments module across services",
      null,
    ),
    "large",
  );
});

test("isFallbackBlocked_whenModelIsGptOssOpenWeights_returnsFalse", () => {
  // Headline regression pin: the previous bare-substring list blocked
  // any model id containing `"gpt"`, which over-matched the legitimate
  // free open-weights models `gpt-oss:120b` and `gpt-oss:20b` hosted
  // on ollama-cloud. The catalog explicitly recommends gpt-oss:120b for
  // A/B cross-checks, so the old substring list silently collapsed one
  // lineage of diversity. The regex form requires a digit after the
  // `gpt-?` anchor, so `gpt-oss` (word suffix) is allowed through.
  assert.equal(
    isFallbackBlocked("ollama-cloud", "ollama-cloud/gpt-oss:120b"),
    false,
  );
  assert.equal(
    isFallbackBlocked("ollama-cloud", "ollama-cloud/gpt-oss:20b"),
    false,
  );
});

test("isFallbackBlocked_whenModelIsProprietaryOpenAIWithDigit_returnsTrue", () => {
  // Negative of the regression pin: proprietary OpenAI versions
  // (numbered suffixes) must still be blocked, even when reached
  // through an aggregator whose provider id is not on the blocklist.
  assert.equal(
    isFallbackBlocked("openrouter", "openrouter/openai/gpt-4"),
    true,
  );
  assert.equal(
    isFallbackBlocked("openrouter", "openrouter/openai/gpt-5.3-codex-spark"),
    true,
  );
  assert.equal(
    isFallbackBlocked("openrouter", "openrouter/openai/gpt-5.4"),
    true,
  );
});

test("isFallbackBlocked_whenModelIsChatgptVariant_returnsTrue", () => {
  // Separate `chatgpt` pattern — stays blocked regardless of digit.
  assert.equal(
    isFallbackBlocked("openrouter", "openrouter/openai/chatgpt-4o-latest"),
    true,
  );
});

test("isFallbackBlocked_whenModelIsClaude_returnsTrue", () => {
  // `claude` is a single-brand name — no ambiguity, blocked on the
  // plain anchored pattern.
  assert.equal(
    isFallbackBlocked("openrouter", "openrouter/anthropic/claude-opus-4-6"),
    true,
  );
});

test("isFallbackBlocked_whenModelIsProprietaryGrok_returnsTrue", () => {
  // xAI's proprietary brand always uses numbered versions, mirrored
  // shape to the gpt pattern.
  assert.equal(
    isFallbackBlocked("openrouter", "openrouter/xai/grok-4-fast"),
    true,
  );
  assert.equal(
    isFallbackBlocked("openrouter", "openrouter/xai/grok-4-heavy"),
    true,
  );
});

test("isFallbackBlocked_whenModelContainsGrokAsInnerWordWithoutDigit_returnsFalse", () => {
  // Defensive pin: the regex requires a digit after `grok-?`, so
  // hypothetical future open-weights releases using word suffixes
  // (e.g. `grok-oss`) would not be collateral-blocked the way
  // `gpt-oss` was. Not a currently-reachable model — this pins the
  // word-boundary invariant so a future refactor that loosens the
  // regex fires this test first.
  assert.equal(
    isFallbackBlocked("ollama-cloud", "ollama-cloud/grok-oss"),
    false,
  );
});

test("isFallbackBlocked_whenProviderIsLongcat_returnsTrueRegardlessOfModel", () => {
  // Provider-id blocklist still takes precedence — the longcat direct
  // endpoint is blocked even if the model id itself is mundane.
  assert.equal(
    isFallbackBlocked("longcat", "LongCat-Flash-Chat"),
    true,
  );
  assert.equal(
    isFallbackBlocked("longcat-openai", "whatever"),
    true,
  );
});

test("isFallbackBlocked_whenModelContainsLongcatViaAggregator_returnsTrue", () => {
  // Aggregator path: provider id `openrouter` is permitted in general,
  // but the specific model still routes to longcat and must be
  // excluded from fallback. Pattern-list fires via the plain `longcat`
  // anchor.
  assert.equal(
    isFallbackBlocked("openrouter", "openrouter/meituan/longcat-flash-chat"),
    true,
  );
});

test("isFallbackBlocked_whenModelIsUnrelated_returnsFalse", () => {
  // Sanity: ordinary curated models must pass through. Guards against
  // an over-eager pattern refactor that accidentally matches common
  // characters.
  assert.equal(
    isFallbackBlocked("ollama-cloud", "ollama-cloud/glm-5"),
    false,
  );
  assert.equal(
    isFallbackBlocked("ollama-cloud", "ollama-cloud/kimi-k2-thinking"),
    false,
  );
  assert.equal(
    isFallbackBlocked("ollama-cloud", "ollama-cloud/qwen3-coder:480b"),
    false,
  );
});

test("inferTaskComplexity_whenPromptUnrelatedToAnyStem_defaultsToMedium", () => {
  // Default-medium regression pin: prompts without any keyword signal
  // still land in medium, not small. This ensures adding the SMALL
  // path did not shift the default bucket to small (which would
  // silently downgrade every unspecified task).
  assert.equal(
    inferTaskComplexity("Please proceed with the analysis", null),
    "medium",
  );
});

test("computeProviderHealthUpdate_whenExistingLongerPenalty_preservesExistingStateAndUntil", () => {
  // Regression: a 1h quota error fired against a provider already in a 2h
  // no_credit penalty used to OVERWRITE the longer lockout with the
  // shorter one, causing premature retries on a provider the plugin
  // already knew was broken for longer.
  const now = Date.now();
  const existing = {
    state: "no_credit" as const,
    until: now + 2 * 60 * 60 * 1000, // 2h from now
    retryCount: 1,
  };
  const newUntil = now + 60 * 60 * 1000; // 1h from now — SHORTER

  const next = computeProviderHealthUpdate(existing, "quota", newUntil);

  assert.equal(next.state, "no_credit", "preserve the longer-lived state");
  assert.equal(next.until, existing.until, "preserve the longer-lived until");
  assert.equal(next.retryCount, 2, "still bump retryCount so repeat failures remain observable");
});

test("computeProviderHealthUpdate_whenKeyMissingInfinityExists_doesNotDowngradeToQuotaFinite", () => {
  // key_missing has until=Infinity — any finite penalty is strictly shorter
  // and must not be able to overwrite it. Without this check, a spurious
  // 429 while a provider is already flagged key_missing would flip the
  // entry to quota+1h, silently unblocking a provider that has no
  // credentials at all.
  const existing = {
    state: "key_missing" as const,
    until: Number.POSITIVE_INFINITY,
    retryCount: 0,
  };

  const next = computeProviderHealthUpdate(existing, "quota", Date.now() + 60 * 60 * 1000);

  assert.equal(next.state, "key_missing");
  assert.equal(next.until, Number.POSITIVE_INFINITY);
  assert.equal(next.retryCount, 1);
});

test("computeProviderHealthUpdate_whenIncomingIsLonger_acceptsIncoming", () => {
  // Symmetry: if the incoming penalty would extend the lockout (e.g.
  // quota → no_credit on a provider that just crossed from 429 to 402),
  // we accept the LONGER one. retryCount still increments.
  const now = Date.now();
  const existing = {
    state: "quota" as const,
    until: now + 60 * 60 * 1000, // 1h from now
    retryCount: 3,
  };
  const newUntil = now + 2 * 60 * 60 * 1000; // 2h from now — LONGER

  const next = computeProviderHealthUpdate(existing, "no_credit", newUntil);

  assert.equal(next.state, "no_credit");
  assert.equal(next.until, newUntil);
  assert.equal(next.retryCount, 4);
});

test("computeProviderHealthUpdate_whenNoExistingEntry_createsFreshRecord", () => {
  const newUntil = Date.now() + 60 * 60 * 1000;

  const next = computeProviderHealthUpdate(undefined, "quota", newUntil);

  assert.equal(next.state, "quota");
  assert.equal(next.until, newUntil);
  assert.equal(next.retryCount, 1);
});

test("computeProviderHealthUpdate_whenPreserveBranchTaken_returnsFreshObjectNotExistingByReference", () => {
  // M106 PDD surface 1: the preserve-longer branch must allocate a fresh
  // record. A naive `return existing;` would pass shallow field checks in
  // some sabotage forms but leak a shared handle that later writers could
  // mutate retroactively.
  const now = Date.now();
  const existing = {
    state: "no_credit" as const,
    until: now + 2 * 60 * 60 * 1000,
    retryCount: 1,
  };

  const next = computeProviderHealthUpdate(existing, "quota", now + 60 * 60 * 1000);

  assert.ok(next !== existing, "preserve branch must return a fresh object, not the input by reference");
});

test("computeProviderHealthUpdate_whenExistingUntilEqualsNewUntil_takesNewPathAcceptingNewState", () => {
  // M106 PDD surface 2: the condition is STRICT `existing.until > newUntil`,
  // so equal-until means the incoming classification wins. A drift to `>=`
  // would silently preserve the stale state on ties between two writers
  // that compute the same `now + 1h` boundary in the same tick.
  const now = Date.now();
  const sharedUntil = now + 60 * 60 * 1000;
  const existing = {
    state: "quota" as const,
    until: sharedUntil,
    retryCount: 2,
  };

  const next = computeProviderHealthUpdate(existing, "no_credit", sharedUntil);

  assert.equal(next.state, "no_credit", "equal-until must accept incoming state, not preserve existing");
});

test("computeProviderHealthUpdate_whenNewPathTaken_doesNotMutateInputExistingRecord", () => {
  // M106 PDD surface 3: neither branch may mutate `existing`. A refactor to
  // `Object.assign(existing, {...})` in the new-path branch would pass
  // every field-equality pin (Object.assign returns its first argument with
  // the right fields) while silently corrupting any caller that held a
  // pre-call handle to `existing` for logging, diffing, or metric emission.
  const now = Date.now();
  const existing = {
    state: "quota" as const,
    until: now + 60 * 60 * 1000,
    retryCount: 3,
  };

  computeProviderHealthUpdate(existing, "no_credit", now + 2 * 60 * 60 * 1000);

  assert.equal(existing.state, "quota", "new-path must not mutate the input existing record");
});

test("formatHealthExpiry_whenUntilIsNaN_returnsWithoutThrowingRangeError", () => {
  // M116 pin A: `!Number.isFinite(until)` must reject NaN as well as
  // both infinities. A refactor narrowing the guard to
  // `until === Number.POSITIVE_INFINITY` would let NaN fall through to
  // `new Date(NaN).toISOString()`, which throws `RangeError: Invalid
  // time value` — the exact M58 crash this helper was extracted to
  // prevent. Asserting "does not throw on NaN" fires only on that
  // narrowing because the ISO-branch and sentinel-string pins both
  // receive inputs that take the finite branch under the sabotage.
  let formatted: string | undefined;
  assert.doesNotThrow(() => {
    formatted = formatHealthExpiry(Number.NaN);
  });
  assert.equal(typeof formatted, "string");
});

test("formatHealthExpiry_whenUntilIsFiniteEpoch_returnsIso8601FormattedString", () => {
  // M116 pin B: finite-epoch formatting contract is ISO-8601 via
  // `toISOString()`. Downstream log parsers, `get_quota_backoff_status`
  // JSON consumers, and `buildProviderHealthSummaryForTool` synopsis
  // readers all assume RFC 3339 shape `YYYY-MM-DDTHH:MM:SS.sssZ`. A
  // refactor to `toUTCString()` produces `"Thu, 01 Jan 1970 ..."` which
  // looks cosmetically similar in one log line but silently breaks
  // every downstream parser. The regex pins the exact ISO-8601 shape.
  const fixedEpochMs = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  const formatted = formatHealthExpiry(fixedEpochMs);
  assert.match(
    formatted,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    `expected ISO-8601 "YYYY-MM-DDTHH:MM:SS.sssZ" but got ${JSON.stringify(formatted)}`,
  );
});

test("formatHealthExpiry_whenInfiniteUntil_roundTripsThroughParsePersistedHealthEntry", () => {
  // M116 pin C: `formatHealthExpiry` and `parsePersistedHealthEntry`
  // share the `"never"` sentinel as the ONLY string value that crosses
  // the persistence boundary for Infinity `until`. A drift of the
  // literal on either side (write-side to `"forever"`, `"infinity"`,
  // `"∞"`, or the empty string) silently breaks `key_missing`
  // persistence: the next plugin restart fails the `rawUntil ===
  // "never"` check, falls into `typeof rawUntil === "number"` (also
  // false), and `parsePersistedHealthEntry` returns `null` → the entry
  // is dropped and a missing-credential provider is treated as healthy.
  // The round-trip through the live parser pins the exact string.
  const formatted = formatHealthExpiry(Number.POSITIVE_INFINITY);
  const persisted = {
    state: "key_missing",
    until: formatted,
    retryCount: 0,
  };
  const parsed = parsePersistedHealthEntry(persisted, Date.now());
  assert.ok(parsed, "Infinity sentinel must round-trip through parsePersistedHealthEntry");
  assert.equal(parsed.until, Number.POSITIVE_INFINITY);
  assert.equal(parsed.state, "key_missing");
});

test("parsePersistedHealthEntry_whenEntryIsWellFormed_returnsNormalizedRecord", () => {
  const now = Date.now();
  const entry = {
    state: "no_credit",
    until: now + 2 * 60 * 60 * 1000,
    retryCount: 3,
  };

  const parsed = parsePersistedHealthEntry(entry, now);

  assert.ok(parsed, "valid entry should parse");
  assert.equal(parsed.state, "no_credit");
  assert.equal(parsed.until, entry.until);
  assert.equal(parsed.retryCount, 3);
});

test("parsePersistedHealthEntry_whenUntilIsNeverLiteral_normalizesToInfinity", () => {
  const entry = { state: "key_missing", until: "never", retryCount: 0 };

  const parsed = parsePersistedHealthEntry(entry, Date.now());

  assert.ok(parsed);
  assert.equal(parsed.until, Number.POSITIVE_INFINITY);
  assert.equal(parsed.state, "key_missing");
});

test("parsePersistedHealthEntry_whenEntryIsNull_returnsNullWithoutThrowing", () => {
  // Regression: a single null entry in the persisted JSON used to throw
  // when the load loop reached `health.until`, the outer catch swallowed
  // it, and EVERY valid sibling entry was lost on plugin restart.
  const parsed = parsePersistedHealthEntry(null, Date.now());
  assert.equal(parsed, null);
});

test("parsePersistedHealthEntry_whenStateIsUnknown_returnsNull", () => {
  // Schema drift: an older plugin version wrote a state this version
  // doesn't recognize. Reject the entry rather than silently loading it
  // into the runtime union-typed map where it would violate invariants
  // that readers rely on (e.g. `healthStateLabel` switch arms).
  const entry = { state: "future_unknown_state", until: Date.now() + 1000, retryCount: 0 };

  const parsed = parsePersistedHealthEntry(entry, Date.now());

  assert.equal(parsed, null);
});

test("parsePersistedHealthEntry_whenUntilIsCorruptString_returnsNullInsteadOfZombie", () => {
  // Regression: `health.until as number` cast silently passed strings
  // through to `string <= now` comparison — where JS coerces. If the
  // coercion produced NaN, the comparison was false and the entry
  // survived forever as an un-expirable zombie. Reject instead.
  const entry = { state: "quota", until: "oops-not-a-number", retryCount: 1 };

  const parsed = parsePersistedHealthEntry(entry, Date.now());

  assert.equal(parsed, null);
});

test("parsePersistedHealthEntry_whenUntilIsNaN_returnsNullInsteadOfZombie", () => {
  // Regression: `NaN <= now` is always false, so a NaN `until` used to
  // create a permanent zombie entry. Explicit Number.isFinite guard.
  const entry = { state: "quota", until: Number.NaN, retryCount: 1 };

  const parsed = parsePersistedHealthEntry(entry, Date.now());

  assert.equal(parsed, null);
});

test("parsePersistedHealthEntry_whenUntilIsAlreadyInThePast_returnsNullAsExpired", () => {
  const now = Date.now();
  const entry = { state: "quota", until: now - 1000, retryCount: 1 };

  const parsed = parsePersistedHealthEntry(entry, now);

  assert.equal(parsed, null);
});

test("parsePersistedHealthEntry_whenUntilEqualsNowExactly_returnsNullAtBoundary", () => {
  // M108 PDD surface 1: the expiry check uses `until <= now` so an
  // entry whose `until` lands on the exact wall-clock ms is treated as
  // already-expired. A drift to `until < now` would keep the entry
  // alive on the boundary and replay a stale penalty across plugin
  // restarts whose semantics were "already expired at persist time."
  const now = 1_700_000_000_000;
  const entry = { state: "quota", until: now, retryCount: 1 };

  const parsed = parsePersistedHealthEntry(entry, now);

  assert.equal(parsed, null);
});

test("parsePersistedHealthEntry_whenRetryCountIsNegative_returnsNullRejectingSignedRecord", () => {
  // M108 PDD surface 2: the retryCount guard's `|| retryCount < 0`
  // clause rejects negative values. The missing-retryCount pin only
  // exercises the `typeof !== "number"` clause; nothing else guards
  // against a hand-edited or corrupt on-disk entry with a negative
  // retryCount, which would quietly shift every downstream escalation
  // ladder if the sign clause were dropped as "defensive paranoia."
  const entry = { state: "quota", until: Date.now() + 60_000, retryCount: -1 };

  const parsed = parsePersistedHealthEntry(entry, Date.now());

  assert.equal(parsed, null);
});

test("parsePersistedHealthEntry_whenRetryCountIsInfinity_returnsNullRejectingNonFiniteCount", () => {
  // M108 PDD surface 3: the retryCount guard's `|| !Number.isFinite`
  // clause rejects Infinity / -Infinity / NaN. None of the existing
  // pins touches this clause — pin #8 fails on `typeof` and pin #6
  // tests the UNTIL finite-check on a different branch. A silent
  // Infinity retryCount would make `computeProviderHealthUpdate`
  // compute `Infinity + 1 === Infinity` and break the escalation
  // ladder forever on that entry.
  const entry = {
    state: "quota",
    until: Date.now() + 60_000,
    retryCount: Number.POSITIVE_INFINITY,
  };

  const parsed = parsePersistedHealthEntry(entry, Date.now());

  assert.equal(parsed, null);
});

test("parsePersistedHealthEntry_whenRetryCountIsMissing_returnsNull", () => {
  // Disk schema drift: old plugin version that didn't persist
  // retryCount. Reject rather than synthesize a default — the test
  // pins the intent that callers must not silently repair broken rows.
  const entry = { state: "quota", until: Date.now() + 1000 } as unknown;

  const parsed = parsePersistedHealthEntry(entry, Date.now());

  assert.equal(parsed, null);
});

test("buildRouteHealthEntry_whenModelIDIsAlreadyComposite_doesNotDoublePrefix", () => {
  // Regression: the four modelRouteHealthMap writers used a naive
  // `${providerID}/${model.id}` template. When opencode delivers a model id
  // that's already composite (e.g. `"ollama-cloud/glm-5"`), the naive write
  // produced `"ollama-cloud/ollama-cloud/glm-5"` — a dead key no reader
  // using composeRouteKey could ever look up. Route penalties for all
  // composite-id providers were effectively invisible to the router.
  const now = Date.now();
  const { routeKey, health } = buildRouteHealthEntry(
    "ollama-cloud",
    "ollama-cloud/glm-5",
    "quota",
    60 * 60 * 1000,
    undefined,
    now,
  );

  assert.equal(routeKey, "ollama-cloud/glm-5", "do not double-prefix composite ids");
  assert.equal(health.state, "quota");
  assert.equal(health.until, now + 60 * 60 * 1000);
  assert.equal(health.retryCount, 1);
});

test("buildRouteHealthEntry_whenModelIDIsUnprefixedPlainId_addsProviderPrefix", () => {
  // The other half of the symmetry: plain-id providers like longcat
  // (where model.id arrives unprefixed, e.g. "LongCat-Flash-Chat") still
  // need the provider prefix attached. This mirrors the read-side contract.
  const now = Date.now();
  const { routeKey } = buildRouteHealthEntry(
    "longcat",
    "LongCat-Flash-Chat",
    "timeout",
    60 * 60 * 1000,
    undefined,
    now,
  );

  assert.equal(routeKey, "longcat/LongCat-Flash-Chat");
});

test("buildRouteHealthEntry_whenOpenrouterDeliversAlreadyComposite_preservesSingleSlash", () => {
  // openrouter's model ids arrive as `"openrouter/xiaomi/mimo-v2-pro"` —
  // the provider prefix plus a vendor-qualified sub-id. The helper must
  // not re-prefix or the readers would look up the wrong key.
  const { routeKey } = buildRouteHealthEntry(
    "openrouter",
    "openrouter/xiaomi/mimo-v2-pro",
    "model_not_found",
    60 * 60 * 1000,
    undefined,
    Date.now(),
  );

  assert.equal(routeKey, "openrouter/xiaomi/mimo-v2-pro");
});

test("buildRouteHealthEntry_whenReadBackViaComposeRouteKey_hitsSameKey", () => {
  // The symmetry test: a write via buildRouteHealthEntry must be findable
  // by a read via composeRouteKey for BOTH plain and composite model ids.
  // This is the integration-level invariant the four write sites broke.
  const now = Date.now();

  const composite = buildRouteHealthEntry(
    "ollama-cloud",
    "ollama-cloud/glm-5",
    "quota",
    60 * 60 * 1000,
    undefined,
    now,
  );
  const compositeReadKey = composeRouteKey({
    provider: "ollama-cloud",
    model: "ollama-cloud/glm-5",
  });
  assert.equal(composite.routeKey, compositeReadKey);

  const plain = buildRouteHealthEntry(
    "longcat",
    "LongCat-Flash-Chat",
    "timeout",
    60 * 60 * 1000,
    undefined,
    now,
  );
  const plainReadKey = composeRouteKey({
    provider: "longcat",
    model: "LongCat-Flash-Chat",
  });
  assert.equal(plain.routeKey, plainReadKey);
});

test("buildRouteHealthEntry_whenExistingEntryHasRetryCount_incrementsIt", () => {
  const now = Date.now();
  const existing = {
    state: "quota" as const,
    until: now + 30 * 60 * 1000,
    retryCount: 4,
  };

  const { health } = buildRouteHealthEntry(
    "ollama-cloud",
    "ollama-cloud/glm-5",
    "quota",
    60 * 60 * 1000,
    existing,
    now,
  );

  assert.equal(health.retryCount, 5, "repeat failures must remain observable");
});

test("buildRouteHealthEntry_whenExistingUntilIsLongerThanNewUntil_preservesExistingStateAndUntil", () => {
  // Mirrors M36 at the provider level: do not let a shorter fresh penalty
  // silently shrink a live longer one. Construct an existing route entry
  // whose `until` sits 2h out — simulating either (a) a disk-loaded entry
  // written by a parallel opencode process that paid a longer backoff, or
  // (b) a hypothetical future writer that classifies e.g. `model_not_found`
  // at a longer 2h duration. Fire a fresh 1h `timeout` event and assert
  // the stored `until` stays on the 2h horizon, the `state` stays on the
  // authoritative `model_not_found`, and `retryCount` still ticks so the
  // health report surfaces the repeat failure.
  const now = Date.now();
  const existing = {
    state: "model_not_found" as const,
    until: now + 2 * 60 * 60 * 1000, // 2h out
    retryCount: 3,
  };

  const { routeKey, health } = buildRouteHealthEntry(
    "iflowcn",
    "qwen3-coder-plus",
    "timeout",
    60 * 60 * 1000, // fresh penalty only 1h
    existing,
    now,
  );

  assert.equal(routeKey, "iflowcn/qwen3-coder-plus");
  assert.equal(
    health.state,
    "model_not_found",
    "longer-lived classification must not be overwritten by a shorter fresh event",
  );
  assert.equal(
    health.until,
    existing.until,
    "existing `until` must be preserved when it is further out than `now + durationMs`",
  );
  assert.equal(health.retryCount, 4, "retryCount still ticks so repeat failures remain visible");
});

test("buildRouteHealthEntry_whenNewUntilIsLongerThanExisting_adoptsNewStateAndUntil", () => {
  // The complementary boundary: if the incoming penalty is LONGER than
  // the existing one, the new classification is authoritative. This is
  // the common route case today (both equal at 1h, new wall-clock is
  // later so new `until` wins). Pin the direction so a future "always
  // preserve existing" regression is caught immediately.
  const now = Date.now();
  const existing = {
    state: "timeout" as const,
    until: now + 10 * 60 * 1000, // only 10min remaining
    retryCount: 1,
  };

  const { health } = buildRouteHealthEntry(
    "iflowcn",
    "qwen3-coder-plus",
    "quota",
    60 * 60 * 1000, // fresh 1h penalty → 60min > 10min
    existing,
    now,
  );

  assert.equal(health.state, "quota", "newer/longer penalty wins the classification");
  assert.equal(health.until, now + 60 * 60 * 1000);
  assert.equal(health.retryCount, 2);
});

test("buildRouteHealthEntry_whenPreserveBranchTaken_returnsFreshHealthObjectNotExistingByReference", () => {
  // M107 PDD surface 1: the preserve-longer branch must allocate a fresh
  // `health` object. A `health: existing` optimization would share a handle
  // between the caller's pre-call reference and the map's post-call entry,
  // letting later writers retroactively mutate already-committed
  // observations. M43 field-equality pins cannot detect bare-reference
  // return forms that happen to match field values.
  const now = Date.now();
  const existing = {
    state: "timeout" as const,
    until: now + 2 * 60 * 60 * 1000, // 2h — strictly longer than the 1h incoming
    retryCount: 1,
  };

  const { health } = buildRouteHealthEntry(
    "iflowcn",
    "qwen3-coder-plus",
    "quota",
    60 * 60 * 1000, // 1h — shorter, triggers preserve branch
    existing,
    now,
  );

  assert.ok(health !== existing, "preserve branch must return a fresh health object, not existing by reference");
});

test("buildRouteHealthEntry_whenExistingUntilEqualsNewUntil_takesNewPathAcceptingNewState", () => {
  // M107 PDD surface 2: the condition is STRICT `existing.until > newUntil`,
  // so equal-until means the incoming classification wins. Two route-level
  // writers computing the same `now + 1h` boundary in the same tick (e.g.
  // a hang-timer and a session.error firing in the same event-loop cycle
  // against the same route) must commit to the more structural
  // classification. A `>=` drift would preserve the stale label and make
  // operator-visible state lag reality by up to a full lockout window.
  const now = Date.now();
  const sharedDuration = 60 * 60 * 1000;
  const existing = {
    state: "timeout" as const,
    until: now + sharedDuration, // byte-identical to newUntil
    retryCount: 2,
  };

  const { health } = buildRouteHealthEntry(
    "iflowcn",
    "qwen3-coder-plus",
    "model_not_found",
    sharedDuration,
    existing,
    now,
  );

  assert.equal(
    health.state,
    "model_not_found",
    "equal-until must accept incoming state, not preserve existing",
  );
});

test("buildRouteHealthEntry_whenNewPathTaken_doesNotMutateInputExistingRecord", () => {
  // M107 PDD surface 3: neither branch may mutate `existing`. A refactor to
  // `Object.assign(existing, {...})` in the new-path branch would pass
  // every field-equality pin (Object.assign returns its first argument with
  // the right fields) while silently corrupting any caller that held a
  // pre-call handle to `existing` for logging, diffing, or metric emission.
  const now = Date.now();
  const existing = {
    state: "quota" as const,
    until: now + 60 * 60 * 1000,
    retryCount: 3,
  };

  buildRouteHealthEntry(
    "iflowcn",
    "qwen3-coder-plus",
    "no_credit",
    2 * 60 * 60 * 1000, // 2h > 1h — takes new path
    existing,
    now,
  );

  assert.equal(existing.state, "quota", "new-path must not mutate the input existing record");
});

test("PROVIDER_PENALTY_CLASS_TO_BACKOFF_DURATION_MS_quotaKey_mapsTo1HourConstant", () => {
  // Pins the `quota` → `ROUTE_QUOTA_BACKOFF_DURATION_MS` (1h) assignment
  // in the Record. If a refactor reassigns `quota` to the 2h key_dead
  // constant by mistake, the session.error hook would quarantine quota
  // hits for twice as long — doubling the wasted retry budget for the
  // most common transient error class.
  assert.equal(
    PROVIDER_PENALTY_CLASS_TO_BACKOFF_DURATION_MS.quota,
    ROUTE_QUOTA_BACKOFF_DURATION_MS,
  );
});

test("PROVIDER_PENALTY_CLASS_TO_BACKOFF_DURATION_MS_noCreditKey_mapsTo2HourNoCreditConstant", () => {
  // Pins the `no_credit` → `PROVIDER_NO_CREDIT_DURATION_MS` assignment.
  // Regression target: a swap to `ROUTE_QUOTA_BACKOFF_DURATION_MS` would
  // retry a billing-dead provider every hour, burning requests against
  // a guaranteed 402.
  assert.equal(
    PROVIDER_PENALTY_CLASS_TO_BACKOFF_DURATION_MS.no_credit,
    PROVIDER_NO_CREDIT_DURATION_MS,
  );
});

test("PROVIDER_PENALTY_CLASS_TO_BACKOFF_DURATION_MS_keyDeadKey_mapsTo2HourKeyDeadConstant", () => {
  // Pins the `key_dead` → `PROVIDER_KEY_DEAD_DURATION_MS` assignment.
  // A dead API key that falls back to the 1h quota window would be
  // retried every hour forever, the exact regression M35 was introduced
  // to close via authoritative status-code classification.
  assert.equal(
    PROVIDER_PENALTY_CLASS_TO_BACKOFF_DURATION_MS.key_dead,
    PROVIDER_KEY_DEAD_DURATION_MS,
  );
});

test("classifyProviderApiError_when402WithRateLimitKeyword_returnsNoCreditNotQuota", () => {
  // Regression: the old `||` cascade matched "rate limit" in the earlier
  // quota bucket and returned "quota" (1h), pre-empting the authoritative
  // 402 (no_credit, 2h). The provider was retried an hour early, failed
  // with the same 402, and burned compute on a guaranteed-fail route.
  const result = classifyProviderApiError(402, "rate limit exceeded: insufficient credits");
  assert.equal(result, "no_credit");
});

test("classifyProviderApiError_when401WithRateLimitKeyword_returnsKeyDeadNotQuota", () => {
  // Regression: a dead key returning 401 with "rate limit" in the body
  // (e.g. "rate limit on unauthenticated requests") used to be classified
  // as quota (1h). The dead key was retried every hour forever instead
  // of being quarantined for the full key_dead window.
  const result = classifyProviderApiError(401, "rate limit on unauthenticated requests: token invalid");
  assert.equal(result, "key_dead");
});

test("classifyProviderApiError_when403WithQuotaKeyword_returnsKeyDeadNotQuota", () => {
  // Same priority bug for the 403 branch of key_dead.
  const result = classifyProviderApiError(403, "quota exceeded for this api key");
  assert.equal(result, "key_dead");
});

test("classifyProviderApiError_when429WithNoCreditKeyword_returnsQuota", () => {
  // Symmetric check: authoritative 429 dominates even when the message
  // mentions billing / payment. Pins that the priority flows the other
  // direction too.
  const result = classifyProviderApiError(429, "rate limited: upgrade your billing plan for higher throughput");
  assert.equal(result, "quota");
});

test("classifyProviderApiError_whenStatusIsZeroAndQuotaKeyword_returnsQuotaFromFallback", () => {
  // Keyword fallback path: status 0 (e.g. proxy stripped it) falls
  // through to keyword checks in longer-penalty-first order:
  // no_credit > key_dead > quota. Plain quota-only messages still land
  // in the quota bucket because no earlier bucket's keywords match.
  const result = classifyProviderApiError(0, "provider reported quota exhaustion");
  assert.equal(result, "quota");
});

test("classifyProviderApiError_whenStatusIsZeroAndMessageHasBothRateLimitAndInsufficientCredits_returnsNoCreditNotQuota", () => {
  // Headline regression (M45): a proxy strips the authoritative 402
  // status, or the provider returns a structured 500 body carrying its
  // real failure in the message. The message reads
  // "rate limit exceeded: insufficient credits" — under the old
  // quota-first keyword order this short-circuited to "quota" (1h),
  // the plugin retried the out-of-credit provider an hour later, hit
  // the same error, cycle repeated indefinitely. Correct class is
  // "no_credit" (2h). Same failure mode that M35 fixed at the HTTP
  // status-code priority path, ported to the keyword fallback.
  const result = classifyProviderApiError(
    0,
    "rate limit exceeded: insufficient credits on this account",
  );
  assert.equal(result, "no_credit");
});

test("classifyProviderApiError_whenStatusIsZeroAndMessageHasBothRateLimitAndUnauthorized_returnsKeyDeadNotQuota", () => {
  // Symmetric: dead-key message wrapped in a "rate limit" narrative
  // must classify as key_dead at statusCode=0, not quota. Prevents the
  // "dead key retried every hour" cycle when the status is absent.
  const result = classifyProviderApiError(
    0,
    "rate limit on unauthorized requests: token invalid",
  );
  assert.equal(result, "key_dead");
});

test("classifyProviderApiError_whenStatusIsZeroAndNoCreditKeyword_returnsNoCredit", () => {
  const result = classifyProviderApiError(0, "insufficient credits on this account");
  assert.equal(result, "no_credit");
});

test("classifyProviderApiError_whenStatusIsZeroAndUnrelatedMessage_returnsUnclassified", () => {
  // Critical invariant: random transient errors ("connection reset",
  // bare 500s with no body) must NOT quarantine a healthy provider.
  // Callers skip penalty application on "unclassified".
  const result = classifyProviderApiError(0, "upstream connection reset by peer");
  assert.equal(result, "unclassified");
});

test("classifyProviderApiError_whenStatusIs500AndNoKeywords_returnsUnclassified", () => {
  // 500 is explicitly not recognized — a bare upstream error must not
  // trigger a provider penalty.
  const result = classifyProviderApiError(500, "");
  assert.equal(result, "unclassified");
});

test("shouldClassifyAsModelNotFound_when404WithModelNotFoundMessage_returnsTrue", () => {
  // HTTP-canonical not-found from a direct provider. Route-level
  // model_not_found penalty is correct — the provider is fine, this
  // specific model doesn't exist there.
  assert.equal(
    shouldClassifyAsModelNotFound(404, "model not found: glm-5.1"),
    true,
  );
});

test("shouldClassifyAsModelNotFound_when500WithModelNotFoundMessage_returnsTrue", () => {
  // Openrouter synthesizes `500 "Model not found"` when its router
  // cannot resolve the requested model to any upstream. Accepted.
  assert.equal(
    shouldClassifyAsModelNotFound(500, "model not found in router"),
    true,
  );
});

test("shouldClassifyAsModelNotFound_whenStatusIsZeroWithModelNotFoundMessage_returnsTrue", () => {
  // statusCode=0 means no authoritative signal is available (proxy
  // stripped it, network error, structured body). The keyword is the
  // only classifier we have — accept it.
  assert.equal(
    shouldClassifyAsModelNotFound(0, "model not found on upstream"),
    true,
  );
});

test("shouldClassifyAsModelNotFound_when401WithModelNotFoundMessage_returnsFalse", () => {
  // Priority-dominance regression pin: a dead key that happens to
  // mention the phrase in its auth-failure narrative must NOT fire
  // a route-level model_not_found (1h). The caller's downstream
  // `classifyProviderApiError(401, ...)` will correctly return
  // "key_dead" and the provider will be quarantined for 2h.
  assert.equal(
    shouldClassifyAsModelNotFound(
      401,
      "unauthorized: your key cannot access model not found in allowlist",
    ),
    false,
  );
});

test("shouldClassifyAsModelNotFound_when402WithModelNotFoundMessage_returnsFalse", () => {
  // Priority-dominance regression pin: no_credit (402) must win over
  // a keyword match. Otherwise a drained account retries every hour
  // on just one route instead of quarantining the provider for 2h.
  assert.equal(
    shouldClassifyAsModelNotFound(
      402,
      "insufficient credits: model not found in paid tier",
    ),
    false,
  );
});

test("shouldClassifyAsModelNotFound_when403WithModelNotFoundMessage_returnsFalse", () => {
  // Priority-dominance regression pin: 403 routes to key_dead like 401.
  assert.equal(
    shouldClassifyAsModelNotFound(
      403,
      "forbidden: api key cannot reach model not found in tier",
    ),
    false,
  );
});

test("shouldClassifyAsModelNotFound_when429WithModelNotFoundMessage_returnsFalse", () => {
  // Priority-dominance regression pin: 429 is a PROVIDER-level quota
  // signal. Misclassifying as route-level model_not_found leaves the
  // other routes through the same throttled provider burning retries
  // while only the one route sits out the backoff window.
  assert.equal(
    shouldClassifyAsModelNotFound(
      429,
      "rate limit exceeded: model not found in free quota window",
    ),
    false,
  );
});

test("shouldClassifyAsModelNotFound_whenStatusIs500WithUnrelatedMessage_returnsFalse", () => {
  // A bare 500 with no keyword is a transient upstream error — must
  // not poison a working route. Requires the keyword to trip.
  assert.equal(
    shouldClassifyAsModelNotFound(500, "internal server error"),
    false,
  );
});

test("shouldClassifyAsModelNotFound_when404WithUnrelatedMessage_returnsFalse", () => {
  // 404 without the keyword does not trigger the penalty — some
  // providers return 404 for transient routing blips.
  assert.equal(
    shouldClassifyAsModelNotFound(404, "not found"),
    false,
  );
});

test("ROUTE_MODEL_NOT_FOUND_DURATION_MS_isStrictlyLongerThan_ROUTE_QUOTA_BACKOFF_DURATION_MS", () => {
  // Semantic pin: a missing-model penalty must outlast a quota penalty,
  // because a quota refills on a clock whereas a missing model is a
  // structural property of the upstream. If a refactor ever collapses
  // both to the same duration the behavioral difference is lost and the
  // session.error handler silently regresses to hourly 404 retries.
  assert.equal(
    ROUTE_MODEL_NOT_FOUND_DURATION_MS > ROUTE_QUOTA_BACKOFF_DURATION_MS,
    true,
  );
});

test("buildModelNotFoundRouteHealth_whenNoExistingEntry_returnsSixHourWindow", () => {
  // Value pin: the builder uses the dedicated 6h duration, not the 1h
  // quota fallback. If a future edit wires the wrong constant the
  // `until` delta against `now` will not equal the constant and this
  // test fires. The handler's call site is a thin pass-through to this
  // helper, so pinning the helper transitively covers the handler.
  const now = 1_700_000_000_000;
  const { routeKey, health } = buildModelNotFoundRouteHealth(
    "openrouter",
    "openrouter/meituan/longcat-flash-chat",
    undefined,
    now,
  );

  assert.equal(routeKey, "openrouter/meituan/longcat-flash-chat");
  assert.equal(health.state, "model_not_found");
  assert.equal(health.until - now, ROUTE_MODEL_NOT_FOUND_DURATION_MS);
  assert.equal(health.retryCount, 1);
});

test("buildModelNotFoundRouteHealth_whenUnprefixedRegistryShape_composesIdempotentKey", () => {
  // longcat-shape regression (mirrors M30 / M47): the helper must
  // tolerate both raw and already-composite runtime ids and land on
  // the same canonical route key. Verifies the thin wrapper inherits
  // `composeRouteKey`'s idempotent behavior from buildRouteHealthEntry.
  const now = 1_700_000_000_000;
  const rawIdResult = buildModelNotFoundRouteHealth(
    "longcat",
    "LongCat-Flash-Chat",
    undefined,
    now,
  );
  const compositeIdResult = buildModelNotFoundRouteHealth(
    "longcat",
    "longcat/LongCat-Flash-Chat",
    undefined,
    now,
  );

  assert.equal(rawIdResult.routeKey, "longcat/LongCat-Flash-Chat");
  assert.equal(compositeIdResult.routeKey, "longcat/LongCat-Flash-Chat");
});

test("buildModelNotFoundRouteHealth_whenExistingPenaltyOutlivesNewWindow_preservesLongerPenalty", () => {
  // M43 preserve-longer parity: a previously-persisted longer window
  // (e.g. from another process, or a future writer with a longer
  // duration) must survive the merge. Bumping the duration constant
  // is only safe because this invariant holds — if the preserve-longer
  // branch ever regresses, a shorter quota penalty on the same route
  // would silently shrink an active model_not_found window.
  const now = 1_700_000_000_000;
  const existingUntil = now + ROUTE_MODEL_NOT_FOUND_DURATION_MS * 2;
  const { health } = buildModelNotFoundRouteHealth(
    "openrouter",
    "openrouter/foo",
    {
      state: "model_not_found",
      until: existingUntil,
      retryCount: 3,
    },
    now,
  );

  assert.equal(health.until, existingUntil);
  assert.equal(health.retryCount, 4);
});

test("countHealthyVisibleRoutes_whenNoPenaltiesActive_returnsAllVisibleRoutes", () => {
  const entry = buildModelRegistryEntry(
    "test-model",
    ["builder"],
    "standard",
    [
      { provider: "ollama-cloud", model: "ollama-cloud/test-model", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/test-model", priority: 2 },
    ],
  );

  const count = countHealthyVisibleRoutes(
    entry,
    new Map(),
    new Map(),
    Date.now(),
  );

  assert.equal(count, 2);
});

test("countHealthyVisibleRoutes_whenOneProviderPenalized_excludesItsRoute", () => {
  const entry = buildModelRegistryEntry(
    "test-model",
    ["builder"],
    "standard",
    [
      { provider: "ollama-cloud", model: "ollama-cloud/test-model", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/test-model", priority: 2 },
    ],
  );
  const now = Date.now();
  const providerHealth = new Map([
    ["ollama-cloud", { state: "quota" as const, until: now + 60 * 60 * 1000, retryCount: 1 }],
  ]);

  const count = countHealthyVisibleRoutes(entry, providerHealth, new Map(), now);

  assert.equal(count, 1, "only the iflowcn route remains healthy");
});

test("countHealthyVisibleRoutes_whenOneRoutePenalizedAtRouteLevel_excludesIt", () => {
  const entry = buildModelRegistryEntry(
    "test-model",
    ["builder"],
    "standard",
    [
      { provider: "ollama-cloud", model: "ollama-cloud/test-model", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/test-model", priority: 2 },
    ],
  );
  const now = Date.now();
  const routeHealth = new Map([
    [
      "ollama-cloud/test-model",
      { state: "model_not_found" as const, until: now + 60 * 60 * 1000, retryCount: 1 },
    ],
  ]);

  const count = countHealthyVisibleRoutes(entry, new Map(), routeHealth, now);

  assert.equal(count, 1);
});

test("countHealthyVisibleRoutes_whenPenaltyExpired_routeCountsAsHealthy", () => {
  const entry = buildModelRegistryEntry(
    "test-model",
    ["builder"],
    "standard",
    [{ provider: "ollama-cloud", model: "ollama-cloud/test-model", priority: 1 }],
  );
  const now = Date.now();
  // Expired penalty — until is in the past.
  const routeHealth = new Map([
    [
      "ollama-cloud/test-model",
      { state: "quota" as const, until: now - 1000, retryCount: 1 },
    ],
  ]);

  const count = countHealthyVisibleRoutes(entry, new Map(), routeHealth, now);

  assert.equal(count, 1, "expired penalty must not suppress the route");
});

test("selectBestModelForRoleAndTask_whenDeadSingleRouteCompetesWithPartiallyHealthyMultiRoute_prefersPartiallyHealthy", () => {
  // Regression: the old sort comparator used `aUnhealthyCount - bUnhealthyCount`
  // (ascending), so a `1/1 dead` candidate (0 healthy) beat a `2/5 dead`
  // candidate (3 healthy) because `1 < 2`. The dead candidate won the
  // ranking and the router then had no live route to try.
  //
  // Both candidates must be in the same capability tier, or the prior
  // tier-ordering sort key dominates.
  const deadSingleRoute = buildModelRegistryEntry(
    "dead-single",
    ["builder"],
    "standard",
    [{ provider: "ollama-cloud", model: "ollama-cloud/dead-single", priority: 1 }],
  );
  const partiallyHealthyMultiRoute = buildModelRegistryEntry(
    "multi-route",
    ["builder"],
    "standard",
    [
      { provider: "ollama-cloud", model: "ollama-cloud/multi-route", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/multi-route", priority: 2 },
      { provider: "openrouter", model: "openrouter/multi-route:free", priority: 3 },
      { provider: "xiaomi-direct", model: "xiaomi-direct/multi-route", priority: 4 },
      { provider: "huggingface", model: "huggingface/multi-route", priority: 5 },
    ],
  );

  const now = Date.now();
  const providerHealth = new Map<string, { state: "quota" | "key_dead" | "no_credit" | "key_missing" | "model_not_found" | "timeout"; until: number; retryCount: number }>();
  const routeHealth = new Map([
    // deadSingleRoute's only route is dead.
    [
      "ollama-cloud/dead-single",
      { state: "model_not_found" as const, until: now + 60 * 60 * 1000, retryCount: 1 },
    ],
    // partiallyHealthyMultiRoute has 2 dead routes out of 5.
    [
      "ollama-cloud/multi-route",
      { state: "quota" as const, until: now + 60 * 60 * 1000, retryCount: 1 },
    ],
    [
      "iflowcn/multi-route",
      { state: "timeout" as const, until: now + 60 * 60 * 1000, retryCount: 1 },
    ],
  ]);

  const best = selectBestModelForRoleAndTask(
    [deadSingleRoute, partiallyHealthyMultiRoute],
    providerHealth,
    routeHealth,
    now,
    "builder",
    null,
    null,
  );

  assert.ok(best, "selection must not be null when at least one candidate has a live route");
  assert.equal(best.id, "multi-route", "partially-healthy multi-route wins over totally-dead single-route");
});

test("summarizeVisibleRouteHealth_whenMixOfHealthyAndPenalized_returnsBothCounts", () => {
  const entry = buildModelRegistryEntry(
    "mixed-model",
    ["builder"],
    "standard",
    [
      { provider: "ollama-cloud", model: "ollama-cloud/mixed-model", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/mixed-model", priority: 2 },
      { provider: "openrouter", model: "openrouter/mixed-model:free", priority: 3 },
    ],
  );
  const now = Date.now();
  const providerHealth = new Map([
    ["ollama-cloud", { state: "quota" as const, until: now + 60 * 60 * 1000, retryCount: 1 }],
  ]);
  const routeHealth = new Map([
    [
      "iflowcn/mixed-model",
      { state: "timeout" as const, until: now + 60 * 60 * 1000, retryCount: 1 },
    ],
  ]);

  const summary = summarizeVisibleRouteHealth(entry, providerHealth, routeHealth, now);

  assert.equal(summary.healthy, 1, "only openrouter route is live");
  assert.equal(summary.unhealthy, 2, "ollama-cloud (provider-dead) + iflowcn (route-dead)");
});

test("summarizeVisibleRouteHealth_whenAllRoutesHealthy_returnsZeroUnhealthy", () => {
  const entry = buildModelRegistryEntry(
    "clean-model",
    ["builder"],
    "standard",
    [
      { provider: "ollama-cloud", model: "ollama-cloud/clean-model", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/clean-model", priority: 2 },
    ],
  );
  const summary = summarizeVisibleRouteHealth(entry, new Map(), new Map(), Date.now());
  assert.equal(summary.healthy, 2);
  assert.equal(summary.unhealthy, 0);
});

// M119 pin A — isolated drift surface 1: `filterVisibleProviderRoutes`
// gate. Entry has ONE visible route (openrouter `:free` route is the
// only shape that survives the filter among three-provider openrouter
// mixes) and TWO hidden routes (paid openrouter, togetherai — both
// filtered out by the visibility filter). Empty health maps means
// every route, if it reaches the walk, counts as healthy. Asserts
// `healthy + unhealthy === 1` so a sabotage that drops the filter and
// lets all three routes through (yielding {3, 0}) flips the sum. Pin B
// (unhealthy === 1 with a provider-dead single-visible fixture) cannot
// fire here because the only live route here is healthy; pin C
// (healthy === 0 with a route-level penalty fixture) cannot fire here
// because no route carries a route-level penalty.
test("summarizeVisibleRouteHealth_whenEntryHasHiddenRoutes_excludesHiddenFromBothCounts", () => {
  const entry = buildModelRegistryEntry(
    "visibility-gate-model",
    ["builder"],
    "standard",
    [
      { provider: "openrouter", model: "openrouter/visibility-gate-model:free", priority: 1 },
      { provider: "openrouter", model: "openrouter/visibility-gate-model", priority: 2 },
      { provider: "togetherai", model: "togetherai/visibility-gate-model", priority: 3 },
    ],
  );

  const summary = summarizeVisibleRouteHealth(entry, new Map(), new Map(), Date.now());

  assert.equal(
    summary.healthy + summary.unhealthy,
    1,
    "only the :free route is visible; hidden paid + togetherai routes must not contribute",
  );
});

// M119 pin B — isolated drift surface 2: exclusive `if / else` counter
// pair. Single visible route whose provider is quota-penalised, empty
// route health map. Expected `{healthy: 0, unhealthy: 1}`. Asserts
// `unhealthy === 1` specifically: a sabotage that drops the `else`
// branch silently pins `unhealthy` at 0 for every entry, fails this
// pin, but pin A is unaffected (pin A's entry had `healthy: 1 /
// unhealthy: 0` already so the dropped `else` doesn't move it), and
// pin C is unaffected (pin C asserts `healthy === 0` which remains
// true regardless of the else branch). Pin B does not depend on
// hidden-route filtering because the fixture has zero hidden routes.
test("summarizeVisibleRouteHealth_whenSingleVisibleRouteIsProviderDead_incrementsUnhealthyViaElseBranch", () => {
  const entry = buildModelRegistryEntry(
    "provider-dead-model",
    ["builder"],
    "standard",
    [
      { provider: "ollama-cloud", model: "ollama-cloud/provider-dead-model", priority: 1 },
    ],
  );
  const now = Date.now();
  const providerHealth = new Map([
    ["ollama-cloud", { state: "quota" as const, until: now + 60 * 60 * 1000, retryCount: 1 }],
  ]);

  const summary = summarizeVisibleRouteHealth(entry, providerHealth, new Map(), now);

  assert.equal(summary.unhealthy, 1);
});

// M119 pin C — isolated drift surface 3: per-route composite
// `isRouteCurrentlyHealthy` call. Single visible route, EMPTY
// providerHealthMap, but the composite `provider/model` key carries a
// live `model_not_found` route-level penalty. A correct implementation
// routes the check through `isRouteCurrentlyHealthy` → composite-key
// lookup → returns false → `{healthy: 0, unhealthy: 1}`. A sabotage
// that "simplifies" to `isProviderHealthy(route.provider, ...)` drops
// the composite-key half, treats the route as healthy (empty provider
// map), and flips counts to `{1, 0}`. Asserts `healthy === 0` so the
// sabotage fires this pin uniquely: pin A is unaffected (its fixture
// has a healthy route and a visibility gate, not a route-level
// penalty); pin B is unaffected (its fixture has a provider-level
// penalty which `isProviderHealthy` catches regardless of the
// composite-key half).
test("summarizeVisibleRouteHealth_whenVisibleRouteHasRouteLevelPenalty_checkedViaCompositeKey", () => {
  const entry = buildModelRegistryEntry(
    "route-dead-model",
    ["builder"],
    "standard",
    [
      { provider: "iflowcn", model: "iflowcn/route-dead-model", priority: 1 },
    ],
  );
  const now = Date.now();
  const routeHealth = new Map([
    [
      "iflowcn/route-dead-model",
      { state: "model_not_found" as const, until: now + 60 * 60 * 1000, retryCount: 1 },
    ],
  ]);

  const summary = summarizeVisibleRouteHealth(entry, new Map(), routeHealth, now);

  assert.equal(summary.healthy, 0);
});

test("selectBestModelForRoleAndTask_whenHealthyCountsTie_prefersCandidateWithFewerDeadSiblings", () => {
  // Regression: after M40 switched the ranking comparator from
  // `unhealthy ascending` to `healthy descending`, the tiebreaker signal
  // vanished. A candidate with `1 healthy / 1 dead` tied with a cleaner
  // `1 healthy / 0 dead` candidate on the primary key, then fell
  // through to billing preference / original order — allowing the dirty
  // candidate to win when it should obviously lose (the dead sibling is
  // known friction and future retry waste). This test pins the
  // secondary-key tiebreaker behavior: cleaner wins when healthy ties.
  const now = Date.now();

  const dirtyCandidate = buildModelRegistryEntry(
    "dirty",
    ["builder"],
    "standard",
    [
      { provider: "missing-provider", model: "missing-provider/dirty", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/dirty", priority: 2 },
    ],
  );
  const cleanCandidate = buildModelRegistryEntry(
    "clean",
    ["builder"],
    "standard",
    [
      { provider: "iflowcn", model: "iflowcn/clean", priority: 1 },
    ],
  );

  // Dirty has one dead provider route (missing-provider) + one healthy.
  // Clean has one healthy route and nothing else.
  // Both candidates tie on healthy=1; dirty has unhealthy=1, clean has 0.
  const providerHealth = new Map([
    [
      "missing-provider",
      { state: "key_missing" as const, until: Number.POSITIVE_INFINITY, retryCount: 0 },
    ],
  ]);

  // IMPORTANT: list dirty FIRST so a naive stable sort that stops at
  // `healthy` descending would leave dirty in position 0 — only a real
  // tiebreaker test catches this.
  const best = selectBestModelForRoleAndTask(
    [dirtyCandidate, cleanCandidate],
    providerHealth,
    new Map(),
    now,
    "builder",
    null,
    null,
  );

  assert.ok(best);
  assert.equal(best.id, "clean", "cleaner candidate wins when healthy counts tie");
});

test("evaluateSessionHangForTimeoutPenalty_whenSessionAlreadyCompleted_returnsNull", () => {
  // clearSessionHangState removes the start-time entry when a session
  // completes cleanly. A late-firing hang timer must become a no-op in
  // that case — any other behavior would retroactively poison a route
  // whose session succeeded.
  const startMap = new Map<string, number>();
  const providerMap = new Map<string, string>([["s1", "iflowcn"]]);
  const modelMap = new Map<string, { id: string; providerID: string }>([
    ["s1", { id: "iflowcn/qwen3-coder-plus", providerID: "iflowcn" }],
  ]);

  const result = evaluateSessionHangForTimeoutPenalty(
    "s1",
    startMap,
    providerMap,
    modelMap,
    new Map(),
    20,
    Date.now(),
  );

  assert.equal(result, null);
});

test("evaluateSessionHangForTimeoutPenalty_whenDurationWithinBudget_returnsNull", () => {
  // Duration strictly equal to timeoutMs is within budget (the threshold
  // uses `>` not `>=`). This prevents a photo-finish timer from
  // penalizing a session that finished on the exact boundary.
  const now = Date.now();
  const startMap = new Map<string, number>([["s1", now - 20]]); // duration == 20
  const providerMap = new Map<string, string>([["s1", "iflowcn"]]);
  const modelMap = new Map<string, { id: string; providerID: string }>([
    ["s1", { id: "iflowcn/qwen3-coder-plus", providerID: "iflowcn" }],
  ]);

  const result = evaluateSessionHangForTimeoutPenalty(
    "s1",
    startMap,
    providerMap,
    modelMap,
    new Map(),
    20, // duration equals this
    now,
  );

  assert.equal(result, null);
});

test("evaluateSessionHangForTimeoutPenalty_whenProviderOrModelMissing_returnsNull", () => {
  // If the provider/model session-map entries were cleared or never
  // populated, classification is impossible; the helper must return
  // null rather than guess or throw.
  const now = Date.now();
  const startMap = new Map<string, number>([["s1", now - 500]]);
  const providerMap = new Map<string, string>(); // missing
  const modelMap = new Map<string, { id: string; providerID: string }>();

  const result = evaluateSessionHangForTimeoutPenalty(
    "s1",
    startMap,
    providerMap,
    modelMap,
    new Map(),
    20,
    now,
  );

  assert.equal(result, null);
});

test("evaluateSessionHangForTimeoutPenalty_whenSessionHung_returnsTimeoutEntry", () => {
  // Happy path: session exceeded its budget, provider+model both known,
  // helper returns a route-health entry ready for the caller to write.
  // Asserts composite route key (via buildRouteHealthEntry/composeRouteKey),
  // state = timeout, and retryCount bumped from existing.
  const now = Date.now();
  const startMap = new Map<string, number>([["s1", now - 1000]]); // 1s > 20ms
  const providerMap = new Map<string, string>([["s1", "iflowcn"]]);
  const modelMap = new Map<string, { id: string; providerID: string }>([
    // Composite model.id — regression lane for M38 double-prefixing.
    ["s1", { id: "iflowcn/qwen3-coder-plus", providerID: "iflowcn" }],
  ]);
  const routeHealthMap = new Map([
    [
      "iflowcn/qwen3-coder-plus",
      { state: "timeout" as const, until: now - 10_000, retryCount: 4 },
    ],
  ]);

  const result = evaluateSessionHangForTimeoutPenalty(
    "s1",
    startMap,
    providerMap,
    modelMap,
    routeHealthMap,
    20,
    now,
  );

  assert.ok(result, "a hung session with full context must produce a penalty");
  assert.equal(result.routeKey, "iflowcn/qwen3-coder-plus", "composite key canonicalized, no double prefix");
  assert.equal(result.health.state, "timeout");
  assert.equal(result.health.retryCount, 5, "retry count carried forward and incremented");
  assert.ok(
    result.health.until > now,
    "until lies in the future (now + ROUTE_QUOTA_BACKOFF_DURATION_MS)",
  );
});

test("finalizeHungSessionState_whenSessionHung_clearsAllThreeSessionMapsAndReturnsPenalty", () => {
  // Headline regression: when the hang-timer `setTimeout` fires for a
  // session that was silently killed (network drop, client Ctrl-C, parent
  // crash that does not fire session.error), NEITHER terminal event
  // handler runs, so the session's entries in sessionStartTimeMap /
  // sessionActiveProviderMap / sessionActiveModelMap are the plugin's
  // ONLY signal — and they must be evicted at the same moment the penalty
  // is recorded, otherwise silent-death sessions leak one tuple per
  // session for the whole lifetime of the plugin process.
  const now = Date.now();
  const startMap = new Map<string, number>([["s1", now - 1000]]);
  const providerMap = new Map<string, string>([["s1", "iflowcn"]]);
  const modelMap = new Map<string, { id: string; providerID: string }>([
    ["s1", { id: "qwen3-coder-plus", providerID: "iflowcn" }],
  ]);
  const routeHealthMap = new Map<string, { state: "quota" | "key_dead" | "no_credit" | "key_missing" | "model_not_found" | "timeout"; until: number; retryCount: number }>();

  const result = finalizeHungSessionState(
    "s1",
    startMap,
    providerMap,
    modelMap,
    routeHealthMap,
    20,
    now,
  );

  assert.ok(result, "hung session must produce a penalty");
  assert.equal(result.routeKey, "iflowcn/qwen3-coder-plus");
  assert.equal(result.health.state, "timeout");
  assert.equal(startMap.has("s1"), false, "sessionStartTimeMap must be evicted after penalty");
  assert.equal(providerMap.has("s1"), false, "sessionActiveProviderMap must be evicted after penalty");
  assert.equal(modelMap.has("s1"), false, "sessionActiveModelMap must be evicted after penalty");
});

test("finalizeHungSessionState_whenSessionAlreadyCompleted_leavesMapsIntactAndReturnsNull", () => {
  // Session completion cleared the start-time entry before the hang timer
  // fired. The helper must short-circuit to null AND must NOT touch any
  // of the maps — a subsequent session sharing the same sessionID string
  // (shouldn't happen, but defensive) must not be evicted by our late
  // firing.
  const now = Date.now();
  const startMap = new Map<string, number>(); // empty — session completed
  const providerMap = new Map<string, string>([["s2", "iflowcn"]]); // stale crumb
  const modelMap = new Map<string, { id: string; providerID: string }>([
    ["s2", { id: "qwen3-coder-plus", providerID: "iflowcn" }],
  ]);
  const routeHealthMap = new Map();

  const result = finalizeHungSessionState(
    "s2",
    startMap,
    providerMap,
    modelMap,
    routeHealthMap,
    20,
    now,
  );

  assert.equal(result, null);
  assert.equal(providerMap.has("s2"), true, "maps must be untouched when no penalty is recorded");
  assert.equal(modelMap.has("s2"), true, "maps must be untouched when no penalty is recorded");
});

test("finalizeHungSessionState_whenDurationStillWithinBudget_leavesMapsIntactAndReturnsNull", () => {
  // Boundary case: hang timer fired early (or duration equals timeoutMs
  // exactly — the helper uses `>`, not `>=`). Session is still running
  // and must NOT be evicted.
  const now = Date.now();
  const startMap = new Map<string, number>([["s3", now - 10]]); // 10ms, budget 20ms
  const providerMap = new Map<string, string>([["s3", "iflowcn"]]);
  const modelMap = new Map<string, { id: string; providerID: string }>([
    ["s3", { id: "qwen3-coder-plus", providerID: "iflowcn" }],
  ]);
  const routeHealthMap = new Map();

  const result = finalizeHungSessionState(
    "s3",
    startMap,
    providerMap,
    modelMap,
    routeHealthMap,
    20,
    now,
  );

  assert.equal(result, null);
  assert.equal(startMap.has("s3"), true, "still-running session must not be evicted");
  assert.equal(providerMap.has("s3"), true);
  assert.equal(modelMap.has("s3"), true);
});

test("finalizeHungSessionStateAndRecordPenalty_whenSessionHung_writesPenaltyAndFiresPersistAndClearsSessionMaps", () => {
  // M77: end-to-end hang-timer wrapper. When the session hung past the
  // timeout budget, the helper MUST: (1) write the "timeout" route-health
  // entry under the composite route key, (2) fire persistFn exactly once
  // through the M68 recordRouteHealthPenalty pair, and (3) clear the
  // three per-session maps so silent-death sessions don't leak memory.
  // This pin proves the full finalize → record ritual fires on the
  // non-null path.
  const now = Date.now();
  const startMap = new Map<string, number>([["s1", now - 1000]]);
  const providerMap = new Map<string, string>([["s1", "iflowcn"]]);
  const modelMap = new Map<string, { id: string; providerID: string }>([
    ["s1", { id: "qwen3-coder-plus", providerID: "iflowcn" }],
  ]);
  const routeHealthMap = new Map<string, ModelRouteHealth>();
  const providerHealthMap = new Map<string, ProviderHealth>();
  let persistCalls = 0;

  finalizeHungSessionStateAndRecordPenalty(
    "s1",
    startMap,
    providerMap,
    modelMap,
    routeHealthMap,
    providerHealthMap,
    20,
    now,
    () => {
      persistCalls += 1;
    },
  );

  const entry = routeHealthMap.get("iflowcn/qwen3-coder-plus");
  assert.ok(entry, "penalty must be written under composite route key");
  assert.equal(entry!.state, "timeout");
  assert.equal(persistCalls, 1, "persistFn must fire exactly once through M68 pair");
  assert.equal(startMap.has("s1"), false, "sessionStartTimeMap must be evicted");
  assert.equal(providerMap.has("s1"), false, "sessionActiveProviderMap must be evicted");
  assert.equal(modelMap.has("s1"), false, "sessionActiveModelMap must be evicted");
});

test("finalizeHungSessionStateAndRecordPenalty_whenSessionAlreadyCompleted_doesNotWriteOrFirePersist", () => {
  // M77: null-guard invariant. The hang timer fires late for a session
  // that already completed (start-time was cleared by the terminal
  // handler). The wrapper must short-circuit on finalizeHungSessionState
  // returning null — no write to routeHealthMap, no persistFn call. A
  // refactor that dropped the null-check would call
  // recordRouteHealthPenalty with undefined fields and crash the
  // async-isolated setTimeout closure with an unhandled exception.
  const now = Date.now();
  const startMap = new Map<string, number>(); // empty — session completed
  const providerMap = new Map<string, string>();
  const modelMap = new Map<string, { id: string; providerID: string }>();
  const routeHealthMap = new Map<string, ModelRouteHealth>();
  const providerHealthMap = new Map<string, ProviderHealth>();
  let persistCalls = 0;

  finalizeHungSessionStateAndRecordPenalty(
    "s2",
    startMap,
    providerMap,
    modelMap,
    routeHealthMap,
    providerHealthMap,
    20,
    now,
    () => {
      persistCalls += 1;
    },
  );

  assert.equal(routeHealthMap.size, 0, "no entry must be written on null path");
  assert.equal(persistCalls, 0, "persistFn must not fire on null path");
});

test("finalizeHungSessionStateAndRecordPenalty_whenDurationStillWithinBudget_doesNotWriteOrFirePersist", () => {
  // M77: budget-respected invariant. Hang timer fired early (e.g. the
  // setTimeout returned slightly before the full duration elapsed, or
  // the session's budget hadn't yet been exceeded because the underlying
  // model is legitimately slow). The wrapper must not write a penalty,
  // must not fire persistFn, and must leave the session maps intact so
  // a later finalize call can still catch the real hang.
  const now = Date.now();
  const startMap = new Map<string, number>([["s3", now - 10]]); // 10ms vs 20ms budget
  const providerMap = new Map<string, string>([["s3", "iflowcn"]]);
  const modelMap = new Map<string, { id: string; providerID: string }>([
    ["s3", { id: "qwen3-coder-plus", providerID: "iflowcn" }],
  ]);
  const routeHealthMap = new Map<string, ModelRouteHealth>();
  const providerHealthMap = new Map<string, ProviderHealth>();
  let persistCalls = 0;

  finalizeHungSessionStateAndRecordPenalty(
    "s3",
    startMap,
    providerMap,
    modelMap,
    routeHealthMap,
    providerHealthMap,
    20,
    now,
    () => {
      persistCalls += 1;
    },
  );

  assert.equal(routeHealthMap.size, 0);
  assert.equal(persistCalls, 0);
  assert.equal(startMap.has("s3"), true, "still-running session state must survive early-fire");
  assert.equal(providerMap.has("s3"), true);
  assert.equal(modelMap.has("s3"), true);
});

test("evaluateSessionHangForTimeoutPenalty_closureDoesNotRetainFullInput_regressionPin", () => {
  // Pin that the helper signature accepts only primitives + Map refs —
  // no opencode `input` object. A future refactor that re-introduced a
  // closure over `input` would have to revert this signature or add a
  // new parameter, either of which would fail this test at compile time.
  // This is more a shape assertion than a runtime check: if the
  // parameter list changes to include a rich request object, the test
  // no longer compiles.
  const params: Parameters<typeof evaluateSessionHangForTimeoutPenalty> = [
    "s1",
    new Map<string, number>(),
    new Map<string, string>(),
    new Map<string, { id: string; providerID: string }>(),
    new Map(),
    900_000,
    Date.now(),
  ];
  // Sanity: calling with these params on an empty session yields null.
  assert.equal(evaluateSessionHangForTimeoutPenalty(...params), null);
});

// M52: `isZeroTokenQuotaSignal` replaces the narrow `input===0 && output===0`
// predicate in the `assistant.message.completed` handler. The narrow predicate
// would silently penalize successful deep-reasoning turns as quota-exhausted
// the moment any opencode release started populating side-channel counters
// (`reasoning`, nested `cache.read`/`cache.write`). These tests pin the
// defensive contract: a turn is quota-exhausted only when EVERY numeric
// counter — top-level or one-level-nested — is zero.

test("isZeroTokenQuotaSignal_whenBothPrimaryCountersAreZeroAndNoOtherCounters_returnsTrue", () => {
  assert.equal(isZeroTokenQuotaSignal({ input: 0, output: 0 }), true);
});

test("isZeroTokenQuotaSignal_whenInputIsNonZero_returnsFalse", () => {
  assert.equal(isZeroTokenQuotaSignal({ input: 42, output: 0 }), false);
});

test("isZeroTokenQuotaSignal_whenOutputIsNonZero_returnsFalse", () => {
  assert.equal(isZeroTokenQuotaSignal({ input: 0, output: 7 }), false);
});

test("isZeroTokenQuotaSignal_whenReasoningCounterIsNonZero_returnsFalse", () => {
  // Headline regression pin: kimi-k2-thinking / minimax-m2.7 / cogito-2.1
  // could plausibly report a successful deep-reasoning turn with zero
  // primary billing and nonzero `reasoning`. The narrow predicate would
  // fire a 1h quota penalty on a SUCCESSFUL completion.
  assert.equal(
    isZeroTokenQuotaSignal({ input: 0, output: 0, reasoning: 12_000 }),
    false,
  );
});

test("isZeroTokenQuotaSignal_whenNestedCacheReadCounterIsNonZero_returnsFalse", () => {
  // Nested-shape regression pin: opencode's tokens payload may expose
  // `cache: {read, write}` rather than flat counters.
  assert.equal(
    isZeroTokenQuotaSignal({ input: 0, output: 0, cache: { read: 500, write: 0 } }),
    false,
  );
});

test("isZeroTokenQuotaSignal_whenNestedCacheWriteCounterIsNonZero_returnsFalse", () => {
  assert.equal(
    isZeroTokenQuotaSignal({ input: 0, output: 0, cache: { read: 0, write: 250 } }),
    false,
  );
});

test("isZeroTokenQuotaSignal_whenNestedObjectIsEmpty_returnsTrue", () => {
  // Defensive pin: an empty nested object must not block the signal —
  // only a genuine nonzero numeric counter should.
  assert.equal(
    isZeroTokenQuotaSignal({ input: 0, output: 0, cache: {} }),
    true,
  );
});

test("isZeroTokenQuotaSignal_whenNonNumericStringFieldPresent_returnsTrue", () => {
  // Defensive pin: non-numeric non-object fields (e.g., a string model ID
  // tag) must be ignored — only numeric counters carry quota semantics.
  assert.equal(
    isZeroTokenQuotaSignal({ input: 0, output: 0, model: "kimi-k2-thinking" }),
    true,
  );
});

test("isZeroTokenQuotaSignal_whenTopLevelSiblingCounterIsNonZero_returnsFalse", () => {
  // Future-proofing pin: any top-level numeric counter that isn't input
  // or output must block the zero signal.
  assert.equal(
    isZeroTokenQuotaSignal({ input: 0, output: 0, total: 5_000 }),
    false,
  );
});

test("isZeroTokenQuotaSignal_whenNestedFieldIsNull_returnsTrueWithoutThrowing", () => {
  // M109 PDD surface 1: the nested walk's `value && typeof === "object"`
  // guards against `null` because `typeof null === "object"` in JavaScript.
  // A refactor to bare `typeof value === "object"` would invoke
  // `Object.values(null)` and throw from inside the hook handler — the
  // plugin's logPluginHookFailure would swallow the throw but the
  // classifier would silently no-op on every null-containing payload.
  assert.equal(
    isZeroTokenQuotaSignal({ input: 0, output: 0, cache: null }),
    true,
  );
});

test("isZeroTokenQuotaSignal_whenTopLevelCounterIsNaN_returnsFalse", () => {
  // M109 PDD surface 2: the top-level number check is `if (value !== 0)
  // return false;` and NaN !== 0 evaluates to true, so NaN is
  // conservatively treated as real activity and the quota signal is
  // suppressed. A defensive `Number.isFinite(value) && value !== 0`
  // refactor would skip NaN, return true, and quarantine a healthy
  // route on any session whose counter was ambiguously NaN.
  assert.equal(
    isZeroTokenQuotaSignal({ input: 0, output: 0, reasoning: Number.NaN }),
    false,
  );
});

test("isZeroTokenQuotaSignal_whenNestedFieldIsNonNumericString_returnsTrue", () => {
  // M109 PDD surface 3: the nested walker skips non-number values
  // (string, boolean, nested object, null) without affecting the
  // return. A debug / metadata field like `cache: { backend: "redis" }`
  // must NOT cause the classifier to think the cache had activity. A
  // tighter walker that rejected unexpected types as a safety measure
  // would silently flip metadata-bearing payloads from inert to
  // quota-penalizing.
  assert.equal(
    isZeroTokenQuotaSignal({
      input: 0,
      output: 0,
      cache: { backend: "redis", read: 0, write: 0 },
    }),
    true,
  );
});

// M53: `parseAgentFrontmatter` + `stripYamlScalarQuotes` — the agent
// frontmatter parser historically kept literal YAML quote chars in scalar
// values (`model:`, `routing_role:`, `routing_complexity:`), so any agent
// that quoted its model preference (required for model ids containing a
// colon-suffix like `:free` under strict YAML, and idiomatic for copy-
// pasted values) would have the preference silently dropped at the
// strict-equal preferred-model lookup in `recommendTaskModelRoute`. The
// block-list models parser ALREADY stripped quotes, so the scalar path
// was the only vulnerable site — and the inconsistency itself was a
// smell. Extract a pure helper so the parser contract can be tested
// directly without filesystem fixtures.

test("stripYamlScalarQuotes_whenUnquoted_returnsValueUnchanged", () => {
  assert.equal(
    stripYamlScalarQuotes("openrouter/stepfun/step-3.5-flash:free"),
    "openrouter/stepfun/step-3.5-flash:free",
  );
});

test("stripYamlScalarQuotes_whenDoubleQuoted_stripsOneLayer", () => {
  assert.equal(
    stripYamlScalarQuotes('"openrouter/stepfun/step-3.5-flash:free"'),
    "openrouter/stepfun/step-3.5-flash:free",
  );
});

test("stripYamlScalarQuotes_whenSingleQuoted_stripsOneLayer", () => {
  assert.equal(
    stripYamlScalarQuotes("'ollama-cloud/kimi-k2-thinking'"),
    "ollama-cloud/kimi-k2-thinking",
  );
});

test("stripYamlScalarQuotes_whenAsymmetricQuotes_leavesValueAlone", () => {
  // Matched-pair rule: only strip when BOTH ends carry the SAME quote
  // char. Asymmetric input is preserved verbatim so accidental
  // copy-paste errors upstream surface as a visible mismatch rather than
  // a silent corruption.
  assert.equal(stripYamlScalarQuotes('"foo'), '"foo');
  assert.equal(stripYamlScalarQuotes("foo'"), "foo'");
  assert.equal(stripYamlScalarQuotes("\"foo'"), "\"foo'");
});

test("stripYamlScalarQuotes_whenEmptyOrTooShort_returnsValueUnchanged", () => {
  assert.equal(stripYamlScalarQuotes(""), "");
  assert.equal(stripYamlScalarQuotes('"'), '"');
});

test("parseAgentFrontmatter_whenUnquotedModel_returnsRawValue", () => {
  const metadata = parseAgentFrontmatter([
    "name: codebase_explorer",
    "model: ollama-cloud/kimi-k2-thinking",
    "routing_role: long_context_reader",
    "routing_complexity: large",
  ].join("\n"));

  assert.equal(metadata.model, "ollama-cloud/kimi-k2-thinking");
  assert.equal(metadata.routing_role, "long_context_reader");
  assert.equal(metadata.routing_complexity, "large");
});

test("parseAgentFrontmatter_whenModelScalarIsDoubleQuoted_stripsQuotes", () => {
  // **Headline regression pin**: an agent authoring
  //   model: "openrouter/stepfun/step-3.5-flash:free"
  // must yield a metadata.model value EQUAL to the unquoted composite
  // route string so `recommendTaskModelRoute`'s strict-equal
  // preferred-model lookup matches it against registry routes. Before
  // this fix the value was `'"openrouter/stepfun/step-3.5-flash:free"'`
  // (literal quote chars) and the preference was silently dropped.
  const metadata = parseAgentFrontmatter([
    "name: stepfun_agent",
    'model: "openrouter/stepfun/step-3.5-flash:free"',
  ].join("\n"));

  assert.equal(metadata.model, "openrouter/stepfun/step-3.5-flash:free");
});

test("parseAgentFrontmatter_whenRoutingRoleIsSingleQuoted_stripsQuotes", () => {
  // Covers the `routing_role:` scalar path alongside the model pin above.
  // Single-quoted scalar variant — YAML permits both quote styles.
  const metadata = parseAgentFrontmatter([
    "name: deep_reviewer_agent",
    "routing_role: 'deep_reviewer'",
  ].join("\n"));

  assert.equal(metadata.routing_role, "deep_reviewer");
});

test("parseAgentFrontmatter_whenRoutingComplexityIsQuoted_acceptsStrippedValue", () => {
  // If the quote-strip happens BEFORE the complexity enum membership
  // check, `"small"` becomes `small` and is accepted. If quote-stripping
  // happens AFTER (or not at all), the literal `"small"` string fails
  // the `["small", "medium", "large"].includes` check and
  // `routing_complexity` is silently dropped. Pin the order.
  const metadata = parseAgentFrontmatter([
    "name: small_change_worker",
    'routing_complexity: "small"',
  ].join("\n"));

  assert.equal(metadata.routing_complexity, "small");
});

test("parseAgentFrontmatter_whenModelsBlockListHasQuotedItems_stripsQuotesPerItem", () => {
  // Regression pin for the block-list path: already worked before M53
  // via the inline `.replace(/^["']|["']$/g, "")`, but the refactor
  // routes it through `stripYamlScalarQuotes` so the behavior needs to
  // stay identical.
  const metadata = parseAgentFrontmatter([
    "name: multi_model_agent",
    "models:",
    '  - "ollama-cloud/glm-5"',
    "  - 'ollama-cloud/kimi-k2-thinking'",
    "  - opencode/minimax-m2.5-free",
  ].join("\n"));

  assert.deepEqual(metadata.models, [
    "ollama-cloud/glm-5",
    "ollama-cloud/kimi-k2-thinking",
    "opencode/minimax-m2.5-free",
  ]);
});

test("parseAgentFrontmatter_whenModelsInlineFlowStyleIsQuoted_stripsQuotesPerItem", () => {
  // Inline flow-style `[a, b, c]` variant — the old inline branch did
  // NOT strip quotes from flow-style items; the refactor does. Pin the
  // stronger contract.
  const metadata = parseAgentFrontmatter([
    "name: flow_style_agent",
    'models: ["ollama-cloud/glm-5", \'ollama-cloud/minimax-m2.7\']',
  ].join("\n"));

  assert.deepEqual(metadata.models, [
    "ollama-cloud/glm-5",
    "ollama-cloud/minimax-m2.7",
  ]);
});

test("parseAgentFrontmatter_whenRoutingComplexityIsInvalid_leavesFieldUnset", () => {
  // Pre-existing contract: unknown complexity values are silently
  // rejected (not assigned) so the caller falls back to inference.
  // Pin it so a future refactor doesn't regress the rejection.
  const metadata = parseAgentFrontmatter([
    "name: bad_complexity_agent",
    "routing_complexity: enormous",
  ].join("\n"));

  assert.equal(metadata.routing_complexity, undefined);
});

test("parseAgentFrontmatter_whenModelsBlockListFollowedByScalarKey_preservesTerminatorLineForNextIteration", () => {
  // M117 pin A: the block-list peek loop must NOT consume the
  // terminator line (the first non-list line that ends the block). The
  // peek shape is `if (!blockMatch) break;` BEFORE `lineIndex += 1;`,
  // which leaves the terminator line in place for the outer while to
  // re-read and dispatch normally. A refactor that moves `lineIndex +=
  // 1` before the break silently eats the terminator — so `routing_role
  // :` after a `models:` block disappears entirely. This is the
  // common case (most agent files declare `models:` immediately before
  // `routing_role:` / `routing_complexity:`), so the drift would drop
  // role/complexity hints across the whole agent catalog.
  const metadata = parseAgentFrontmatter([
    "name: terminator_survives_agent",
    "models:",
    "  - ollama-cloud/glm-5",
    "  - ollama-cloud/kimi-k2-thinking",
    "routing_role: architect",
  ].join("\n"));

  assert.equal(metadata.routing_role, "architect");
});

test("parseAgentFrontmatter_whenSiblingKeySharesModelPrefix_doesNotClobberStrictModelScalar", () => {
  // M117 pin B: key matching must be strict `===` equality, not
  // `.startsWith`. A sibling key like `model_preference:` must land in
  // none of the branches and be silently ignored — it must NOT clobber
  // the real `model:` scalar. The order of lines is deliberate:
  // `model:` comes FIRST and `model_preference:` comes SECOND, so a
  // refactor to `key.startsWith("model")` would have both lines land
  // in the `model` branch and the LATER assignment (`"bar"`) would win.
  // Under strict equality, the real `model:` scalar is the only line
  // that matches and its value survives.
  const metadata = parseAgentFrontmatter([
    "name: sibling_key_agent",
    "model: openrouter/stepfun/step-3.5-flash:free",
    "model_preference: bar",
  ].join("\n"));

  assert.equal(metadata.model, "openrouter/stepfun/step-3.5-flash:free");
});

test("parseAgentFrontmatter_whenDashIsAtColumnZero_rejectsAsNonNestedListItem", () => {
  // M117 pin C: the block-list regex `/^\s+-\s+(.*)$/` requires leading
  // whitespace — `\s+`, not `\s*`. A column-0 dash is not a nested list
  // item; YAML only permits block-list items when they are indented
  // inside their parent key. A "simplification" dropping the `+` to
  // `\s*` would accept column-0 dashes as valid items and silently
  // pull in dangling sequence nodes from comments or broken lists.
  // The assertion is formulated as "the forbidden item must NOT appear
  // in metadata.models" so it stays orthogonal to sabotages that make
  // `metadata.models` undefined for unrelated reasons.
  const metadata = parseAgentFrontmatter([
    "name: column_zero_dash_agent",
    "models:",
    "- forbidden-column-zero-item",
  ].join("\n"));

  const containsForbidden =
    Array.isArray(metadata.models)
    && metadata.models.includes("- forbidden-column-zero-item");
  const containsForbiddenStripped =
    Array.isArray(metadata.models)
    && metadata.models.includes("forbidden-column-zero-item");
  assert.equal(
    containsForbidden || containsForbiddenStripped,
    false,
    "column-0 dashes must not be collected as block-list items",
  );
});

test("parseHangTimeoutMs_whenUndefined_returnsDefault", () => {
  assert.equal(parseHangTimeoutMs(undefined), DEFAULT_ROUTE_HANG_TIMEOUT_MS);
});

test("parseHangTimeoutMs_whenEmptyString_returnsDefault", () => {
  // Empty env var (`AICODER_ROUTE_HANG_TIMEOUT_MS=`) must be treated as
  // unset, not as `Number("") === 0` which would flip the call site into
  // the immediate-penalty test branch on every session.
  assert.equal(parseHangTimeoutMs(""), DEFAULT_ROUTE_HANG_TIMEOUT_MS);
});

test("parseHangTimeoutMs_whenValidIntegerString_returnsValue", () => {
  assert.equal(parseHangTimeoutMs("450000"), 450000);
});

test("parseHangTimeoutMs_whenZeroString_returnsZeroForTestShortPath", () => {
  // The `chat.params` call site uses `timeoutMs < 1000` as the test-mode
  // immediate-penalty trigger. Genuine test callers must still be able
  // to request that branch with `"0"` or `"500"`.
  assert.equal(parseHangTimeoutMs("0"), 0);
});

test("parseHangTimeoutMs_whenNonNumericString_returnsDefault", () => {
  // Headline pin: a typo like `AICODER_ROUTE_HANG_TIMEOUT_MS=abc` used
  // to land as `parseInt("abc", 10) === NaN`. `NaN < 1000` is `false`
  // so the code entered the production `setTimeout(fn, NaN + 100)`
  // branch, which Node coerces to a ~1ms delay — firing
  // `finalizeHungSessionState` immediately and recording a spurious
  // `"timeout"` penalty against the session's route. Every subsequent
  // session repeated the penalty until the operator noticed the env
  // typo, silently blacking out every route in the registry. The
  // helper now falls back to `DEFAULT_ROUTE_HANG_TIMEOUT_MS` on NaN.
  assert.equal(parseHangTimeoutMs("abc"), DEFAULT_ROUTE_HANG_TIMEOUT_MS);
});

test("parseHangTimeoutMs_whenTrailingGarbageAppendedToValidInteger_returnsDefault", () => {
  // `parseInt("450000abc", 10)` silently returned `450000`, hiding
  // operator misconfiguration (the wrong value is honored as-if the
  // garbage were a valid suffix). `Number("450000abc")` returns `NaN`,
  // which the helper rejects, surfacing the typo as a safe fallback to
  // `DEFAULT_ROUTE_HANG_TIMEOUT_MS` rather than a silent-accept of a
  // partially-parsed value. The literal deliberately is NOT the
  // default so this pin discriminates against the old `parseInt`
  // semantics rather than coincidentally matching on the default.
  assert.equal(
    parseHangTimeoutMs("450000abc"),
    DEFAULT_ROUTE_HANG_TIMEOUT_MS,
  );
});

test("parseHangTimeoutMs_whenNegativeString_returnsDefault", () => {
  // A negative timeout is never a "test mode" request — it is a
  // misconfiguration. `parseInt("-1", 10) === -1` used to satisfy
  // `< 1000` and fire the immediate-penalty branch on every session.
  // The helper now rejects negatives and falls back.
  assert.equal(parseHangTimeoutMs("-1"), DEFAULT_ROUTE_HANG_TIMEOUT_MS);
});

test("parseHangTimeoutMs_whenFloatString_truncatesToInteger", () => {
  // `setTimeout` coerces fractional delays anyway, but pinning the
  // truncation keeps the return type a clean integer for the
  // `< 1000` comparison and any arithmetic downstream.
  assert.equal(parseHangTimeoutMs("123456.789"), 123456);
});

test("hasUsableCredential_whenApiKeyEntryIsNonEmpty_returnsTrue", () => {
  assert.equal(hasUsableCredential({ type: "api", key: "sk-abc" }), true);
});

test("hasUsableCredential_whenApiKeyEntryIsEmpty_returnsFalse", () => {
  assert.equal(hasUsableCredential({ type: "api", key: "" }), false);
});

test("hasUsableCredential_whenOauthEntryHasAccessTokenOnly_returnsTrue", () => {
  assert.equal(
    hasUsableCredential({ type: "oauth", access: "at-abc", refresh: "" }),
    true,
  );
});

test("hasUsableCredential_whenOauthEntryHasEmptyAccessButValidRefresh_returnsTrue", () => {
  // Headline regression pin: this is the latent production shape. When
  // opencode clears an expired access token, the on-disk entry lands as
  // `{ type: "oauth", access: "", refresh: "<valid>" }` and opencode
  // transparently refreshes on the next provider request. The pre-M55
  // predicate only inspected `access`, so the plugin would flag the
  // provider `key_missing` at init and cascade a 2h health penalty that
  // suppressed every route under that provider — a plugin-level outage
  // opencode itself would have resolved on the first request. The
  // refresh token is an independent usability signal and must yield true.
  assert.equal(
    hasUsableCredential({ type: "oauth", access: "", refresh: "rt-valid" }),
    true,
  );
});

test("hasUsableCredential_whenOauthEntryHasBothTokensEmpty_returnsFalse", () => {
  // Genuinely empty oauth entries (neither token set) must still flag
  // as unusable — the refresh allowance only kicks in when refresh is
  // itself a non-empty string.
  assert.equal(
    hasUsableCredential({ type: "oauth", access: "", refresh: "" }),
    false,
  );
});

test("hasUsableCredential_whenOauthEntryHasRefreshFieldMissing_fallsBackToAccessCheck", () => {
  // Defensive pin: the refresh branch must not throw or return true on
  // a missing field. When `refresh` is undefined, the coalesce-to-""
  // guard inside the helper keeps the check equivalent to the pre-M55
  // access-only behavior for that shape.
  assert.equal(
    hasUsableCredential({ type: "oauth", access: "at-abc" }),
    true,
  );
  assert.equal(
    hasUsableCredential({ type: "oauth", access: "" }),
    false,
  );
});

test("hasUsableCredential_whenEntryIsNonEmptyString_returnsTrue", () => {
  // Legacy fixture shape: bare strings are accepted for back-compat.
  assert.equal(hasUsableCredential("sk-legacy"), true);
});

test("hasUsableCredential_whenEntryIsEmptyString_returnsFalse", () => {
  assert.equal(hasUsableCredential(""), false);
});

test("hasUsableCredential_whenEntryIsNullOrUndefined_returnsFalse", () => {
  assert.equal(hasUsableCredential(null), false);
  assert.equal(hasUsableCredential(undefined), false);
});

test("hasUsableCredential_whenLegacyApiKeyShape_returnsTrue", () => {
  // Legacy `{ apiKey: "..." }` shape preserved for old fixtures.
  assert.equal(hasUsableCredential({ apiKey: "sk-legacy" }), true);
});

test("findPreferredHealthyRoute_whenPreferredModelsEmpty_returnsNull", () => {
  const entries = [
    buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 1 },
    ]),
  ];
  const decision = findPreferredHealthyRoute(
    [],
    entries,
    new Map(),
    new Map(),
    0,
  );
  assert.equal(decision, null);
});

test("findPreferredHealthyRoute_whenExactPreferredRouteIsHealthy_returnsExactRoute", () => {
  const entries = [
    buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 1 },
      { provider: "opencode-go", model: "opencode-go/glm-5.1", priority: 2 },
    ]),
  ];
  const decision = findPreferredHealthyRoute(
    ["ollama-cloud/glm-5.1"],
    entries,
    new Map(),
    new Map(),
    0,
  );
  assert.deepEqual(decision, {
    selectedModelRoute: "ollama-cloud/glm-5.1",
    reasoning: "Preferred model from agent metadata, healthy provider",
  });
});

test("findPreferredHealthyRoute_whenExactPreferredRouteIsUnhealthyButSiblingHealthy_returnsSibling", () => {
  const entries = [
    buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 1 },
      { provider: "opencode-go", model: "opencode-go/glm-5.1", priority: 2 },
    ]),
  ];
  const providerHealthMap = new Map([
    [
      "ollama-cloud",
      { state: "quota" as const, until: 100, retryCount: 0 },
    ],
  ]);
  const decision = findPreferredHealthyRoute(
    ["ollama-cloud/glm-5.1"],
    entries,
    providerHealthMap,
    new Map(),
    50,
  );
  assert.deepEqual(decision, {
    selectedModelRoute: "opencode-go/glm-5.1",
    reasoning: "Preferred model from agent metadata, healthy fallback provider",
  });
});

test("findPreferredHealthyRoute_whenNoPreferredRouteMatchesAnyEntry_returnsNull", () => {
  const entries = [
    buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 1 },
    ]),
  ];
  const decision = findPreferredHealthyRoute(
    ["some-other/model-not-in-registry"],
    entries,
    new Map(),
    new Map(),
    0,
  );
  assert.equal(decision, null);
});

test("findPreferredHealthyRoute_whenAuthorOrderHasMultiplePreferences_honorsFirstHealthy", () => {
  // Author-order pin: the caller lists preferences in priority order, so
  // the helper must return the FIRST preference whose entry yields a
  // healthy route, even when later preferences would also be healthy.
  const entries = [
    buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 1 },
    ]),
    buildModelRegistryEntry("minimax-m2.5", ["architect"], "frontier", [
      { provider: "minimax", model: "minimax/MiniMax-M2.5", priority: 1 },
    ]),
  ];
  const decision = findPreferredHealthyRoute(
    ["minimax/MiniMax-M2.5", "ollama-cloud/glm-5.1"],
    entries,
    new Map(),
    new Map(),
    0,
  );
  assert.equal(decision?.selectedModelRoute, "minimax/MiniMax-M2.5");
});

test("findPreferredHealthyRoute_whenCallerPassesOnlyTierFilteredEntriesAndPreferredTierExcluded_returnsNull", () => {
  // Negative pin that documents the caller's contract: if the caller
  // accidentally passes a tier-filtered candidate set (e.g. only
  // ["tiny","fast","standard"] entries for a "small" complexity) and
  // the agent's frontier-tier preference is NOT in that set, the helper
  // correctly returns null — BUT the FIX in `recommendTaskModelRoute`
  // must pass a role-only-filtered list so the preference is found.
  // This pin proves the helper itself is not the place that respects
  // tier; `recommendTaskModelRoute` is. It prevents a future refactor
  // from quietly re-tightening the candidate set inside the helper.
  const entries = [
    buildModelRegistryEntry("kimi-k2.5", ["architect"], "fast", [
      { provider: "ollama-cloud", model: "ollama-cloud/kimi-k2.5", priority: 1 },
    ]),
    // Deliberately NOT included in entries: a frontier-tier minimax
    // registry entry, simulating the pre-fix bug where
    // `roleMatchedEntries` filtered it out via allowedTiers.
  ];
  const decision = findPreferredHealthyRoute(
    ["minimax/MiniMax-M2.5"],
    entries,
    new Map(),
    new Map(),
    0,
  );
  assert.equal(decision, null);
});

test("recommendTaskModelRoute_whenAgentModelPreferenceIsFrontierTierButPromptInfersSmallComplexity_honorsPreference", async () => {
  // Headline M56 regression pin: an agent that declares a frontier-tier
  // preferred model must NOT have that preference silently dropped when
  // the task prompt triggers `inferTaskComplexity` to return "small".
  // Pre-M56 the preferred-models lookup iterated `roleMatchedEntries`,
  // which had ALREADY been narrowed by the complexity-tier filter, so
  // the minimax/MiniMax-M2.5 entry (frontier) was absent from the scan
  // and the preference was silently dropped. The task then routed to
  // some tiny/fast model the agent never asked for. Fix: thread a
  // role-only-filtered candidate set into `findPreferredHealthyRoute`
  // so explicit author preference outranks inferred complexity.
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), "aicoder-model-routing-m56-"),
  );
  await writeAgentMetadata(
    tempDirectory,
    "typo_fixer",
    [
      "---",
      "model: minimax/MiniMax-M2.5",
      "routing_role: architect",
      // DELIBERATELY NO routing_complexity: so inferTaskComplexity runs.
      "---",
      "",
      "Typo fixer agent.",
      "",
    ].join("\n"),
  );

  const modelRegistryEntries = [
    // Frontier-tier entry the agent wants — the one that was silently
    // dropped pre-M56 because its tier was outside the small-complexity
    // allowedTiers.
    buildModelRegistryEntry("minimax-m2.5", ["architect"], "frontier", [
      { provider: "minimax", model: "minimax/MiniMax-M2.5", priority: 1 },
    ]),
    // A small-complexity-allowed alternative the pre-M56 path would
    // have selected when the preference was dropped.
    buildModelRegistryEntry("kimi-k2.5", ["architect"], "fast", [
      { provider: "ollama-cloud", model: "ollama-cloud/kimi-k2.5", priority: 1 },
    ]),
  ];

  const decision = await recommendTaskModelRoute(
    tempDirectory,
    {
      subagent_type: "typo_fixer",
      // Prompt engineered to trigger inferTaskComplexity → "small"
      // (word "typo" is a SMALL_COMPLEXITY_KEYWORD_STEM).
      prompt: "fix typo in README",
      agent: "typo_fixer",
    },
    modelRegistryEntries,
    new Map(),
    new Map(),
    0,
  );

  assert.equal(decision.selectedModelRoute, "minimax/MiniMax-M2.5");
  assert.match(decision.reasoning, /Preferred model from agent metadata/);
});

test("findFirstHealthyVisibleRoute_whenCandidateListEmpty_returnsNull", () => {
  const result = findFirstHealthyVisibleRoute([], new Map(), new Map(), 0);
  assert.equal(result, null);
});

test("findFirstHealthyVisibleRoute_whenFirstEntryHasHealthyRoute_returnsFirstMatch", () => {
  const entries = [
    buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 1 },
    ]),
    buildModelRegistryEntry("minimax-m2.5", ["architect"], "frontier", [
      { provider: "minimax", model: "minimax/MiniMax-M2.5", priority: 1 },
    ]),
  ];

  const result = findFirstHealthyVisibleRoute(entries, new Map(), new Map(), 0);

  assert.deepEqual(result, {
    provider: "ollama-cloud",
    model: "ollama-cloud/glm-5.1",
  });
});

test("findFirstHealthyVisibleRoute_whenFirstEntryProviderUnhealthy_returnsNextHealthyEntry", () => {
  const entries = [
    buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 1 },
    ]),
    buildModelRegistryEntry("minimax-m2.5", ["architect"], "frontier", [
      { provider: "minimax", model: "minimax/MiniMax-M2.5", priority: 1 },
    ]),
  ];
  const providerHealthMap = new Map([
    ["ollama-cloud", { state: "quota" as const, until: 1_000_000, retryCount: 1 }],
  ]);

  const result = findFirstHealthyVisibleRoute(
    entries,
    providerHealthMap,
    new Map(),
    0,
  );

  assert.deepEqual(result, {
    provider: "minimax",
    model: "minimax/MiniMax-M2.5",
  });
});

test("findFirstHealthyVisibleRoute_whenRouteLevelPenaltyBlocksPrimaryButSiblingHealthy_returnsSibling", () => {
  const entries = [
    buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 1 },
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 2 },
    ]),
  ];
  const modelRouteHealthMap = new Map([
    [
      "ollama-cloud/glm-5.1",
      { state: "model_not_found" as const, until: 1_000_000, retryCount: 1 },
    ],
  ]);

  const result = findFirstHealthyVisibleRoute(
    entries,
    new Map(),
    modelRouteHealthMap,
    0,
  );

  assert.deepEqual(result, {
    provider: "opencode",
    model: "opencode/glm-5.1-free",
  });
});

test("findFirstHealthyVisibleRoute_whenEveryCandidateIsUnhealthy_returnsNull", () => {
  const entries = [
    buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 1 },
    ]),
  ];
  const providerHealthMap = new Map([
    ["ollama-cloud", { state: "quota" as const, until: 1_000_000, retryCount: 1 }],
  ]);

  const result = findFirstHealthyVisibleRoute(
    entries,
    providerHealthMap,
    new Map(),
    0,
  );

  assert.equal(result, null);
});

test("recommendTaskModelRoute_whenComplexityTierFullyDownButSiblingTierHealthy_degradesToSiblingTier", async () => {
  // M57 headline pin. Reachability: a large-complexity request arrives
  // while every strong/frontier provider is throttled (quota + key_dead
  // during a real multi-provider outage), but a standard-tier entry
  // with the same role is perfectly healthy. Pre-M57 the last-resort
  // fallback only scanned `roleMatchedEntries` — already narrowed by
  // `allowedTiers = ["strong", "frontier"]` — so it saw nothing healthy
  // and threw "No healthy model route found", killing the request even
  // though a working alternative was one tier removed. Fix widens the
  // last-resort scan to a tier-agnostic second pass over
  // `rolePreferredEntries` via `findFirstHealthyVisibleRoute`.
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), "aicoder-model-routing-m57-"),
  );
  await writeAgentMetadata(
    tempDirectory,
    "architect_agent",
    [
      "---",
      "routing_role: architect",
      "routing_complexity: large",
      "---",
      "",
      "Architect agent.",
      "",
    ].join("\n"),
  );

  const modelRegistryEntries = [
    // Frontier tier: within allowedTiers but route throttled.
    buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 1 },
    ]),
    // Strong tier: within allowedTiers but provider throttled.
    buildModelRegistryEntry("qwen3-coder-plus", ["architect"], "strong", [
      { provider: "iflowcn", model: "iflowcn/qwen3-coder-plus", priority: 1 },
    ]),
    // Standard tier: OUTSIDE allowedTiers for large complexity, fully
    // healthy — the only route the caller can actually reach.
    buildModelRegistryEntry("glm-4.7-standard", ["architect"], "standard", [
      { provider: "opencode", model: "opencode/glm-4.7-free", priority: 1 },
    ]),
  ];

  const providerHealthMap = new Map([
    ["iflowcn", { state: "quota" as const, until: 1_000_000, retryCount: 1 }],
  ]);
  const modelRouteHealthMap = new Map([
    [
      "ollama-cloud/glm-5.1",
      { state: "timeout" as const, until: 1_000_000, retryCount: 1 },
    ],
  ]);

  const decision = await recommendTaskModelRoute(
    tempDirectory,
    {
      subagent_type: "architect_agent",
      prompt: "refactor the system architecture across modules",
      agent: "architect_agent",
    },
    modelRegistryEntries,
    providerHealthMap,
    modelRouteHealthMap,
    0,
  );

  assert.equal(decision.selectedModelRoute, "opencode/glm-4.7-free");
  assert.match(decision.reasoning, /outside complexity tier/);
});

// M92 pin A — role-row cap: the slice cap on rendered roles must stay
// at `MAX_AVAILABLE_MODELS_ROLES_RENDERED` (8). A caller that lowers the
// cap (e.g. back to an inline `.slice(0, 3)`) or raises it (no cap at
// all) drifts from the system-prompt contract and flips this pin.
test("renderAvailableModelsSystemPromptBody_whenMapExceedsCap_rendersExactlyEightRoleRows", () => {
  const roleToModels = new Map<string, string[]>();
  for (let index = 0; index < 12; index += 1) {
    roleToModels.set(`role_${index}`, [`model_${index} (paid_api)`]);
  }

  const rendered = renderAvailableModelsSystemPromptBody(roleToModels);

  assert.ok(rendered !== null);
  const allLines = rendered.split("\n");
  // The section has one header line plus one line per rendered role.
  // Count total lines minus the header rather than filtering by bullet
  // char so pin B (row format) can fail independently of this pin.
  assert.equal(allLines.length - 1, 8);
});

// M92 pin B — row format: every rendered row must be exactly
// `- ${role}: ${models.join(", ")}`. A caller that switches the bullet
// char, the colon, or the join separator flips this pin without
// touching the cap pin or the null-sentinel pin.
test("renderAvailableModelsSystemPromptBody_whenSingleRoleWithTwoModels_rendersExactBulletFormat", () => {
  const roleToModels = new Map<string, string[]>([
    ["planner", ["alpha-model (free)", "beta-model (paid_api)"]],
  ]);

  const rendered = renderAvailableModelsSystemPromptBody(roleToModels);

  assert.ok(rendered !== null);
  const rowLines = rendered.split("\n").filter((line) => line.startsWith("- "));
  assert.deepEqual(rowLines, [
    "- planner: alpha-model (free), beta-model (paid_api)",
  ]);
});

// M92 pin C — empty-input null sentinel: an empty map must return
// `null`, not an empty string and not a header-only section. The outer
// caller relies on `null` to filter the section out of the final
// assembled prompt without leaving a blank header behind.
test("renderAvailableModelsSystemPromptBody_whenMapIsEmpty_returnsNullNotEmptyString", () => {
  const rendered = renderAvailableModelsSystemPromptBody(new Map());

  assert.equal(rendered, null);
});

// M93 pin A — enabled-gate: a disabled entry with an otherwise-matching
// role must never survive. Uses a concrete role (not null) so sabotages
// 2 and 3 can't fire this pin — they only affect the role predicate.
test("filterEnabledEntriesByOptionalRole_whenDisabledEntryShareRoleWithEnabled_dropsDisabled", () => {
  const enabledCodingEntry = buildModelRegistryEntry("m-enabled", ["coding"], "standard", [
    { provider: "opencode", model: "opencode/free-a", priority: 1 },
  ]);
  const disabledCodingEntry: ModelRegistryEntry = {
    ...buildModelRegistryEntry("m-disabled", ["coding"], "standard", [
      { provider: "opencode", model: "opencode/free-b", priority: 1 },
    ]),
    enabled: false,
  };

  const result = filterEnabledEntriesByOptionalRole(
    [enabledCodingEntry, disabledCodingEntry],
    "coding",
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "m-enabled");
});

// M93 pin B — null-role passthrough: when `role === null`, every enabled
// entry survives regardless of its own `default_roles`. Uses two enabled
// entries with disjoint roles so dropping the `role &&` short-circuit
// (which would turn this into `.includes(null)` false for both) empties
// the result. Pin A uses a concrete role so it cannot fire here; pin C
// also uses a concrete role.
test("filterEnabledEntriesByOptionalRole_whenRoleIsNull_passesAllEnabledEntriesRegardlessOfRoles", () => {
  const codingEntry = buildModelRegistryEntry("m-coding", ["coding"], "standard", [
    { provider: "opencode", model: "opencode/free-c", priority: 1 },
  ]);
  const architectEntry = buildModelRegistryEntry("m-architect", ["architect"], "strong", [
    { provider: "opencode", model: "opencode/free-d", priority: 1 },
  ]);

  const result = filterEnabledEntriesByOptionalRole(
    [codingEntry, architectEntry],
    null,
  );

  assert.equal(result.length, 2);
});

// M93 pin C — role-membership exactness: when a concrete role is passed,
// only entries whose `default_roles` contains that exact string survive.
// Uses two enabled entries with disjoint roles so dropping the
// `.includes(role)` check (always-pass) would lift the architect entry
// into the coding result set. Pin A also uses concrete role but its
// assertion partitions on disabled-vs-enabled; pin B uses null role.
// M94 pin A — leading-boundary-only semantics: the regex must match
// inflections like "refactoring" from a stem "refactor". A refactor
// that adds a trailing `\b` turns this into exact-word match and
// silently fails. Uses lowercase + single-word stem so neither the
// escape pin nor the case-fold pin can fire here.
test("buildLeadingBoundaryRegex_whenStemIsRefactor_matchesInflectionRefactoring", () => {
  const regex = buildLeadingBoundaryRegex(["refactor"]);

  assert.equal(regex.test("refactoring this module"), true);
});

// M94 pin B — metacharacter escape: a stem containing `.` must only
// match that literal `.`, not any character. Uses a lowercase stem so
// pin C (case-fold) cannot fire; uses a two-assertion pair so any
// drift in the escape behavior (dropped entirely, or narrowed to the
// wrong charset) flips the second assertion without touching pin A.
test("buildLeadingBoundaryRegex_whenStemContainsDot_escapesDotAsLiteral", () => {
  const regex = buildLeadingBoundaryRegex(["node.js"]);

  assert.equal(regex.test("node.js runtime"), true);
  assert.equal(regex.test("nodeXjs runtime"), false);
});

// M94 pin C — case-insensitive flag: a lowercase stem must match an
// uppercase prompt. A refactor that drops the `"i"` flag silently
// under-tiers every mixed-case prompt. Uses a no-metachar single-word
// stem so pin B cannot fire; uses the full capitalized form (no
// inflection) so pin A cannot fire.
test("buildLeadingBoundaryRegex_whenStemIsLowerCaseButPromptIsUpperCase_matches", () => {
  const regex = buildLeadingBoundaryRegex(["refactor"]);

  assert.equal(regex.test("REFACTOR"), true);
});

test("filterEnabledEntriesByOptionalRole_whenRoleIsCoding_excludesArchitectEntry", () => {
  const codingEntry = buildModelRegistryEntry("m-coding", ["coding"], "standard", [
    { provider: "opencode", model: "opencode/free-e", priority: 1 },
  ]);
  const architectEntry = buildModelRegistryEntry("m-architect", ["architect"], "strong", [
    { provider: "opencode", model: "opencode/free-f", priority: 1 },
  ]);

  const result = filterEnabledEntriesByOptionalRole(
    [codingEntry, architectEntry],
    "coding",
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "m-coding");
});

// M95 pin A — enabled gate: a disabled registry entry must NOT
// contribute to the visible set. Uses UNPREFIXED raw model ids
// (LongCat-style) so pin C's strip is a no-op here and a strip-off
// refactor leaves this pin green. Uses same-provider routes on both
// entries so pin B (cross-provider leak) cannot fire. Size check
// discriminates disabled passthrough.
test("buildEnabledProviderModelSet_whenDisabledEntryShareProviderWithEnabled_dropsDisabled", () => {
  const enabledEntry = buildModelRegistryEntry("m-enabled", ["coding"], "standard", [
    { provider: "openrouter", model: "alpha", priority: 1 },
  ]);
  const disabledEntry: ModelRegistryEntry = {
    ...buildModelRegistryEntry("m-disabled", ["coding"], "standard", [
      { provider: "openrouter", model: "beta", priority: 1 },
    ]),
    enabled: false,
  };

  const result = buildEnabledProviderModelSet(
    [enabledEntry, disabledEntry],
    "openrouter",
  );

  assert.equal(result.size, 1);
  assert.equal(result.has("alpha"), true);
});

// M95 pin B — provider filter: a route targeting a DIFFERENT provider
// must never leak into this provider's visible set. Uses UNPREFIXED
// model strings on both entries so pin C (strip) is a no-op and a
// strip-off refactor cannot fire this pin. Both entries are enabled so
// pin A (enabled gate) cannot fire. Size+has check discriminates the
// cross-provider leak.
test("buildEnabledProviderModelSet_whenEntryTargetsDifferentProvider_excludedFromResult", () => {
  const openrouterEntry = buildModelRegistryEntry("m-or", ["coding"], "standard", [
    { provider: "openrouter", model: "alpha", priority: 1 },
  ]);
  const ollamaEntry = buildModelRegistryEntry("m-oc", ["coding"], "standard", [
    { provider: "ollama-cloud", model: "gamma", priority: 1 },
  ]);

  const result = buildEnabledProviderModelSet(
    [openrouterEntry, ollamaEntry],
    "openrouter",
  );

  assert.equal(result.size, 1);
  assert.equal(result.has("alpha"), true);
});

// M95 pin C — prefix-strip normalization: the raw id added to the set
// must be the provider-RELATIVE form ("zoo"), not the composite
// registry form ("openrouter/zoo"). Uses one enabled entry targeting
// the queried provider so neither pin A nor pin B can fire; the raw
// `.has("zoo")` check discriminates strip-on vs strip-off because a
// strip-off refactor would populate the set with "openrouter/zoo".
test("buildEnabledProviderModelSet_whenRouteModelHasCompositePrefix_stripsProviderPrefix", () => {
  const entry = buildModelRegistryEntry("m-strip", ["coding"], "standard", [
    { provider: "openrouter", model: "openrouter/zoo", priority: 1 },
  ]);

  const result = buildEnabledProviderModelSet([entry], "openrouter");

  assert.equal(result.has("zoo"), true);
});

// M96 pin A — override table passthrough: a provider pinned in
// PROVIDER_ENV_VAR_OVERRIDES (google has a TWO-name override
// `["GEMINI_API_KEY", "GOOGLE_API_KEY"]`) must return the override
// list verbatim. A refactor that drops the early-return and always
// computes the conventional form would collapse google to the
// single-element `["GOOGLE_API_KEY"]`. The length check discriminates
// this cleanly without touching the casing or dash-handling surfaces
// (google has no dashes and only fits the override-consultation axis).
test("providerEnvVarCandidates_whenProviderHasMultiNameOverride_returnsOverrideListVerbatim", () => {
  const candidates = providerEnvVarCandidates("google");

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0], "GEMINI_API_KEY");
  assert.equal(candidates[1], "GOOGLE_API_KEY");
});

// M96 pin B — dash-to-underscore normalization: a non-overridden
// provider id containing a dash must produce an env var name with no
// dash remaining (POSIX shell vars forbid `-`). A refactor that drops
// the `.replace(/-/g, "_")` leaves `"OLLAMA-CLOUD_API_KEY"` in place.
// The assertion is intentionally "no dash remains in result[0]" — not
// an exact full-string match — so this pin is orthogonal to pin C's
// casing surface: a lowercase-leaking sabotage still produces no dash
// and leaves pin B green. "ollama-cloud" is NOT in the override table
// so pin A's surface is untouched.
test("providerEnvVarCandidates_whenProviderIdContainsDash_substitutesUnderscore", () => {
  const candidates = providerEnvVarCandidates("ollama-cloud");

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.includes("-"), false);
});

// M96 pin C — conventional form uppercase + `_API_KEY` suffix: a
// non-overridden provider id with no dashes and lowercase letters
// must produce an exact `<UPPER>_API_KEY` form. A refactor that drops
// `.toUpperCase()` produces `foo_API_KEY`, and a refactor that drops
// the `_API_KEY` suffix produces bare `FOO` — either way this exact
// match flips. Uses `"foo"` which is NOT in the override table
// (orthogonal to pin A) and has NO dashes (orthogonal to pin B's
// dash-substitution surface).
test("providerEnvVarCandidates_whenProviderIdIsLowerAlphaOnly_producesUpperConventionalForm", () => {
  const candidates = providerEnvVarCandidates("foo");

  assert.deepEqual(candidates, ["FOO_API_KEY"]);
});

// M97 pin A — header-first invariant: the canonical
// `"## Active model routing context"` header MUST be the first line of
// the rendered section so opencode's chat-system transform pipeline
// can locate the block by header match. A refactor that drops the
// header line silently merges this section into whichever section
// rendered before it. Only asserts that `split("\n")[0]` equals the
// header literal — orthogonal to pins B and C which inspect body
// lines, so neither separator sabotage can fire this pin.
test("buildRoutingContextSystemPrompt_whenRenderingEntry_emitsHeaderAsFirstLine", () => {
  const entry: ModelRegistryEntry = {
    ...buildModelRegistryEntry("m-hdr", ["coding"], "standard", [
      { provider: "openrouter", model: "openrouter/hdr-model", priority: 1 },
    ]),
    description: "header pin entry",
    best_for: ["bulk coding"],
    not_for: [],
    concurrency: 2,
    cost_tier: "cheap",
    billing_mode: "paid_api",
  };

  const rendered = buildRoutingContextSystemPrompt(entry);

  assert.equal(rendered.split("\n")[0], "## Active model routing context");
});

// M97 pin B — multi-value comma-space separator: the `Roles:` line
// must join array values with the canonical `", "` (comma + space)
// separator. A refactor that drops the space (the "commas are commas"
// drift class) turns `"coding, architect"` into `"coding,architect"`,
// silently breaking every downstream parser that splits on `", "`.
// Asserts an EXACT-string match on the Roles line only — does not
// inspect the header (pin A's surface) or the cost-tier line (pin C's
// surface), so a header-drop or pipe-change sabotage cannot fire pin B.
test("buildRoutingContextSystemPrompt_whenRolesIsMultiValue_joinsWithCommaSpaceSeparator", () => {
  const entry: ModelRegistryEntry = {
    ...buildModelRegistryEntry("m-roles", ["coding", "architect"], "standard", [
      { provider: "openrouter", model: "openrouter/roles-model", priority: 1 },
    ]),
    description: "roles pin entry",
    best_for: ["bulk coding"],
    not_for: [],
    concurrency: 2,
    cost_tier: "cheap",
    billing_mode: "paid_api",
  };

  const rendered = buildRoutingContextSystemPrompt(entry);
  const rolesLine = rendered.split("\n").find((line) => line.startsWith("Roles:"));

  assert.equal(rolesLine, "Roles: coding, architect");
});

// M97 pin C — cost-tier + billing-mode `" | "` fusion: the final line
// fuses two distinct semantic axes onto one line with a pipe
// separator. A refactor that changes the separator to `"/"`, `","`,
// or plain whitespace silently makes the line ambiguous to any naive
// `Cost tier: (\w+)` extractor. Asserts the exact full line so any
// drift in the two labels, the pipe, or the values flips. Uses
// `cost_tier: "cheap"` and `billing_mode: "paid_api"` — a lowercase
// single-word + underscore-form pair so the `Roles:` line does not
// overlap pin B's assertion, and the header is untouched so pin A is
// unaffected.
test("buildRoutingContextSystemPrompt_whenRenderingEntry_fusesCostTierAndBillingWithPipeSeparator", () => {
  const entry: ModelRegistryEntry = {
    ...buildModelRegistryEntry("m-cost", ["coding"], "standard", [
      { provider: "openrouter", model: "openrouter/cost-model", priority: 1 },
    ]),
    description: "cost pin entry",
    best_for: ["bulk coding"],
    not_for: [],
    concurrency: 2,
    cost_tier: "cheap",
    billing_mode: "paid_api",
  };

  const rendered = buildRoutingContextSystemPrompt(entry);
  const costLine = rendered.split("\n").find((line) => line.startsWith("Cost tier:"));

  assert.equal(costLine, "Cost tier: cheap | Billing: paid_api");
});

// M98 pin A — `"QUOTA BACKOFF"` carries the `"BACKOFF"` suffix: the
// `quota` state is the only transient-recoverable state with a
// suffix word beyond the bare state name, signalling to the agent
// that the recovery action is "wait the window out". A refactor that
// drops the suffix (returning just `"QUOTA"`) silently desynchronizes
// quota from the agent's "wait it out" recovery prompts. Asserts the
// suffix predicate `.endsWith("BACKOFF")` specifically — not a
// full-string match — so any sabotage at pin B's surface (underscore
// substitution on multi-word states) or pin C's surface (three-word
// model_not_found) leaves this pin green because neither touches the
// quota case.
test("healthStateLabel_whenStateIsQuota_labelCarriesBackoffSuffix", () => {
  const label = healthStateLabel("quota");

  assert.equal(label.endsWith("BACKOFF"), true);
});

// M98 pin B — underscore → space substitution: every multi-word
// state uses ASCII SPACE as the word separator (never underscore).
// A refactor that "just uppercases the state" and leaves the
// underscore produces `"KEY_DEAD"` which the agent's single-token
// recognizers (`\bKEY DEAD\b`) do not match. Asserts `!label.includes("_")`
// on the `key_dead` case specifically — a two-word state, orthogonal
// to pin C's three-word surface — so pin C's model_not_found drift
// cannot fire here, and pin A's quota-suffix drift leaves this pin
// green because key_dead is untouched.
test("healthStateLabel_whenStateIsKeyDead_labelUsesSpaceNotUnderscore", () => {
  const label = healthStateLabel("key_dead");

  assert.equal(label.includes("_"), false);
});

// M98 pin C — three-word expansion for `model_not_found`: the
// longest label is three words and enforces that the mapping splits
// ALL underscores. A refactor that replaces only the FIRST underscore
// (`.replace("_", " ")` vs `.replace(/_/g, " ")` — a plausible
// mechanical-rewrite drift) silently produces `"MODEL NOT_FOUND"`
// and breaks ONLY the three-word state while leaving every two-word
// state unaffected — the insidious case a casual key_dead spot-check
// would miss. Asserts the exact three-word label on model_not_found;
// pin B's `includes("_") === false` assertion on key_dead does NOT
// fire on a broken `model_not_found` because key_dead is untouched
// by a `.replace("_", " ")`-only drift (no underscores after the
// first case in the switch).
test("healthStateLabel_whenStateIsModelNotFound_labelIsThreeWordForm", () => {
  const label = healthStateLabel("model_not_found");

  assert.equal(label, "MODEL NOT FOUND");
});

// M99 pin A — blockedProviderID early-filter: the caller passes the
// provider whose blowup triggered the penalty section; the loop's
// first filter clause (`providerRoute.provider === blockedProviderID`)
// ensures that even if `isProviderHealthy` would return `true` for
// that provider (empty providerHealthMap here), the blocked provider's
// routes are still removed from candidacy. The entry has two visible
// routes — iflowcn first, ollama-cloud second — and ZERO penalties in
// either health map, so the ONLY filter that removes the first route
// is the early blockedProviderID check. Asserts the second route's
// composite model string is returned. A refactor that drops the
// early-filter clause silently returns iflowcn/foo instead. Pin B's
// brand-blocklist surface is orthogonal because neither iflowcn nor
// ollama-cloud is in the proprietary-brand blocklist. Pin C's
// sentinel surface is orthogonal because an allowed route exists so
// the sentinel is never reached.
test("findCuratedFallbackRoute_whenBlockedProviderHasHealthyRoute_returnsSiblingInstead", () => {
  const entry: ModelRegistryEntry = {
    id: "m99-a",
    enabled: true,
    description: "m99-a",
    capability_tier: "standard",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: [],
    not_for: [],
    default_roles: ["implementation_worker"],
    provider_order: [
      { provider: "iflowcn", model: "iflowcn/qwen3-coder-plus", priority: 1 },
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 2 },
    ],
    notes: [],
  };

  const fallback = findCuratedFallbackRoute(
    entry,
    "iflowcn",
    new Map(),
    new Map(),
    Date.now(),
  );

  assert.equal(fallback, "ollama-cloud/glm-5.1");
});

// M99 pin B — `isFallbackBlocked` proprietary-brand blocklist: a
// route like openrouter/anthropic/claude-3.5-sonnet:free is both
// VISIBLE (ends in `:free`, so filterVisibleProviderRoutes keeps it)
// AND brand-blocked (matches /claude/i), so the filterVisibleProviderRoutes
// layer alone does NOT close this gap. A refactor that collapses or
// drops the `isFallbackBlocked` clause silently lets the curated
// fallback suggester recommend a proprietary claude route through the
// openrouter `:free` backdoor, directly contradicting the user's
// brand-policy layer. Asserts the second (ollama-cloud) route is
// returned. Pin A's blockedProviderID surface is orthogonal because
// blockedProviderID is `""` here. Pin C's sentinel surface is
// orthogonal because an allowed route exists.
test("findCuratedFallbackRoute_whenFirstVisibleRouteIsBrandBlocked_skipsToAllowedSibling", () => {
  const entry: ModelRegistryEntry = {
    id: "m99-b",
    enabled: true,
    description: "m99-b",
    capability_tier: "strong",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: [],
    not_for: [],
    default_roles: ["implementation_worker"],
    provider_order: [
      {
        provider: "openrouter",
        model: "openrouter/anthropic/claude-3.5-sonnet:free",
        priority: 1,
      },
      { provider: "ollama-cloud", model: "ollama-cloud/glm-5.1", priority: 2 },
    ],
    notes: [],
  };

  const fallback = findCuratedFallbackRoute(
    entry,
    "",
    new Map(),
    new Map(),
    Date.now(),
  );

  assert.equal(fallback, "ollama-cloud/glm-5.1");
});

// M99 pin C — `NO_FALLBACK_MODEL_CONFIGURED_MESSAGE` sentinel return:
// when every visible route is disqualified the helper returns the
// literal sentinel `"no fallback configured"`, which the agent's
// interpretation layer reads as "do not retry, escalate". A refactor
// that changes the sentinel to `""` or `null` produces agent-visible
// bullet lines like `- entry → ` with a trailing space, which the
// agent may interpret as truncated system prompt and retry the
// blowing-up route anyway. Entry has one visible route whose
// composite key is in modelRouteHealthMap with a live penalty, so
// `isRouteCurrentlyHealthy` returns false and the `find` yields
// undefined. Pin A's blockedProviderID surface is orthogonal
// (blockedProviderID `""` here). Pin B's brand-blocklist surface is
// orthogonal (ollama-cloud is not brand-blocked — the route is
// removed by route-level health, not by brand). Pin C is the sole
// surface where changing the sentinel flips the assertion.
test("findCuratedFallbackRoute_whenEveryRouteIsDisqualified_returnsNoFallbackSentinel", () => {
  const entry: ModelRegistryEntry = {
    id: "m99-c",
    enabled: true,
    description: "m99-c",
    capability_tier: "standard",
    cost_tier: "free",
    billing_mode: "free",
    latency_tier: "standard",
    concurrency: 1,
    quota_visibility: "system-observed",
    best_for: [],
    not_for: [],
    default_roles: ["implementation_worker"],
    provider_order: [
      { provider: "ollama-cloud", model: "ollama-cloud/dead-model", priority: 1 },
    ],
    notes: [],
  };

  const now = Date.now();
  const modelRouteHealthMap = new Map([
    [
      "ollama-cloud/dead-model",
      { state: "model_not_found" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);

  const fallback = findCuratedFallbackRoute(
    entry,
    "",
    new Map(),
    modelRouteHealthMap,
    now,
  );

  assert.equal(fallback, "no fallback configured");
});

// M100 asymmetric pins for findPreferredHealthyRoute drift surfaces.
// Each pin fires uniquely under exactly one of three sabotages on the
// helper body. Pre-existing pins 4/5/6 incidentally fire under S3 as
// additive coverage — documented and accepted.

test("findPreferredHealthyRoute_whenPreferredIsPriority2Sibling_returnsExactNotFirstHealthy", () => {
  // Drift surface 1: exact-match precedence. When the agent's declared
  // preference is a LATER sibling inside an entry (both healthy), the
  // helper must return the explicit preference, not the ascending-
  // priority first-healthy visible route. A refactor that collapsed
  // the exact-find block into the fallback-find scan would pass the
  // existing pin (where preferred == priority-1 anyway) and silently
  // return alpha here instead of beta.
  const entries = [
    buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
      { provider: "openrouter", model: "openrouter/alpha:free", priority: 1 },
      { provider: "openrouter", model: "openrouter/beta:free", priority: 2 },
    ]),
  ];
  const decision = findPreferredHealthyRoute(
    ["openrouter/beta:free"],
    entries,
    new Map(),
    new Map(),
    0,
  );
  assert.deepEqual(decision, {
    selectedModelRoute: "openrouter/beta:free",
    reasoning: "Preferred model from agent metadata, healthy provider",
  });
});

test("findPreferredHealthyRoute_whenPreferredPointsAtHiddenPaidProvider_returnsNull", () => {
  // Drift surface 2: `filterVisibleProviderRoutes` integration. An
  // agent that preferred `xai/grok-4` must not resurrect a hidden
  // paid-provider dispatch path. Replacing the filter call with raw
  // `entry.provider_order` would silently return "xai/grok-4" here.
  const entries = [
    buildModelRegistryEntry("grok-4", ["architect"], "frontier", [
      { provider: "xai", model: "xai/grok-4", priority: 1 },
    ]),
  ];
  const decision = findPreferredHealthyRoute(
    ["xai/grok-4"],
    entries,
    new Map(),
    new Map(),
    0,
  );
  assert.equal(decision, null);
});

test("findPreferredHealthyRoute_whenPreferredIsInUnhealthyEntryAndSiblingEntryHasHealthyOtherModel_returnsNull", () => {
  // Drift surface 3: `entryContainsPreferred` gate prevents cross-
  // entry fallback leak. Entry A holds the preferred model on an
  // unhealthy provider; entry B holds a DIFFERENT model on a healthy
  // provider. The helper must return null because entry B is skipped
  // by the gate — the agent's preference is a same-entry constraint,
  // not a registry-wide "find any healthy route" permission. Without
  // the gate, the fallback-find branch would walk entry B and return
  // opencode-go/other, polluting across the registry boundary.
  const entries = [
    buildModelRegistryEntry("pref-family", ["architect"], "frontier", [
      { provider: "ollama-cloud", model: "ollama-cloud/pref-free", priority: 1 },
    ]),
    buildModelRegistryEntry("other-family", ["architect"], "frontier", [
      { provider: "opencode-go", model: "opencode-go/other-free", priority: 1 },
    ]),
  ];
  const providerHealthMap = new Map([
    [
      "ollama-cloud",
      { state: "quota" as const, until: 100, retryCount: 0 },
    ],
  ]);
  const decision = findPreferredHealthyRoute(
    ["ollama-cloud/pref-free"],
    entries,
    providerHealthMap,
    new Map(),
    50,
  );
  assert.equal(decision, null);
});

// M101 asymmetric pins for buildProviderHealthSystemPrompt drift surfaces.
// Each pin fires uniquely under exactly one sabotage targeting the helper
// body's three undocumented invariants.

test("buildProviderHealthSystemPrompt_whenProviderPenaltyExists_emitsCuratedFallbacksLabelWithExclusionNote", () => {
  // Drift surface 1: the exact "Curated fallbacks (longcat/claude/gpt/grok
  // excluded):" label literal. Dropping the parenthetical exclusion note
  // silently strips the agent-legibility contract that tells the LLM why
  // proprietary models are absent from the bullet list below. A "simplify
  // to just 'Curated fallbacks:'" refactor would pass every pre-existing
  // pin because none of them assert this exact literal.
  const now = Date.now();
  const entry = buildModelRegistryEntry("glm-5.1", ["architect"], "frontier", [
    { provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 },
    { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
  ]);
  const providerHealthMap = new Map([
    [
      "opencode",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  const prompt = buildProviderHealthSystemPrompt(
    [entry],
    providerHealthMap,
    new Map(),
    now,
  );
  assert.notEqual(prompt, null);
  assert.ok(
    (prompt as string).includes("Curated fallbacks (longcat/claude/gpt/grok excluded):"),
    "provider-penalty section must include the exact brand-exclusion note",
  );
});

test("buildProviderHealthSystemPrompt_whenRoutePenaltyHasNoOwningEntry_emitsHeaderOnlyWithoutCrashing", () => {
  // Drift surface 2: the `if (owningEntry)` guard on route-penalty
  // sections. A persisted route key with no matching current registry
  // entry must produce a header-only section — dropping the guard
  // would crash inside findCuratedFallbackRoute dereferencing
  // `undefined.provider_order` and take down the entire transform hook.
  const now = Date.now();
  const modelRouteHealthMap = new Map([
    [
      "removed-provider/legacy-model",
      { state: "timeout" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  let prompt: string | null | undefined;
  assert.doesNotThrow(() => {
    prompt = buildProviderHealthSystemPrompt(
      [],
      new Map(),
      modelRouteHealthMap,
      now,
    );
  });
  assert.ok(typeof prompt === "string", "prompt must be non-null string");
  assert.match(prompt, /Route removed-provider\/legacy-model \[TIMEOUT\]/);
  assert.equal(
    prompt.includes("Curated fallback for"),
    false,
    "unknown-owning-entry route section must NOT emit a fallback bullet",
  );
});

test("buildProviderHealthSystemPrompt_whenBothProviderAndRoutePenaltiesExist_joinsSectionsWithBlankLine", () => {
  // Drift surface 3: the `\n\n` cross-section separator. Pre-existing
  // pins only exercise single-section outputs, so the blank-line join
  // between provider and route sections is silently load-bearing. A
  // refactor that collapses the join to `"\n"` merges adjacent sections
  // into one opaque paragraph.
  const now = Date.now();
  const providerEntry = buildModelRegistryEntry(
    "glm-5.1",
    ["architect"],
    "frontier",
    [
      { provider: "opencode", model: "opencode/glm-5.1-free", priority: 1 },
      { provider: "iflowcn", model: "iflowcn/glm-5.1", priority: 2 },
    ],
  );
  const routeEntry = buildModelRegistryEntry(
    "qwen3-coder-plus",
    ["implementation_worker"],
    "strong",
    [
      { provider: "iflowcn", model: "iflowcn/qwen3-coder-plus", priority: 1 },
      { provider: "opencode-go", model: "opencode-go/qwen3-coder-plus", priority: 2 },
    ],
  );
  const providerHealthMap = new Map([
    [
      "opencode",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  const modelRouteHealthMap = new Map([
    [
      "iflowcn/qwen3-coder-plus",
      { state: "model_not_found" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  const prompt = buildProviderHealthSystemPrompt(
    [providerEntry, routeEntry],
    providerHealthMap,
    modelRouteHealthMap,
    now,
  );
  assert.notEqual(prompt, null);
  // Provider section content must appear before the blank-line separator,
  // route section after. Split on the `\n\n` separator and assert both
  // halves are non-empty and contain their respective markers.
  const sections = (prompt as string).split("\n\n");
  assert.ok(
    sections.length >= 2,
    "provider and route sections must be separated by a blank line",
  );
  assert.ok(
    sections.some((section) => section.includes("Provider opencode [QUOTA BACKOFF]")),
    "provider section must be one of the blank-line-separated chunks",
  );
  assert.ok(
    sections.some((section) =>
      section.includes("Route iflowcn/qwen3-coder-plus [MODEL NOT FOUND]"),
    ),
    "route section must be one of the blank-line-separated chunks",
  );
});

// M102: drift pins for `filterProviderModelsByRouteHealth` — the pre-existing
// pins cover the enabled gate and the route-penalty gate, but leave three
// independent drift surfaces unprotected. Each new pin below is fired
// uniquely by exactly one sabotage on a distinct surface of the helper
// body, verified on-HEAD via the standard three-way cascade.

test("filterProviderModelsByRouteHealth_whenEnabledModelIsMissingFromProviderModels_doesNotFabricateKey", () => {
  // Pins: iteration source MUST be `providerModels`, never
  // `enabledRawModelIDs`. A registry row whose primary route was
  // retired / renamed / hidden upstream is still present in the
  // enabled set but absent from opencode's runtime provider map. The
  // current code walks `Object.entries(providerModels)` so absent
  // entries simply don't appear. A refactor that iterates the
  // enabled set (and reads `providerModels[id]` back) would fabricate
  // `filtered["ghost-model"] = undefined`, which opencode's router
  // interprets as a real advertised model and dispatches to — a
  // plugin-level phantom-model bug fully attributable to the drift.
  const enabledRawModelIDs = new Set(["ghost-model"]);
  const providerModels = {}; // Empty — provider discovery returned nothing for this id.
  const filtered = filterProviderModelsByRouteHealth(
    providerModels,
    enabledRawModelIDs,
    "openrouter",
    new Map(),
    Date.now(),
  );
  assert.deepEqual(
    Object.keys(filtered),
    [],
    "enabled-but-absent models must NOT be fabricated as keys in filtered",
  );
  assert.equal(
    Object.hasOwn(filtered, "ghost-model"),
    false,
    "filtered must not own the ghost-model key even with an undefined value",
  );
});

test("filterProviderModelsByRouteHealth_whenEntryPasses_preservesOriginalModelValueByIdentity", () => {
  // Pins: the filtered output writes the ORIGINAL `modelValue` by
  // reference, not a stub / boolean / synthesised object. Opencode's
  // downstream readers extract capability hints, context window,
  // tool-support flags, etc. directly from these values; replacing
  // them with `true` or `{}` silently strips all metadata while still
  // advertising the model as available. Identity check (`===` on the
  // retained object reference) is the cheapest way to pin "we did not
  // rebuild the value" without asserting every field shape by hand.
  const stepfunValue = { id: "stepfun/step-3.5-flash:free", label: "free", contextWindow: 128_000 };
  const enabledRawModelIDs = new Set(["stepfun/step-3.5-flash:free"]);
  const providerModels = {
    "stepfun/step-3.5-flash:free": stepfunValue,
  };
  const filtered = filterProviderModelsByRouteHealth(
    providerModels,
    enabledRawModelIDs,
    "openrouter",
    new Map(),
    Date.now(),
  );
  assert.equal(
    filtered["stepfun/step-3.5-flash:free"],
    stepfunValue,
    "filtered value must be byte-identical (===) to the original provider model value",
  );
});

// M103: drift pins for `expireHealthMaps` — the pre-existing pins cover
// the mixed expired+live sweep on both maps and the infinity preservation
// case, but leave three independent drift surfaces unprotected: the
// `<= now` provider boundary (inclusive), the `<= now` route boundary
// (inclusive), and the preserved-entry retryCount invariant on the
// non-expired branch. Each new pin is fired uniquely by exactly one
// sabotage on a distinct surface of the helper body.

test("expireHealthMaps_whenProviderUntilExactlyEqualsNow_dropsEntryAtInclusiveBoundary", () => {
  // Pins: provider-map boundary comparison is `<= now`, not `< now`.
  // An entry whose `until === now` must be dropped on the same tick —
  // the penalty window closes the moment wall-clock reaches the
  // stamped deadline, not one tick later. Pre-existing pin 1 uses
  // `now - 1` so a `<= now` → `< now` drift is not caught there.
  const now = Date.now();
  const providerHealthMap = new Map([
    ["iflowcn", { state: "quota" as const, until: now, retryCount: 1 }],
  ]);
  const modelRouteHealthMap = new Map([
    // Non-expired route so the route loop has work to do (prevents
    // an accidental early-return sabotage from passing this pin via
    // an empty-route shortcut).
    [
      "openrouter/still-live",
      { state: "timeout" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);

  expireHealthMaps(providerHealthMap, modelRouteHealthMap, now);

  assert.equal(
    providerHealthMap.has("iflowcn"),
    false,
    "provider entry with until === now must be dropped at the inclusive boundary",
  );
});

test("expireHealthMaps_whenRouteUntilExactlyEqualsNow_dropsEntryAtInclusiveBoundary", () => {
  // Pins: route-map boundary comparison is `<= now`, independently
  // of the provider-map boundary. The two loops have two separate
  // `<=` comparisons, and a partial refactor could drift just one
  // of them. Pre-existing pin 1 uses `now - 1` on the route side
  // so a `<= now` → `< now` drift on only the route loop is
  // invisible without this dedicated pin.
  const now = Date.now();
  const providerHealthMap = new Map([
    // Non-expired provider so the provider loop has work (mirror of pin A).
    [
      "ollama-cloud",
      { state: "quota" as const, until: now + 60_000, retryCount: 1 },
    ],
  ]);
  const modelRouteHealthMap = new Map([
    [
      "iflowcn/qwen3-coder-plus",
      { state: "model_not_found" as const, until: now, retryCount: 1 },
    ],
  ]);

  expireHealthMaps(providerHealthMap, modelRouteHealthMap, now);

  assert.equal(
    modelRouteHealthMap.has("iflowcn/qwen3-coder-plus"),
    false,
    "route entry with until === now must be dropped at the inclusive boundary",
  );
});

test("expireHealthMaps_whenProviderEntryIsNotExpired_preservesRetryCountForEscalationLadder", () => {
  // Pins: non-expired entries are preserved UNCHANGED. The helper
  // has no `else` clause — surviving entries must be walked over
  // and left byte-identical. `retryCount` in particular must
  // survive, because `computeProviderHealthUpdate` reads the
  // existing retryCount to compute the next-penalty escalation
  // duration on the next penalty hit. A refactor that adds an
  // `else { set(...) }` clause "to normalise" preserved entries
  // (e.g. resetting retryCount to zero on every sweep) would
  // silently flatten the penalty escalation ladder on every
  // `experimental.chat.system.transform` invocation. Pre-existing
  // pins assert `.has(...)` on surviving entries but never read
  // retryCount back, so this drift is structurally uncovered.
  const now = Date.now();
  const providerHealthMap = new Map([
    [
      "iflowcn",
      { state: "quota" as const, until: now + 60 * 60 * 1000, retryCount: 5 },
    ],
  ]);

  expireHealthMaps(providerHealthMap, new Map(), now);

  const preserved = providerHealthMap.get("iflowcn");
  assert.ok(preserved, "non-expired entry must still be present");
  assert.equal(
    preserved.retryCount,
    5,
    "retryCount on preserved entry must be byte-identical — escalation state must not be reset",
  );
  assert.equal(
    preserved.state,
    "quota",
    "state on preserved entry must be byte-identical",
  );
});

test("filterProviderModelsByRouteHealth_whenCalled_doesNotMutateInputProviderModels", () => {
  // Pins: `providerModels` is read-only. The `provider.models` hook
  // hands us the opencode-owned map by reference; a refactor that
  // `delete`s excluded keys in-place (a tempting "avoid building a
  // new object" micro-optimisation) would corrupt the caller's view
  // of the provider map and cascade into every downstream reader in
  // the same turn. The helper builds a fresh `filtered` object and
  // leaves `providerModels` byte-identical to its entry state.
  const enabledRawModelIDs = new Set(["stepfun/step-3.5-flash:free"]);
  const providerModels: Record<string, unknown> = {
    "stepfun/step-3.5-flash:free": { id: "stepfun/step-3.5-flash:free" },
    "never-enabled-model": { id: "never-enabled-model" },
    "another-absent-model": { id: "another-absent-model" },
  };
  const originalKeys = Object.keys(providerModels).sort();
  filterProviderModelsByRouteHealth(
    providerModels,
    enabledRawModelIDs,
    "openrouter",
    new Map(),
    Date.now(),
  );
  assert.deepEqual(
    Object.keys(providerModels).sort(),
    originalKeys,
    "input providerModels must NOT be mutated — all original keys must still be present",
  );
  assert.ok(
    Object.hasOwn(providerModels, "never-enabled-model"),
    "excluded keys must remain in the INPUT map (non-mutation invariant)",
  );
});
