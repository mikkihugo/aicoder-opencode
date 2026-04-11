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
