import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ModelRegistryEntry } from "../model-registry.js";
import {
  buildAvailableModelsSystemPrompt,
  buildProviderHealthSystemPrompt,
  buildRouteHealthEntry,
  buildModelNotFoundRouteHealth,
  classifyProviderApiError,
  isFallbackBlocked,
  findFirstHealthyVisibleRoute,
  findPreferredHealthyRoute,
  isAgentVisibleHealthState,
  hasUsableCredential,
  isZeroTokenQuotaSignal,
  parseAgentFrontmatter,
  parseHangTimeoutMs,
  stripYamlScalarQuotes,
  DEFAULT_ROUTE_HANG_TIMEOUT_MS,
  ROUTE_MODEL_NOT_FOUND_DURATION_MS,
  ROUTE_QUOTA_BACKOFF_DURATION_MS,
  shouldClassifyAsModelNotFound,
  clearSessionHangState,
  countHealthyVisibleRoutes,
  composeRouteKey,
  computeProviderHealthUpdate,
  computeRegistryEntryHealthReport,
  expireHealthMaps,
  filterProviderModelsByRouteHealth,
  findCuratedFallbackRoute,
  findRegistryEntryByModel,
  inferTaskComplexity,
  parsePersistedHealthEntry,
  recommendTaskModelRoute,
  evaluateSessionHangForTimeoutPenalty,
  finalizeHungSessionState,
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
