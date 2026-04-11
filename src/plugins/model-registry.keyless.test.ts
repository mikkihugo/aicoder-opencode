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
