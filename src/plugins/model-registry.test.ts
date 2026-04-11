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
  classifyProviderApiError,
  clearSessionHangState,
  countHealthyVisibleRoutes,
  composeRouteKey,
  computeProviderHealthUpdate,
  computeRegistryEntryHealthReport,
  expireHealthMaps,
  filterProviderModelsByRouteHealth,
  findCuratedFallbackRoute,
  inferTaskComplexity,
  parsePersistedHealthEntry,
  recommendTaskModelRoute,
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
  assert.equal(
    inferTaskComplexity(
      "Please carefully review this one-line typo fix in the README.",
      null,
    ),
    "medium",
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
  // through to keyword checks in priority order. quota > no_credit > key_dead.
  const result = classifyProviderApiError(0, "provider reported quota exhaustion");
  assert.equal(result, "quota");
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
