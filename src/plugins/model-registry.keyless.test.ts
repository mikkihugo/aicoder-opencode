import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ModelRegistryEntry } from "../model-registry.js";

function buildModelRegistryEntry(
  id: string,
  roles: string[],
  providerOrder: ModelRegistryEntry["provider_order"],
): ModelRegistryEntry {
  return {
    id,
    enabled: true,
    description: `${id} entry`,
    capability_tier: "standard",
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

function authFilePath(homeDirectory: string): string {
  return path.join(homeDirectory, ".local", "share", "opencode", "auth.json");
}

function providerHealthStatePath(): string {
  return path.join(process.cwd(), ".opencode", "state", "plugin", "provider-health.json");
}

async function withIsolatedHome(
  testFn: (homeDirectory: string) => Promise<void>,
): Promise<void> {
  const originalHome = process.env.HOME;
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "aicoder-plugin-home-"));

  try {
    process.env.HOME = homeDirectory;
    await mkdir(path.dirname(authFilePath(homeDirectory)), { recursive: true });
    await writeFile(authFilePath(homeDirectory), "{}", "utf8");
    await testFn(homeDirectory);
  } finally {
    process.env.HOME = originalHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

async function withFreshHealthState(testFn: () => Promise<void>): Promise<void> {
  const filePath = providerHealthStatePath();
  const originalState = await readFile(filePath, "utf8").catch(() => null);

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{}", "utf8");
    await testFn();
  } finally {
    if (originalState === null) {
      await rm(filePath, { force: true });
      return;
    }
    await writeFile(filePath, originalState, "utf8");
  }
}

async function writeAuthFile(homeDirectory: string, entries: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(authFilePath(homeDirectory)), { recursive: true });
  await writeFile(authFilePath(homeDirectory), JSON.stringify(entries), "utf8");
}

async function waitForPersistedHealthState(
  expectedPattern: RegExp,
): Promise<string> {
  const filePath = providerHealthStatePath();
  const maxAttempts = 20;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const rawState = await readFile(filePath, "utf8").catch(() => "");
    if (expectedPattern.test(rawState)) {
      return rawState;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return readFile(filePath, "utf8").catch(() => "");
}

test("initializeProviderHealthState_whenCredentialOnlyInEnvVar_doesNotFlagProvider", async () => {
  // A user who only sets OPENROUTER_API_KEY (no auth.json entry) still has a
  // working provider. Previously the plugin flagged them `key_missing`. This
  // test locks in the env-var fallback behavior with both convention-based
  // (openrouter → OPENROUTER_API_KEY) and override (kimi-for-coding → KIMI_API_KEY).
  await withIsolatedHome(async (homeDirectory) => {
    await writeAuthFile(homeDirectory, {});
    const savedOpenrouter = process.env.OPENROUTER_API_KEY;
    const savedKimi = process.env.KIMI_API_KEY;
    process.env.OPENROUTER_API_KEY = "env-openrouter-key";
    process.env.KIMI_API_KEY = "env-kimi-key";
    try {
      await withFreshHealthState(async () => {
        const { initializeProviderHealthState } = await import("./model-registry.js");

        const runtime = await initializeProviderHealthState([
          buildModelRegistryEntry("openrouter-model", ["architect"], [
            { provider: "openrouter", model: "openrouter/m", priority: 1 },
          ]),
          buildModelRegistryEntry("kimi-model", ["architect"], [
            { provider: "kimi-for-coding", model: "kimi-for-coding/m", priority: 1 },
          ]),
          buildModelRegistryEntry("unconfigured-model", ["architect"], [
            { provider: "nonexistent-provider", model: "nonexistent-provider/m", priority: 1 },
          ]),
        ]);

        assert.equal(runtime.providerHealthMap.get("openrouter"), undefined);
        assert.equal(runtime.providerHealthMap.get("kimi-for-coding"), undefined);
        assert.equal(
          runtime.providerHealthMap.get("nonexistent-provider")?.state,
          "key_missing",
        );
      });
    } finally {
      if (savedOpenrouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedOpenrouter;
      if (savedKimi === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = savedKimi;
    }
  });
});

test("initializeProviderHealthState_whenAuthJsonUsesRealOpencodeSchema_recognizesCredentials", async () => {
  // Real opencode auth.json entries are:
  //   { type: "api", key: "..." }          for API-key providers
  //   { type: "oauth", access: "...", ... } for OAuth providers
  // Previously the plugin read `.apiKey` and false-flagged every real entry
  // as `key_missing`. This test locks in the real schema.
  await withIsolatedHome(async (homeDirectory) => {
    await writeAuthFile(homeDirectory, {
      "api-provider": { type: "api", key: "real-api-key" },
      "oauth-provider": {
        type: "oauth",
        access: "real-access-token",
        refresh: "real-refresh-token",
        expires: Date.now() + 60_000,
      },
      "unconfigured-provider": { type: "api", key: "" },
    });

    await withFreshHealthState(async () => {
      const { initializeProviderHealthState } = await import("./model-registry.js");

      const runtime = await initializeProviderHealthState([
        buildModelRegistryEntry("api-model", ["architect"], [
          { provider: "api-provider", model: "api-provider/m", priority: 1 },
        ]),
        buildModelRegistryEntry("oauth-model", ["architect"], [
          { provider: "oauth-provider", model: "oauth-provider/m", priority: 1 },
        ]),
        buildModelRegistryEntry("empty-model", ["architect"], [
          { provider: "unconfigured-provider", model: "unconfigured-provider/m", priority: 1 },
        ]),
      ]);

      assert.equal(runtime.providerHealthMap.get("api-provider"), undefined);
      assert.equal(runtime.providerHealthMap.get("oauth-provider"), undefined);
      assert.equal(
        runtime.providerHealthMap.get("unconfigured-provider")?.state,
        "key_missing",
      );
    });
  });
});

test("initializeProviderHealthState marks missing provider keys as key_missing", async () => {
  await withIsolatedHome(async (homeDirectory) => {
    await writeAuthFile(homeDirectory, {
      "opencode-go": { apiKey: "token-value" },
    });

    await withFreshHealthState(async () => {
      const { initializeProviderHealthState } = await import("./model-registry.js");

      const runtime = await initializeProviderHealthState([
        buildModelRegistryEntry("open-model", ["architect"], [
          { provider: "opencode-go", model: "opencode-go/open-model", priority: 1 },
        ]),
        buildModelRegistryEntry("missing-provider-model", ["architect"], [
          { provider: "missing-provider", model: "missing-provider/model", priority: 1 },
        ]),
      ]);

      const missingProviderHealth = runtime.providerHealthMap.get("missing-provider");
      assert.equal(missingProviderHealth?.state, "key_missing");
      assert.equal(missingProviderHealth?.until, Number.POSITIVE_INFINITY);
      assert.equal(runtime.providerHealthMap.get("opencode-go"), undefined);
    });
  });
});

test("initializeProviderHealthState preserves key_missing across persisted reload", async () => {
  await withIsolatedHome(async (homeDirectory) => {
    await writeAuthFile(homeDirectory, {
      "opencode-go": { apiKey: "token-value" },
    });

    await withFreshHealthState(async () => {
      const { initializeProviderHealthState } = await import("./model-registry.js");

      const modelRegistryEntries = [
        buildModelRegistryEntry("missing-provider-model", ["architect"], [
          { provider: "missing-provider", model: "missing-provider/model", priority: 1 },
        ]),
      ];

      const firstRuntime = await initializeProviderHealthState(modelRegistryEntries);
      assert.equal(firstRuntime.providerHealthMap.get("missing-provider")?.state, "key_missing");

      const rawPersistedState = await waitForPersistedHealthState(/"until": "never"/);
      assert.match(rawPersistedState, /"until": "never"/);

      const secondRuntime = await initializeProviderHealthState(modelRegistryEntries);
      assert.equal(secondRuntime.providerHealthMap.get("missing-provider")?.state, "key_missing");
      assert.equal(
        secondRuntime.providerHealthMap.get("missing-provider")?.until,
        Number.POSITIVE_INFINITY,
      );
    });
  });
});

test("initializeProviderHealthState_whenPersistedKeyMissingButCredentialNowPresent_reconcilesAwayStaleEntry", async () => {
  // Regression: loadPersistedProviderHealth restores `key_missing` entries
  // from disk with until=Infinity. The old early-exit
  // `if (!providerHealthMap.has(providerID))` then skipped the hasKey check
  // for any restored entry, permanently blocking the provider even after the
  // user added valid credentials between plugin restarts. This test seeds a
  // persisted `key_missing` entry, writes an auth.json that DOES contain a
  // credential for that provider, and asserts the entry is reconciled away.
  await withIsolatedHome(async (homeDirectory) => {
    await writeAuthFile(homeDirectory, {
      iflowcn: { type: "api", key: "real-key" },
    });

    await withFreshHealthState(async () => {
      await writeFile(
        providerHealthStatePath(),
        JSON.stringify({
          iflowcn: {
            state: "key_missing",
            until: "never",
            retryCount: 0,
          },
        }),
        "utf8",
      );

      const { initializeProviderHealthState } = await import("./model-registry.js");

      const runtime = await initializeProviderHealthState([
        buildModelRegistryEntry("qwen3-coder-plus", ["implementation_worker"], [
          { provider: "iflowcn", model: "iflowcn/qwen3-coder-plus", priority: 1 },
        ]),
      ]);

      assert.equal(
        runtime.providerHealthMap.get("iflowcn"),
        undefined,
        "stale key_missing should be cleared when credential is now present",
      );
    });
  });
});

test("initializeProviderHealthState_whenPersistedFileContainsRouteKeys_loadsThemIntoModelRouteHealthMap", async () => {
  // Regression: persistProviderHealth writes BOTH provider entries
  // (`"iflowcn"`) and route entries (`"iflowcn/qwen3-coder-plus"`) into
  // a single flat JSON. The loader used to dump everything into a single
  // Map and route-level health was stranded in providerHealthMap, so
  // (a) route-level backoffs silently evaporated on every plugin restart
  // and (b) zombie route keys accumulated in the provider map forever.
  // This test seeds a mixed-shape file, reinitializes, and asserts the
  // loader splits the keys into the correct maps based on the `/` sep.
  await withIsolatedHome(async (homeDirectory) => {
    await writeAuthFile(homeDirectory, {
      iflowcn: { type: "api", key: "real-key" },
    });

    const farFuture = Date.now() + 10 * 60 * 1000;

    await withFreshHealthState(async () => {
      // Pre-seed the persisted file with a mixed provider+route payload.
      await writeFile(
        providerHealthStatePath(),
        JSON.stringify({
          iflowcn: {
            state: "quota",
            until: farFuture,
            retryCount: 2,
          },
          "iflowcn/qwen3-coder-plus": {
            state: "timeout",
            until: farFuture,
            retryCount: 1,
          },
        }),
        "utf8",
      );

      const { initializeProviderHealthState } = await import("./model-registry.js");

      const runtime = await initializeProviderHealthState([
        buildModelRegistryEntry("qwen3-coder-plus", ["implementation_worker"], [
          { provider: "iflowcn", model: "iflowcn/qwen3-coder-plus", priority: 1 },
        ]),
      ]);

      // Provider key went to providerHealthMap.
      assert.equal(runtime.providerHealthMap.get("iflowcn")?.state, "quota");
      // Route key went to modelRouteHealthMap — not to providerHealthMap.
      assert.equal(
        runtime.modelRouteHealthMap.get("iflowcn/qwen3-coder-plus")?.state,
        "timeout",
      );
      assert.equal(runtime.providerHealthMap.get("iflowcn/qwen3-coder-plus"), undefined);
    });
  });
});

test("selectBestModelForRoleAndTask skips routes to keyless providers", async () => {
  await withIsolatedHome(async (homeDirectory) => {
    await writeAuthFile(homeDirectory, {
      iflowcn: "token-value",
    });

    await withFreshHealthState(async () => {
      const {
        initializeProviderHealthState,
        selectBestModelForRoleAndTask,
      } = await import("./model-registry.js");

      const modelRegistryEntries = [
        buildModelRegistryEntry("unavailable-primary", ["architect"], [
          { provider: "missing-provider", model: "missing-provider/model-a", priority: 1 },
          { provider: "iflowcn", model: "iflowcn/model-a", priority: 2 },
        ]),
        buildModelRegistryEntry("fallback-model", ["architect"], [
          { provider: "iflowcn", model: "iflowcn/model-b", priority: 1 },
        ]),
      ];
      const runtime = await initializeProviderHealthState(modelRegistryEntries);

      const best = selectBestModelForRoleAndTask(
        modelRegistryEntries,
        runtime.providerHealthMap,
        runtime.modelRouteHealthMap,
        Date.now(),
        "architect",
        null,
        null,
      );

      assert.equal(best?.id, "fallback-model");
    });
  });
});

test("session_error_model_not_found_classifies_route_specific_backoff", async () => {
  await withIsolatedHome(async (homeDirectory) => {
    await writeAuthFile(homeDirectory, {
      openrouter: "token-value",
    });

    await withFreshHealthState(async () => {
      const { ModelRegistryPlugin } = await import("./model-registry.js");
      const plugin = await (ModelRegistryPlugin as any)({ directory: process.cwd() });

      await (plugin["chat.params"] as any)(
        {
          sessionID: "session-with-missing-model",
          provider: { info: { id: "openrouter" } },
          model: { id: "model-not-found", providerID: "openrouter" },
        },
        {},
      );

      await (plugin.event as any)({
        event: {
          type: "session.error",
          properties: {
            sessionID: "session-with-missing-model",
            error: {
              name: "APIError",
              data: {
                statusCode: 500,
                message: "Model not found",
              },
            },
          },
        },
      });

      const rawStatus = await (plugin.tool as any).get_quota_backoff_status.execute({});
      const status = JSON.parse(rawStatus as string);

      const routeStatus = status["openrouter/model-not-found"];
      assert.equal(routeStatus?.state, "model_not_found");
      assert.equal(routeStatus?.type, "model_route");
      assert.equal((routeStatus?.retryCount ?? 0) >= 1, true);
    });
  });
});

test("session_error_bare_500_without_model_not_found_message_does_not_poison_route", async () => {
  // A transient 500 (upstream hiccup, maintenance, gateway burp) with no
  // "model not found" in the message must NOT classify the route as
  // model_not_found. Previously the plugin treated any 500 as permanent
  // route death and backed off for an hour, poisoning working routes on
  // every transient upstream blip.
  await withIsolatedHome(async (homeDirectory) => {
    await writeAuthFile(homeDirectory, {
      openrouter: "token-value",
    });

    await withFreshHealthState(async () => {
      const { ModelRegistryPlugin } = await import("./model-registry.js");
      const plugin = await (ModelRegistryPlugin as any)({ directory: process.cwd() });

      await (plugin["chat.params"] as any)(
        {
          sessionID: "session-with-transient-500",
          provider: { info: { id: "openrouter" } },
          model: { id: "healthy-model", providerID: "openrouter" },
        },
        {},
      );

      await (plugin.event as any)({
        event: {
          type: "session.error",
          properties: {
            sessionID: "session-with-transient-500",
            error: {
              name: "APIError",
              data: {
                statusCode: 500,
                message: "Internal server error",
              },
            },
          },
        },
      });

      const rawStatus = await (plugin.tool as any).get_quota_backoff_status.execute({});
      const status = JSON.parse(rawStatus as string);

      assert.equal(status["openrouter/healthy-model"], undefined);
    });
  });
});

test("assistant_message_completed_with_zero_tokens_classifies_route_quota_backoff", async () => {
  await withIsolatedHome(async (homeDirectory) => {
    await writeAuthFile(homeDirectory, {
      "ollama-cloud": "token-value",
    });

    await withFreshHealthState(async () => {
      const { ModelRegistryPlugin } = await import("./model-registry.js");
      const plugin = await (ModelRegistryPlugin as any)({ directory: process.cwd() });

      await (plugin["chat.params"] as any)(
        {
          sessionID: "session-with-zero-token-completion",
          provider: { info: { id: "ollama-cloud" } },
          model: { id: "glm-4.7", providerID: "ollama-cloud" },
        },
        {},
      );

      await (plugin.event as any)({
        event: {
          type: "assistant.message.completed",
          properties: {
            sessionID: "session-with-zero-token-completion",
            tokens: {
              input: 0,
              output: 0,
            },
          },
        },
      });

      const rawStatus = await (plugin.tool as any).get_quota_backoff_status.execute({});
      const status = JSON.parse(rawStatus as string);

      const routeStatus = status["ollama-cloud/glm-4.7"];
      assert.equal(routeStatus?.state, "quota");
      assert.equal(routeStatus?.type, "model_route");
      assert.equal((routeStatus?.retryCount ?? 0) >= 1, true);
    });
  });
});

test("assistant_message_completed_after_long_duration_does_not_mark_route_timeout", async () => {
  // A successful completion is proof of non-hang regardless of wall-clock.
  // Deep reasoning turns (kimi-k2-thinking et al.) routinely exceed any
  // ambient timeout but succeed. Previously the completed-handler checked
  // `duration > timeoutMs` and retroactively marked long-but-successful
  // turns as `timeout`, silently poisoning the route for an hour.
  await withIsolatedHome(async (homeDirectory) => {
    const originalTimeoutValue = process.env.AICODER_ROUTE_HANG_TIMEOUT_MS;
    process.env.AICODER_ROUTE_HANG_TIMEOUT_MS = "1"; // force "long turn" regime

    await writeAuthFile(homeDirectory, {
      "ollama-cloud": "token-value",
    });

    try {
      await withFreshHealthState(async () => {
        const { ModelRegistryPlugin } = await import("./model-registry.js");
        const plugin = await (ModelRegistryPlugin as any)({ directory: process.cwd() });

        // Note: chat.params with timeoutMs < 1000 takes the test-only fast
        // branch that immediately records timeout — we skip it here and
        // seed the session maps directly, simulating a running turn.
        const sessionID = "session-with-long-successful-turn";
        // Use a private-ish seeding path: call chat.params with a larger
        // timeoutMs so the fast branch doesn't fire, then flip env for the
        // completed handler. But that uses setTimeout; simpler: call event
        // directly with a fabricated completed payload.
        process.env.AICODER_ROUTE_HANG_TIMEOUT_MS = "100000";
        await (plugin["chat.params"] as any)(
          {
            sessionID,
            provider: { info: { id: "ollama-cloud" } },
            model: { id: "kimi-k2-thinking", providerID: "ollama-cloud" },
          },
          {},
        );

        // Simulate: turn ran for longer than any reasonable timeout but
        // completed successfully (nonzero tokens).
        await new Promise((r) => setTimeout(r, 20));
        process.env.AICODER_ROUTE_HANG_TIMEOUT_MS = "1"; // now pretend the timeout was tiny

        await (plugin.event as any)({
          event: {
            type: "assistant.message.completed",
            properties: {
              sessionID,
              tokens: { input: 500, output: 1200 },
            },
          },
        });

        const rawStatus = await (plugin.tool as any).get_quota_backoff_status.execute({});
        const status = JSON.parse(rawStatus as string);
        assert.equal(status["ollama-cloud/kimi-k2-thinking"], undefined);
      });
    } finally {
      if (originalTimeoutValue === undefined) {
        delete process.env.AICODER_ROUTE_HANG_TIMEOUT_MS;
      } else {
        process.env.AICODER_ROUTE_HANG_TIMEOUT_MS = originalTimeoutValue;
      }
    }
  });
});

test("chat_params_when_route_hangs_classifies_route_timeout_backoff", async () => {
  await withIsolatedHome(async (homeDirectory) => {
    const originalTimeoutValue = process.env.AICODER_ROUTE_HANG_TIMEOUT_MS;
    process.env.AICODER_ROUTE_HANG_TIMEOUT_MS = "20";

    await writeAuthFile(homeDirectory, {
      "ollama-cloud": "token-value",
    });

    try {
      await withFreshHealthState(async () => {
        const { ModelRegistryPlugin } = await import("./model-registry.js");
        const plugin = await (ModelRegistryPlugin as any)({ directory: process.cwd() });

        await (plugin["chat.params"] as any)(
          {
            sessionID: "session-with-route-timeout",
            provider: { info: { id: "ollama-cloud" } },
            model: { id: "glm-5.1", providerID: "ollama-cloud" },
          },
          {},
        );

        await waitForPersistedHealthState(/"ollama-cloud\/glm-5\.1":[\s\S]*"state": "timeout"/);

        const rawStatus = await (plugin.tool as any).get_quota_backoff_status.execute({});
        const status = JSON.parse(rawStatus as string);

        const routeStatus = status["ollama-cloud/glm-5.1"];
        assert.equal(routeStatus?.state, "timeout");
        assert.equal(routeStatus?.type, "model_route");
        assert.equal((routeStatus?.retryCount ?? 0) >= 1, true);
      });
    } finally {
      if (originalTimeoutValue === undefined) {
        delete process.env.AICODER_ROUTE_HANG_TIMEOUT_MS;
      } else {
        process.env.AICODER_ROUTE_HANG_TIMEOUT_MS = originalTimeoutValue;
      }
    }
  });
});

test("chat_params_whenModelIsInRegistry_setsCapabilityTierTemperature", async () => {
  // Regression: findRegistryEntryByModel used to compare
  // `providerRoute.model === model.id` where providerRoute.model is the
  // COMPOSITE form ("ollama-cloud/glm-4.7") from models.jsonc and
  // opencode's runtime model.id is the RAW form ("glm-4.7"). The
  // comparison never matched and the chat.params hook's temperature
  // override silently never fired — every session ran at opencode's
  // default temperature instead of the curated capability-tier value.
  // Same bug killed the `## Active model routing context` system-prompt
  // injection in experimental.chat.system.transform. This test pins the
  // composite-vs-raw contract by asserting chat.params DOES set the
  // temperature when a real registry model is passed in.
  await withIsolatedHome(async (homeDirectory) => {
    await writeAuthFile(homeDirectory, {
      "ollama-cloud": "token-value",
    });
    // Use a large hang timeout so chat.params takes the production branch
    // and not the test-only fast-timeout branch.
    const originalTimeoutValue = process.env.AICODER_ROUTE_HANG_TIMEOUT_MS;
    process.env.AICODER_ROUTE_HANG_TIMEOUT_MS = "900000";
    try {
      await withFreshHealthState(async () => {
        const { ModelRegistryPlugin } = await import("./model-registry.js");
        const plugin = await (ModelRegistryPlugin as any)({ directory: process.cwd() });

        const output: Record<string, unknown> = {};
        await (plugin["chat.params"] as any)(
          {
            sessionID: "session-temperature-override",
            provider: { info: { id: "ollama-cloud" } },
            // glm-4.7 is `capability_tier: strong` in config/models.jsonc
            // → CAPABILITY_TIER_TO_TEMPERATURE.strong === 0.6.
            model: { id: "glm-4.7", providerID: "ollama-cloud" },
          },
          output,
        );

        assert.equal(output.temperature, 0.6);
      });
    } finally {
      if (originalTimeoutValue === undefined) {
        delete process.env.AICODER_ROUTE_HANG_TIMEOUT_MS;
      } else {
        process.env.AICODER_ROUTE_HANG_TIMEOUT_MS = originalTimeoutValue;
      }
    }
  });
});

test("provider_models_whenOpenrouterEntryHasCompositePrefix_filterRetainsRawModelIDKeys", async () => {
  // Regression: buildEnabledProviderModelSet used to dump
  // `provider_order[].model` values — which are the COMPOSITE form
  // ("openrouter/xiaomi/mimo-v2-pro") per models.jsonc convention — into
  // a Set that was then checked against `Object.entries(provider.models)`
  // keys. Opencode's provider.models is keyed by the provider-relative
  // RAW id ("xiaomi/mimo-v2-pro"), so the Set.has check never matched
  // and the openrouter provider.models hook silently returned `{}` —
  // hiding every curated model from opencode's model picker. This test
  // pins the prefix-stripping contract by asserting the hook preserves
  // the raw-id key when a matching composite registry entry exists.
  await withIsolatedHome(async (homeDirectory) => {
    await writeAuthFile(homeDirectory, {
      openrouter: { type: "api", key: "real-key" },
    });

    await withFreshHealthState(async () => {
      const { ModelRegistryPlugin } = await import("./model-registry.js");
      const plugin = await (ModelRegistryPlugin as any)({ directory: process.cwd() });

      // Build a fake opencode ProviderV2 with models keyed by raw id.
      // Include one id that IS in the registry and one that is not.
      const fakeProvider = {
        id: "openrouter",
        models: {
          "xiaomi/mimo-v2-pro": { id: "xiaomi/mimo-v2-pro", providerID: "openrouter" },
          "not-in-registry/model": { id: "not-in-registry/model", providerID: "openrouter" },
        },
      };

      const result = await (plugin.provider.models as any)(fakeProvider, {});

      // The raw-id key for the registry entry must survive the filter.
      assert.equal(Object.keys(result).includes("xiaomi/mimo-v2-pro"), true);
      // The non-curated model must be filtered out.
      assert.equal(Object.keys(result).includes("not-in-registry/model"), false);
    });
  });
});
