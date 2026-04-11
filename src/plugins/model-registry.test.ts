import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ModelRegistryEntry } from "../model-registry.js";
import {
  inferTaskComplexity,
  recommendTaskModelRoute,
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
