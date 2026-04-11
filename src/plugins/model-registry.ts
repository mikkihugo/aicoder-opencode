import type { Event } from "@opencode-ai/sdk";
import { type Plugin, tool } from "@opencode-ai/plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";

import {
  buildModelRegistryPayload,
  type CapabilityTier,
  type ModelRegistryEntry,
  filterModelRegistryEntries,
  loadModelRegistry,
  filterVisibleProviderRoutes,
} from "../model-registry.js";

const PLUGIN_SOURCE_FILE_PATH = fileURLToPath(import.meta.url);
const PLUGIN_SOURCE_DIRECTORY = path.dirname(PLUGIN_SOURCE_FILE_PATH);
const CONTROL_PLANE_ROOT_DIRECTORY = path.resolve(
  PLUGIN_SOURCE_DIRECTORY,
  "..",
  "..",
);
const OPENROUTER_PROVIDER_ID = "openrouter";
const MODEL_REGISTRY_LOAD_ERROR_MESSAGE =
  "Failed to load model registry for model-registry plugin hooks.";
const ACTIVE_MODEL_ROUTING_CONTEXT_HEADER = "## Active model routing context";
const PROVIDER_QUOTA_STATUS_HEADER = "## Provider health status";
const AVAILABLE_MODELS_HEADER = "## Available models by role/task";
const NO_FALLBACK_MODEL_CONFIGURED_MESSAGE = "no fallback configured";

const PROVIDER_HEALTH_STATE_FILE = path.join(
  CONTROL_PLANE_ROOT_DIRECTORY,
  ".opencode",
  "state",
  "plugin",
  "provider-health.json",
);

// Providers and model name substrings excluded from fallback suggestions.
const FALLBACK_BLOCKED_PROVIDER_IDS = new Set([
  "longcat-openai",
  "longcat",
  "anthropic",
  "openai",
  "xai",
  "github-copilot",
]);
const FALLBACK_BLOCKED_MODEL_SUBSTRINGS = ["longcat", "claude", "gpt", "grok"];

const CAPABILITY_TIER_TO_TEMPERATURE: Record<CapabilityTier, number> = {
  frontier: 0.7,
  strong: 0.6,
  standard: 0.5,
  fast: 0.3,
  tiny: 0.3,
};

// Billing mode preference order for model selection (lower index = more preferred).
const BILLING_MODE_PREFERENCE_ORDER = ["free", "subscription", "quota", "paid_api"] as const;

type ProviderHealthState = "quota" | "key_dead" | "no_credit" | "key_missing" | "model_not_found" | "timeout";

// Runtime guard for `ProviderHealthState`. Used by `parsePersistedHealthEntry`
// to reject disk entries whose `state` field is corrupt, schema-drifted from
// an older plugin version, or manually-edited to something unrecognized.
// Keep in sync with the `ProviderHealthState` union above.
const PROVIDER_HEALTH_STATES: ReadonlySet<string> = new Set<ProviderHealthState>([
  "quota",
  "key_dead",
  "no_credit",
  "key_missing",
  "model_not_found",
  "timeout",
]);

type ProviderHealth = {
  state: ProviderHealthState;
  until: number;
  retryCount: number;
};

type ModelRouteHealth = {
  state: ProviderHealthState;
  until: number;
  retryCount: number;
};

type TaskComplexity = "small" | "medium" | "large";

type AgentMetadata = {
  model?: string;
  models?: string[];
  routing_role?: string;
  routing_complexity?: TaskComplexity;
};

type ModelRouteDecision = {
  selectedModelRoute: string;
  reasoning: string;
};

type PersistedHealthMap = Record<string, Omit<ProviderHealth, 'until'> & { until: number | "never" }>;

type ModelIdentity = {
  id: string;
  providerID: string;
};

function logRegistryLoadError(error: unknown): void {
  console.error(MODEL_REGISTRY_LOAD_ERROR_MESSAGE, error);
}

/**
 * Validate and normalize one raw entry from the persisted health JSON.
 *
 * Returns `null` when the entry is structurally corrupt (null, missing
 * fields, unknown state, non-numeric retryCount, un-parseable until). The
 * caller should skip nulls rather than abort the whole load — a single
 * bad entry must not nuke valid sibling entries.
 *
 * Args:
 *   rawEntry: The parsed-JSON value at one key in the persisted health map.
 *     Type is `unknown` because the on-disk file can be schema-drifted from
 *     older plugin versions, manually edited, or partially corrupted.
 *   now: Current wall-clock ms — entries with `until <= now` return `null`
 *     so the caller treats them as already-expired.
 *
 * Returns:
 *   `{ state, until, retryCount }` with `until` normalized to `number`
 *   (`"never"` → `Number.POSITIVE_INFINITY`), or `null` on any validation
 *   failure or expiry.
 */
export function parsePersistedHealthEntry(
  rawEntry: unknown,
  now: number,
): ProviderHealth | null {
  if (rawEntry === null || typeof rawEntry !== "object") return null;
  const entry = rawEntry as Record<string, unknown>;

  const state = entry.state;
  if (typeof state !== "string" || !PROVIDER_HEALTH_STATES.has(state)) return null;

  const rawUntil = entry.until;
  let until: number;
  if (rawUntil === "never") {
    until = Number.POSITIVE_INFINITY;
  } else if (typeof rawUntil === "number" && Number.isFinite(rawUntil)) {
    until = rawUntil;
  } else {
    // Corrupt: string that isn't "never", NaN, boolean, null, missing, etc.
    // Reject rather than coerce — silent coercion used to produce NaN
    // zombies (NaN <= now is always false) that never expired.
    return null;
  }
  if (until <= now) return null;

  const retryCount = entry.retryCount;
  if (typeof retryCount !== "number" || !Number.isFinite(retryCount) || retryCount < 0) {
    return null;
  }

  return {
    state: state as ProviderHealthState,
    until,
    retryCount,
  };
}

async function loadPersistedProviderHealth(): Promise<{
  providerHealthMap: Map<string, ProviderHealth>;
  modelRouteHealthMap: Map<string, ModelRouteHealth>;
}> {
  const providerHealthMap = new Map<string, ProviderHealth>();
  const modelRouteHealthMap = new Map<string, ModelRouteHealth>();
  try {
    const raw = await readFile(PROVIDER_HEALTH_STATE_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { providerHealthMap, modelRouteHealthMap };
    }
    const now = Date.now();
    for (const [key, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
      // Per-entry validation + isolation: one corrupt entry must NOT
      // discard valid sibling entries. Previously a single null / missing
      // field threw from inside this loop, the outer catch swallowed it,
      // and every live backoff was silently lost on plugin restart.
      const normalized = parsePersistedHealthEntry(rawEntry, now);
      if (normalized === null) continue;

      // persistProviderHealth writes BOTH provider entries (`"iflowcn"`)
      // and route entries (`"iflowcn/qwen3-coder-plus"`) into one flat
      // JSON. Route keys always contain `/`; provider IDs never do.
      // Split them back into the correct maps so route-level backoffs
      // survive plugin restart and do not zombie-accumulate in the
      // provider map.
      const isRouteKey = key.includes("/");
      if (isRouteKey) {
        modelRouteHealthMap.set(key, normalized);
      } else {
        providerHealthMap.set(key, normalized);
      }
    }
  } catch {
    // Missing / unreadable file / JSON.parse failure → start fresh.
  }
  return { providerHealthMap, modelRouteHealthMap };
}

async function persistProviderHealth(
  healthMap: Map<string, ProviderHealth>,
  routeHealthMap?: Map<string, ModelRouteHealth>,
): Promise<void> {
  try {
    await mkdir(path.dirname(PROVIDER_HEALTH_STATE_FILE), { recursive: true });
    const obj: PersistedHealthMap = Object.fromEntries(
      Array.from(healthMap.entries()).map(([key, health]) => [
        key,
        {
          ...health,
          until: health.until === Number.POSITIVE_INFINITY ? "never" : health.until,
        },
      ]),
    );

    // Also persist model route health
    if (routeHealthMap) {
      for (const [routeKey, health] of routeHealthMap.entries()) {
        obj[routeKey] = {
          ...health,
          until: health.until === Number.POSITIVE_INFINITY ? "never" : health.until,
        };
      }
    }

    // Atomic write: tmp file + rename prevents concurrent-writer corruption
    // when multiple opencode services (aicoder-opencode, dr-repo, letta-workspace)
    // share this state file. Without this, a shorter write layered over a longer
    // prior write leaves stale tail bytes and produces invalid JSON on disk.
    const temporaryFilePath = `${PROVIDER_HEALTH_STATE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(temporaryFilePath, JSON.stringify(obj, null, 2), "utf8");
      await rename(temporaryFilePath, PROVIDER_HEALTH_STATE_FILE);
    } catch (renameError) {
      // Best-effort cleanup of the tmp file on failure.
      try {
        await unlink(temporaryFilePath);
      } catch {
        // Ignore — tmp file may not exist.
      }
      throw renameError;
    }
  } catch {
    // Non-fatal — in-memory state still works.
  }
}

/**
 * Filter a raw opencode `provider.models` map down to enabled, route-healthy
 * raw model ids for one provider.
 *
 * Used by the `provider.models` hook. Previously the hook only consulted
 * `providerHealthMap` for the whole provider (e.g. `openrouter` as a unit) —
 * if a SPECIFIC route had a `model_not_found` / zero-token quota / hang
 * `timeout` entry in `modelRouteHealthMap`, the model was still advertised
 * as available to opencode's router, which would then pick it, fail, record
 * the penalty again, and loop. Route-level penalties were effectively
 * invisible to opencode's routing layer even though every other reader in
 * this plugin honors them.
 *
 * Args:
 *   providerModels: The opencode-supplied raw models map (typed unknown-value
 *     because the opencode runtime shape is provider-specific and not worth
 *     re-declaring here — we only need the keys).
 *   enabledRawModelIDs: Raw model ids the registry marks enabled for this
 *     provider (built by `buildEnabledProviderModelSet`).
 *   providerID: The opencode provider id (e.g. `"openrouter"`).
 *   modelRouteHealthMap: In-memory route health table; entries with
 *     `until > now` are treated as blocked.
 *   now: Wall-clock timestamp in ms.
 *
 * Returns:
 *   A new map containing only entries whose key is both (a) enabled per the
 *   registry for this provider and (b) not currently penalized at the route
 *   level. Route keys are composed via `composeRouteKey` so the write-side
 *   convention (`${providerID}/${model.id}`) stays symmetric with the
 *   read-side lookup.
 */
export function filterProviderModelsByRouteHealth(
  providerModels: Record<string, unknown>,
  enabledRawModelIDs: Set<string>,
  providerID: string,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [modelID, modelValue] of Object.entries(providerModels)) {
    if (!enabledRawModelIDs.has(modelID)) continue;
    const routeKey = composeRouteKey({ provider: providerID, model: modelID });
    const routeHealth = modelRouteHealthMap.get(routeKey);
    if (routeHealth && routeHealth.until > now) continue;
    filtered[modelID] = modelValue;
  }
  return filtered;
}

function buildEnabledProviderModelSet(
  modelRegistryEntries: ModelRegistryEntry[],
  providerID: string,
): Set<string> {
  // opencode's `provider.models` is keyed by the provider-relative raw model
  // id (e.g. `"xiaomi/mimo-v2-pro"` for the openrouter provider), but
  // `provider_order[].model` in models.jsonc is the COMPOSITE form
  // (`"openrouter/xiaomi/mimo-v2-pro"`) by registry convention. The filter
  // in the `provider.models` hook compares Set.has(modelID) against those
  // raw keys, so we normalize by stripping the `${providerID}/` prefix.
  // Without this, the Set never matches any key and the openrouter
  // curation hook silently returns `{}` — zero models visible to opencode.
  const providerPrefix = `${providerID}/`;
  const rawModelIDs = new Set<string>();
  for (const modelRegistryEntry of modelRegistryEntries) {
    if (!modelRegistryEntry.enabled) continue;
    for (const providerRoute of modelRegistryEntry.provider_order) {
      if (providerRoute.provider !== providerID) continue;
      const rawModelID = providerRoute.model.startsWith(providerPrefix)
        ? providerRoute.model.slice(providerPrefix.length)
        : providerRoute.model;
      rawModelIDs.add(rawModelID);
    }
  }
  return rawModelIDs;
}

export function findRegistryEntryByModel(
  modelRegistryEntries: ModelRegistryEntry[],
  model: ModelIdentity,
): ModelRegistryEntry | undefined {
  // Opencode's runtime `Model` shape is `{ id, providerID }` where `id`
  // is normally the RAW short id ("glm-4.7") and `providerID` is the
  // opencode provider id ("ollama-cloud"). The registry's
  // `provider_order[].model` field is the COMPOSITE form
  // ("ollama-cloud/glm-4.7") for most entries, but for a handful of
  // provider-specific entries (longcat: `LongCat-Flash-Chat`,
  // `LongCat-Flash-Thinking`, `LongCat-Flash-Lite`) it is UNPREFIXED —
  // the same asymmetry `composeRouteKey` (M30) was introduced to absorb
  // on the health-map write/read paths.
  //
  // Previously this helper hand-rolled the comparison in two branches:
  // one concatenating a synthetic `${providerID}/${id}` composite to
  // match the common case, and a defensive `(provider === providerID &&
  // model === id)` branch to catch unprefixed registry entries. Both
  // branches silently failed if the runtime `model.id` ever arrived
  // already-composite (e.g. an adjacent plugin's `provider.models` hook
  // rewrote the id) AND the matching registry row was ALSO authored
  // without a `provider/` prefix: the synthetic composite double-prefixed
  // to `"ollama-cloud/ollama-cloud/glm-4.7"` and the defensive branch
  // compared the raw unprefixed registry model against the already-
  // composite runtime id. No match → undefined → both the capability-
  // tier temperature override AND the `## Active model routing context`
  // system-prompt injection silently dropped for that session.
  //
  // Share `composeRouteKey` on BOTH sides of the comparison so both the
  // runtime identity and the registry route are normalized to the same
  // composite form before comparing. The helper is idempotent (the M30
  // `.startsWith(${provider}/)` guard handles the already-prefixed case),
  // so the four-way cartesian of {prefixed, unprefixed} × {runtime,
  // registry} all collapse to the same canonical key.
  const runtimeCompositeKey = composeRouteKey({
    provider: model.providerID,
    model: model.id,
  });
  return modelRegistryEntries.find((modelRegistryEntry) =>
    modelRegistryEntry.provider_order.some(
      (providerRoute) => composeRouteKey(providerRoute) === runtimeCompositeKey,
    ),
  );
}

function buildRoutingContextSystemPrompt(modelRegistryEntry: ModelRegistryEntry): string {
  return [
    ACTIVE_MODEL_ROUTING_CONTEXT_HEADER,
    `Model: ${modelRegistryEntry.id}`,
    `Description: ${modelRegistryEntry.description}`,
    `Roles: ${modelRegistryEntry.default_roles.join(", ")}`,
    `Best for: ${modelRegistryEntry.best_for.join(", ")}`,
    `Not for: ${modelRegistryEntry.not_for.join(", ")}`,
    `Concurrency limit: ${modelRegistryEntry.concurrency}`,
    `Cost tier: ${modelRegistryEntry.cost_tier} | Billing: ${modelRegistryEntry.billing_mode}`,
  ].join("\n");
}

/**
 * Canonicalize a registry route to the composite `provider/model-id` form
 * used by `modelRouteHealthMap` keys.
 *
 * Write-side keys are always built as `${providerID}/${model.id}` from the
 * opencode runtime event payloads (see session.error, assistant.message.completed,
 * chat.params hang timer). Read-side lookups, however, have historically
 * passed `providerRoute.model` verbatim — which for most registry entries is
 * already composite (e.g. `ollama-cloud/glm-5`) but for a handful of entries
 * is UNPREFIXED (longcat's `LongCat-Flash-Chat`, `LongCat-Flash-Thinking`,
 * `LongCat-Flash-Lite` — see models.jsonc). That meant any route-level
 * penalty recorded for longcat models was silently undetectable by readers,
 * and the agent was told those dead routes were still healthy.
 *
 * This helper normalizes in one place so the write-vs-read key shape can
 * never drift again. Kept as a pure function for direct unit testing.
 */
export function composeRouteKey(providerRoute: { provider: string; model: string }): string {
  if (providerRoute.model.startsWith(`${providerRoute.provider}/`)) {
    return providerRoute.model;
  }
  return `${providerRoute.provider}/${providerRoute.model}`;
}

function isFallbackBlocked(providerID: string, modelID: string): boolean {
  if (FALLBACK_BLOCKED_PROVIDER_IDS.has(providerID)) {
    return true;
  }
  const lowerModelID = modelID.toLowerCase();
  return FALLBACK_BLOCKED_MODEL_SUBSTRINGS.some((blocked) =>
    lowerModelID.includes(blocked),
  );
}

/**
 * Drop entries from both health maps whose penalty window has elapsed.
 *
 * Called from `experimental.chat.system.transform` on every invocation
 * so long-running sessions do not accumulate stale health state in
 * memory OR in the persisted `providerHealth.json` file (which is
 * rewritten from these maps whenever an error event fires).
 *
 * Args:
 *   providerHealthMap: In-place map of provider-id → health (mutated).
 *   modelRouteHealthMap: In-place map of composite-route → health (mutated).
 *   now: Current wall-clock timestamp in ms (epoch).
 *
 * Note:
 *   `key_missing` entries have `until = Number.POSITIVE_INFINITY` and
 *   are correctly never expired.
 */
export function expireHealthMaps(
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): void {
  for (const [providerID, health] of providerHealthMap.entries()) {
    if (health.until <= now) {
      providerHealthMap.delete(providerID);
    }
  }
  for (const [routeKey, health] of modelRouteHealthMap.entries()) {
    if (health.until <= now) {
      modelRouteHealthMap.delete(routeKey);
    }
  }
}

/**
 * Remove a session's entries from all three per-session hang-detection maps.
 *
 * Called from every terminal-event handler (`session.error`,
 * `assistant.message.completed`) so session state does not accumulate
 * for the full lifetime of the plugin process.
 *
 * Args:
 *   sessionID: The session identifier to purge.
 *   sessionStartTimeMap: Turn-start timestamp map (mutated).
 *   sessionActiveProviderMap: Provider-id-per-session map (mutated).
 *   sessionActiveModelMap: Active model-per-session map (mutated).
 *
 * Note:
 *   Clearing the start-time entry is the critical step — the hang-detector
 *   `setTimeout` scheduled in `chat.params` short-circuits when the entry
 *   is absent, so the late-firing timer is harmless even after the
 *   other two maps are cleared.
 */
/**
 * Compute the next `ProviderHealth` record given an incoming penalty
 * classification, preserving the longer-lived lockout.
 *
 * Previously `recordProviderHealth` unconditionally overwrote any existing
 * entry. A provider already in `no_credit` (2h duration) that subsequently
 * hit a 429 was downgraded to `quota` (1h duration), shortening the
 * lockout by an hour and causing the plugin to retry the provider long
 * before it could plausibly have recovered. A provider in `key_missing`
 * (until=Infinity) could also be silently downgraded to a finite penalty
 * by a spurious subsequent error — a particularly bad outcome because
 * `key_missing` is the canonical "don't route here at all" state.
 *
 * Policy: if `existing.until > newUntil`, preserve the existing entry
 * entirely (state + until) and only bump `retryCount`. Otherwise accept
 * the incoming state and until. `retryCount` always increments so repeat
 * failures remain observable in the health tool output.
 *
 * Args:
 *   existing: The current entry for this provider, or `undefined` when
 *     none exists.
 *   newState: The state classification derived from the incoming error.
 *   newUntil: Absolute wall-clock expiry for the incoming penalty (ms).
 *
 * Returns:
 *   The next `ProviderHealth` record to store.
 */
export function computeProviderHealthUpdate(
  existing: ProviderHealth | undefined,
  newState: ProviderHealthState,
  newUntil: number,
): ProviderHealth {
  if (existing && existing.until > newUntil) {
    return {
      state: existing.state,
      until: existing.until,
      retryCount: existing.retryCount + 1,
    };
  }
  return {
    state: newState,
    until: newUntil,
    retryCount: (existing?.retryCount ?? 0) + 1,
  };
}

/**
 * Build the `{routeKey, health}` pair that writers of `modelRouteHealthMap`
 * should store, normalizing the key through `composeRouteKey` so write-side
 * and read-side lookups cannot drift.
 *
 * Before this helper, the four write sites (`session.error` model_not_found,
 * `assistant.message.completed` zero-token quota, `chat.params` immediate
 * timeout, `chat.params` hang-timer timeout) all built the key as the
 * naive template literal `${providerID}/${model.id}`. When opencode
 * delivers a model id that is ALREADY composite — common for non-openrouter
 * providers where `model.id = "ollama-cloud/glm-5"` — the naive write
 * produced `ollama-cloud/ollama-cloud/glm-5`, which no reader using
 * `composeRouteKey` could ever look up. The penalty was written to a
 * dead key that lived forever in-memory and on-disk as a zombie, while
 * the actual route was still advertised as healthy and the router
 * immediately re-selected it, re-failed, re-zombied, in a tight loop.
 * Simultaneously, a plain-id provider like `longcat` (unprefixed
 * `LongCat-Flash-Chat`) worked fine, so the bug was provider-specific
 * and silent until one of the affected routes actually failed.
 *
 * The fix routes writers through `composeRouteKey`, which is idempotent
 * on already-composite ids and additive on plain ones. The pair return
 * value stays pure so the helper can be unit-tested without touching a
 * live `modelRouteHealthMap`.
 *
 * Args:
 *   providerID: The opencode runtime provider id (`input.provider.info.id`
 *     or `sessionActiveProviderMap.get(sessionID)`).
 *   modelID: The opencode runtime model id (`model.id`), which may or may
 *     not already contain the provider prefix — this helper handles both.
 *   state: The classified penalty state for the incoming error.
 *   durationMs: How long (from `now`) the penalty should last.
 *   existing: The current entry at this key, used to increment `retryCount`
 *     so repeat failures remain observable in the health tool output.
 *   now: Current wall-clock timestamp in ms (injected for testability).
 *
 * Returns:
 *   `{ routeKey, health }` — the caller writes `map.set(routeKey, health)`
 *   and then triggers persistence. The caller remains responsible for the
 *   mutation so this helper stays pure.
 */
/**
 * Backoff durations for the different penalty classes.
 *
 * These used to live inside the plugin closure (and still have closure-
 * level aliases for the existing call sites) but pure helpers like
 * `evaluateSessionHangForTimeoutPenalty` need them at module scope so
 * they can be imported by tests and referenced without constructing the
 * plugin. Keeping one authoritative source here prevents drift between
 * the helper and the closure.
 */
export const ROUTE_QUOTA_BACKOFF_DURATION_MS = 60 * 60 * 1000; // 1h
export const PROVIDER_KEY_DEAD_DURATION_MS = 2 * 60 * 60 * 1000; // 2h
export const PROVIDER_NO_CREDIT_DURATION_MS = 2 * 60 * 60 * 1000; // 2h

export function buildRouteHealthEntry(
  providerID: string,
  modelID: string,
  state: ProviderHealthState,
  durationMs: number,
  existing: ModelRouteHealth | undefined,
  now: number,
): { routeKey: string; health: ModelRouteHealth } {
  const routeKey = composeRouteKey({ provider: providerID, model: modelID });
  const newUntil = now + durationMs;
  // Preserve the longer-lived penalty, mirroring `computeProviderHealthUpdate`
  // (M36). Today all four route-level writers use the same 1h backoff, so
  // `existing.until > newUntil` is only reachable when `existing` was loaded
  // from disk with a future `until` produced by another process, or when a
  // later writer introduces a shorter penalty class. Either way, shrinking
  // a live penalty silently re-opens a known-bad route: the M36 bug at the
  // provider level used to pipe a 2h `key_dead` through a fresh 1h `quota`
  // event and revive a dead key every hour. Apply the same invariant here
  // before any future writer differentiates route durations and silently
  // re-introduces the bug at the route level. `retryCount` still
  // increments so repeat failures remain observable in the health report.
  if (existing && existing.until > newUntil) {
    return {
      routeKey,
      health: {
        state: existing.state,
        until: existing.until,
        retryCount: existing.retryCount + 1,
      },
    };
  }
  return {
    routeKey,
    health: {
      state,
      until: newUntil,
      retryCount: (existing?.retryCount ?? 0) + 1,
    },
  };
}

// HTTP status codes that are authoritative signals for specific penalty
// classes. When the upstream returns one of these, the status code wins
// over any keyword heuristic — a 402 is a 402 no matter what text the
// provider puts in the body.
const QUOTA_HTTP_STATUS_CODE = 429;
const NO_CREDIT_HTTP_STATUS_CODE = 402;
const KEY_DEAD_HTTP_STATUS_CODES: ReadonlySet<number> = new Set([401, 403]);
// HTTP status codes that may legitimately carry a "model not found" body.
// 404: direct providers returning HTTP-canonical not-found.
// 500: openrouter synthesizes `500 "Model not found"` when its router
//   cannot resolve the requested model to any upstream.
// 0:   no status code is available (proxy stripped it, network error, or
//   the runtime surfaced a structured error without a status). Accepting
//   the keyword match here is the only signal available.
// Authoritative status codes (401/402/403/429) are deliberately excluded
// so key_dead / no_credit / quota classification wins over a keyword
// match — see `shouldClassifyAsModelNotFound` for the bug history.
const MODEL_NOT_FOUND_HTTP_STATUS_CODES: ReadonlySet<number> = new Set([0, 404, 500]);
const MODEL_NOT_FOUND_KEYWORD = "model not found";

// Lowercased substring sets for the keyword-fallback path (used only
// when statusCode is 0 or unrecognized — e.g. network errors, proxies
// that strip status, providers that return 500 with a structured body).
// Kept narrow on purpose; broadening them produces false positives that
// quarantine healthy providers.
const QUOTA_KEYWORDS: readonly string[] = [
  "quota",
  "rate limit",
  "rate_limit",
  "too many requests",
];
const KEY_DEAD_KEYWORDS: readonly string[] = [
  "user not found",
  "invalid api key",
  "invalid key",
  "unauthorized",
  "authentication",
];
const NO_CREDIT_KEYWORDS: readonly string[] = [
  "insufficient credits",
  "no credit",
  "payment",
  "billing",
];

export type ProviderApiErrorClass =
  | "quota"
  | "no_credit"
  | "key_dead"
  | "unclassified";

/**
 * Classify a provider API error into its penalty class, giving HTTP
 * status codes authoritative priority over message-keyword heuristics.
 *
 * Previously the cascade was four parallel `(statusCode === X || KEYWORDS.some(...))`
 * checks evaluated top-down. Because of the `||`, a keyword match in the
 * EARLIER bucket pre-empted an authoritative status code in a LATER bucket:
 *
 *   - HTTP 402 + message `"rate limit exceeded: insufficient credits"` →
 *     the quota bucket matched `"rate limit"`, returned `quota` (1h),
 *     the provider was retried after an hour, failed again with the
 *     same 402, and the cycle repeated. Correct class: `no_credit` (2h).
 *   - HTTP 401 + message `"rate limit on unauthenticated requests"` →
 *     same pattern. Returned `quota` (1h) instead of `key_dead` (2h).
 *     A dead API key was silently retried every hour instead of being
 *     quarantined for the full key_dead window.
 *
 * Correct priority:
 *   1. Recognized HTTP status code (authoritative). 429 → quota;
 *      402 → no_credit; 401/403 → key_dead.
 *   2. Only when statusCode is 0 or unrecognized, fall back to message
 *      keywords in **longer-penalty-first** order: no_credit (2h) →
 *      key_dead (2h) → quota (1h). This mirrors the status-code fix at
 *      the keyword path: a message like `"rate limit exceeded: insufficient
 *      credits"` must NOT short-circuit to quota just because "rate limit"
 *      was checked first — the same false-quota-cycle bug the status-code
 *      path fixed is fully reachable at statusCode=0 (proxy strips the
 *      402, provider returns a structured 500 body, or an upstream network
 *      error surfaces with statusCode=0 and the provider's own JSON
 *      message). Symmetrically, a message containing an auth signal
 *      ("unauthorized", "authentication") alongside "rate limit" must
 *      classify as key_dead so a dead key isn't retried every hour.
 *
 * The helper is pure so it is unit-testable in isolation without any
 * live health maps or opencode runtime event payloads.
 *
 * Args:
 *   statusCode: The HTTP status code pulled from the opencode APIError
 *     payload, or 0 when absent / stripped by a proxy.
 *   lowerMessage: The error message, already lowercased at the call site
 *     (matches the existing convention for case-insensitive contains).
 *
 * Returns:
 *   The penalty class, or `"unclassified"` when neither the status nor
 *   any keyword identifies the error (e.g. a bare 500 with no body).
 *   Callers should skip applying any penalty on `"unclassified"` so
 *   transient upstream errors do not quarantine healthy providers.
 */
export function classifyProviderApiError(
  statusCode: number,
  lowerMessage: string,
): ProviderApiErrorClass {
  // Status codes win over keywords. If the upstream gave us an authoritative
  // signal, trust it and ignore whatever narrative the message contains.
  if (statusCode === QUOTA_HTTP_STATUS_CODE) return "quota";
  if (statusCode === NO_CREDIT_HTTP_STATUS_CODE) return "no_credit";
  if (KEY_DEAD_HTTP_STATUS_CODES.has(statusCode)) return "key_dead";

  // Keyword fallback — only reached when no recognized status was present.
  // Longer-penalty-first priority: a message that contains BOTH a quota
  // word and a more-specific financial/auth word must land in the
  // specific bucket, not the generic-quota one. Keyword sets are not
  // disjoint in practice — providers routinely wrap their real failure
  // in a "rate limit exceeded" wrapper.
  if (NO_CREDIT_KEYWORDS.some((kw) => lowerMessage.includes(kw))) return "no_credit";
  if (KEY_DEAD_KEYWORDS.some((kw) => lowerMessage.includes(kw))) return "key_dead";
  if (QUOTA_KEYWORDS.some((kw) => lowerMessage.includes(kw))) return "quota";

  return "unclassified";
}

/**
 * Decide whether an APIError should fire a route-level `model_not_found`
 * penalty (1h on the composite `provider/model` key) instead of a
 * provider-level penalty driven by `classifyProviderApiError`.
 *
 * History: the `session.error` handler used to check
 * `message.includes("model not found")` unconditionally, BEFORE calling
 * `classifyProviderApiError`, and then `return`ed on match. That path
 * short-circuited every authoritative provider-level status code whenever
 * the message narrative happened to contain the phrase. Reachable via
 * custom proxies, aggregator wrappers, and providers that embed the
 * requested model name in their auth/quota error bodies:
 *
 *   - `401 "unauthorized: your key cannot access model not found in allowlist"`
 *     → fired `model_not_found` (route-level, 1h) instead of `key_dead`
 *     (provider-level, 2h). Dead key retried every hour on just the one
 *     route while its sibling routes through the same dead provider
 *     continued to burn retries too.
 *   - `402 "insufficient credits: model not found in paid tier"`
 *     → fired `model_not_found` instead of `no_credit` (2h provider).
 *     Same half-quarantine bug.
 *   - `403 "forbidden: ... model not found ..."` → same as 401 path.
 *   - `429 "rate limit exceeded: model not found in free quota window"`
 *     → fired `model_not_found` (route-level) instead of `quota`
 *     (provider-level). Wrong SCOPE: the provider is throttling, not
 *     the model — all routes through that provider should back off.
 *
 * The fix mirrors the M35 priority-dominance rule inside
 * `classifyProviderApiError`: authoritative status codes (401/402/403/429)
 * must win over any keyword heuristic. Only statuses that genuinely mean
 * "this model does not exist at this provider" trigger the model-not-found
 * path — see the `MODEL_NOT_FOUND_HTTP_STATUS_CODES` set.
 *
 * The helper is pure so it is unit-testable without any live health maps
 * or opencode runtime event payloads.
 *
 * Args:
 *   statusCode: HTTP status code from the opencode APIError payload, or
 *     0 when absent.
 *   lowerMessage: Error message, already lowercased at the call site.
 *
 * Returns:
 *   `true` when the caller should fire a route-level `model_not_found`
 *   penalty. `false` when the authoritative status code should instead
 *   drive a provider-level classification via `classifyProviderApiError`.
 */
export function shouldClassifyAsModelNotFound(
  statusCode: number,
  lowerMessage: string,
): boolean {
  if (!lowerMessage.includes(MODEL_NOT_FOUND_KEYWORD)) return false;
  return MODEL_NOT_FOUND_HTTP_STATUS_CODES.has(statusCode);
}

/**
 * Count the number of visible provider routes of a registry entry that
 * are currently healthy (neither provider-level nor route-level penalty
 * is active).
 *
 * Used by `selectBestModelForRoleAndTask` to rank candidates by how many
 * live routes they still have. Previously the sort comparator used
 * `aUnhealthyCount - bUnhealthyCount` (ascending by unhealthy count),
 * which produced a subtle but reachable misordering: a candidate with
 * `1/1` unhealthy routes (0 healthy, totally dead) out-ranked a
 * candidate with `2/5` unhealthy routes (3 healthy, mostly live) because
 * `1 < 2`. The dead candidate won and the router then had no route to
 * actually try. Ranking by healthy count instead sorts the mostly-live
 * candidate first, which matches the intent ("prefer the model with the
 * most live fallback breadth").
 *
 * `filterVisibleProviderRoutes` is applied first so we ignore hidden /
 * paid-only / blocked routes — ranking should only consider routes the
 * plugin would actually select at runtime.
 *
 * Args:
 *   entry: The registry entry whose routes we are counting.
 *   providerHealthMap: In-memory provider health table.
 *   modelRouteHealthMap: In-memory composite-route health table.
 *   now: Wall-clock timestamp in ms.
 *
 * Returns:
 *   The integer count of visible routes whose provider AND composite
 *   route key are both unblocked at `now`.
 */
export function countHealthyVisibleRoutes(
  entry: ModelRegistryEntry,
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): number {
  return summarizeVisibleRouteHealth(entry, providerHealthMap, modelRouteHealthMap, now).healthy;
}

/**
 * Pair-valued companion to `countHealthyVisibleRoutes`: returns both the
 * healthy AND unhealthy visible-route counts in a single pass.
 *
 * `selectBestModelForRoleAndTask` ranks first by `healthy` descending so
 * candidates with the most live fallback breadth win. When two candidates
 * tie on `healthy` (e.g. both have 1 live route) it needs a secondary
 * signal to prefer the cleaner one — a `1 healthy / 0 dead` candidate
 * should beat a `1 healthy / 1 dead` candidate because the dead sibling
 * route represents known friction and future retry waste. A prior
 * iteration (M40) removed the `unhealthy` signal entirely in favor of
 * pure healthy-count ranking, which broke this tiebreaker and let dirty
 * candidates with a lucky primary route win over cleaner siblings.
 * Returning both numbers from one walk keeps the comparator branchless
 * and the helper pure / unit-testable.
 */
export function summarizeVisibleRouteHealth(
  entry: ModelRegistryEntry,
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): { healthy: number; unhealthy: number } {
  const visibleRoutes = filterVisibleProviderRoutes(entry.provider_order);
  let healthy = 0;
  let unhealthy = 0;
  for (const route of visibleRoutes) {
    const providerHealth = providerHealthMap.get(route.provider);
    if (providerHealth && providerHealth.until > now) {
      unhealthy++;
      continue;
    }
    const routeHealth = modelRouteHealthMap.get(composeRouteKey(route));
    if (routeHealth && routeHealth.until > now) {
      unhealthy++;
      continue;
    }
    healthy++;
  }
  return { healthy, unhealthy };
}

export function clearSessionHangState(
  sessionID: string,
  sessionStartTimeMap: Map<string, number>,
  sessionActiveProviderMap: Map<string, string>,
  sessionActiveModelMap: Map<string, { id: string; providerID: string }>,
): void {
  sessionStartTimeMap.delete(sessionID);
  sessionActiveProviderMap.delete(sessionID);
  sessionActiveModelMap.delete(sessionID);
}

/**
 * Thin orchestration wrapper around `evaluateSessionHangForTimeoutPenalty`
 * that ALSO clears the per-session hang-detection maps when a penalty is
 * recorded.
 *
 * Motivation: the `session.error` and `assistant.message.completed` event
 * handlers both call `clearSessionHangState` before returning — those are
 * the two "the session reached a terminal state" signals. But opencode
 * sessions can die silently: a network drop mid-stream, a client `Ctrl-C`
 * that tears down the connection without firing `session.error`, a parent
 * process kill that interrupts the event pipeline. In those scenarios
 * NEITHER terminal handler fires, so the session's entries in
 * `sessionStartTimeMap`, `sessionActiveProviderMap`, and
 * `sessionActiveModelMap` are leaked — a small per-session tuple (~150
 * bytes) accumulating once per silent-death session for the whole lifetime
 * of the plugin process.
 *
 * The `chat.params` hang-timer `setTimeout` is, in practice, the ONLY
 * signal we get about such sessions: it fires `timeoutMs + 100` after
 * start, and a non-null return from `evaluateSessionHangForTimeoutPenalty`
 * proves the session was still in the maps and had exceeded its budget
 * (i.e. it had genuinely hung or silently died — either way it's not
 * coming back). That's the right moment to also evict the session state,
 * which is exactly what this helper does.
 *
 * Kept as a separate wrapper (rather than baking the cleanup into
 * `evaluateSessionHangForTimeoutPenalty`) so the underlying query stays
 * pure and the M41 regression tests — which pin the helper's non-mutating
 * contract — do not need to change.
 *
 * Args:
 *   sessionID: The hung session's id.
 *   sessionStartTimeMap / sessionActiveProviderMap / sessionActiveModelMap:
 *     The three per-session hang-detection maps — mutated in-place when
 *     a penalty is recorded.
 *   modelRouteHealthMap: In-memory route health table. Read-only here:
 *     this helper computes the penalty entry but the caller still owns
 *     the `.set()` so the mutation stays visible at the call site.
 *   timeoutMs / now: Forwarded unchanged to
 *     `evaluateSessionHangForTimeoutPenalty`.
 *
 * Returns:
 *   `{ routeKey, health }` when a timeout penalty was computed AND the
 *   session maps were cleared, or `null` when no penalty applies (the
 *   session already completed, duration is still within budget, or the
 *   provider/model bindings were dropped). Maps stay untouched on null.
 */
export function finalizeHungSessionState(
  sessionID: string,
  sessionStartTimeMap: Map<string, number>,
  sessionActiveProviderMap: Map<string, string>,
  sessionActiveModelMap: Map<string, { id: string; providerID: string }>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  timeoutMs: number,
  now: number,
): { routeKey: string; health: ModelRouteHealth } | null {
  const result = evaluateSessionHangForTimeoutPenalty(
    sessionID,
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
    modelRouteHealthMap,
    timeoutMs,
    now,
  );
  if (result === null) return null;
  clearSessionHangState(
    sessionID,
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );
  return result;
}

/**
 * Pure helper invoked by the `chat.params` hang-timer `setTimeout` closure.
 *
 * Previously the closure captured the full opencode `input` object — a
 * reference that transitively holds the request's prompt body, tool list,
 * message history, and every other per-request payload. The timer is
 * armed for `AICODER_ROUTE_HANG_TIMEOUT_MS + 100` (default 900100 ms =
 * 15 min), so a process running many concurrent or back-to-back sessions
 * accumulates 15 minutes' worth of per-session request payloads pinned
 * in closure state, even for sessions that have long since completed.
 * `unref()` kept the process from being blocked on the timer but did NOT
 * break the closure retention — the timer object still holds the closure
 * until it fires or is cleared. This helper takes only primitive
 * `sessionID` plus the outer Map references; the closure can now capture
 * `(sessionID, timeoutMs, now)` via plain locals and drop the `input`
 * reference as soon as `chat.params` returns.
 *
 * Semantics (unchanged from the inline version):
 *  1. If the session's start-time is missing, the session already
 *     completed (`clearSessionHangState` ran) and no penalty is recorded.
 *  2. If elapsed time since the recorded start is not strictly greater
 *     than `timeoutMs`, the session is still within its budget and no
 *     penalty is recorded.
 *  3. If either the provider-id or model is missing for the session,
 *     classification is impossible and no penalty is recorded.
 *  4. Otherwise, build a fresh `ModelRouteHealth` entry with state
 *     `"timeout"` and `QUOTA_BACKOFF_DURATION_MS` lifetime, delegating to
 *     `buildRouteHealthEntry` so the route key is canonicalized via
 *     `composeRouteKey` and retry count is carried forward.
 *
 * Args:
 *   sessionID: Opaque session identifier (primitive string — the whole
 *     point of this helper is to avoid capturing anything richer).
 *   sessionStartTimeMap: Turn-start timestamp map.
 *   sessionActiveProviderMap: Provider-id-per-session map.
 *   sessionActiveModelMap: Active model-per-session map.
 *   modelRouteHealthMap: Route-health map consulted for `existing`.
 *   timeoutMs: The hang-timeout threshold this session was armed with.
 *   now: Wall-clock timestamp in ms.
 *
 * Returns:
 *   `{ routeKey, health }` when the session exceeded its budget and a
 *   route penalty should be written, or `null` when no penalty applies.
 *   The caller performs the `map.set` so the helper stays pure.
 */
export function evaluateSessionHangForTimeoutPenalty(
  sessionID: string,
  sessionStartTimeMap: Map<string, number>,
  sessionActiveProviderMap: Map<string, string>,
  sessionActiveModelMap: Map<string, { id: string; providerID: string }>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  timeoutMs: number,
  now: number,
): { routeKey: string; health: ModelRouteHealth } | null {
  const startTime = sessionStartTimeMap.get(sessionID);
  if (startTime === undefined) return null;

  const duration = now - startTime;
  if (duration <= timeoutMs) return null;

  const providerID = sessionActiveProviderMap.get(sessionID);
  const model = sessionActiveModelMap.get(sessionID);
  if (!providerID || !model) return null;

  return buildRouteHealthEntry(
    providerID,
    model.id,
    "timeout",
    ROUTE_QUOTA_BACKOFF_DURATION_MS,
    modelRouteHealthMap.get(
      composeRouteKey({ provider: providerID, model: model.id }),
    ),
    now,
  );
}

export function findCuratedFallbackRoute(
  modelRegistryEntry: ModelRegistryEntry,
  blockedProviderID: string,
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): string {
  // Only consider routes the rest of the plugin would actually reach.
  // Hidden/paid providers (togetherai, xai, cerebras, cloudflare-ai-gateway,
  // deepseek, github-copilot, minimax-cn*, non-:free openrouter routes like
  // openrouter/xiaomi/mimo-v2-pro) are curated out at every decision path
  // — returning them here would poison the agent-visible "Curated fallbacks"
  // system-prompt section with routes the agent cannot use.
  const visibleRoutes = filterVisibleProviderRoutes(modelRegistryEntry.provider_order);
  const allowedRoute = visibleRoutes.find(
    (providerRoute) => {
      if (providerRoute.provider === blockedProviderID) return false;
      if (isFallbackBlocked(providerRoute.provider, providerRoute.model)) return false;
      if (!isProviderHealthy(providerHealthMap, providerRoute.provider, now)) return false;
      const routeHealth = modelRouteHealthMap.get(composeRouteKey(providerRoute));
      if (routeHealth && routeHealth.until > now) return false;
      return true;
    },
  );

  if (!allowedRoute) {
    return NO_FALLBACK_MODEL_CONFIGURED_MESSAGE;
  }

  // provider_order[].model is already the composite "provider/model-id"
  // per registry convention (see models.jsonc). Do NOT re-prefix with
  // provider — that produces `ollama-cloud/ollama-cloud/glm-5.1` and
  // poisons the agent-visible system-prompt "Curated fallbacks" section.
  return allowedRoute.model;
}

/**
 * Compute a health report for the first visible route of a registry entry.
 *
 * Used by `list_curated_models` tool output so the agent sees route-level
 * penalties (model_not_found, zero-token quota) on its primary route, not
 * just provider-level ones. Previously the tool read `provider_order[0]`
 * raw and only checked provider health — a route with a dead model_id
 * underneath a healthy provider reported as "healthy" and the agent kept
 * routing there. Returns null when the primary visible route is fully
 * healthy, or when no visible route exists at all.
 */
export function computeRegistryEntryHealthReport(
  modelRegistryEntry: ModelRegistryEntry,
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): { state: string; until: string; scope: "provider" | "route" } | null {
  const visibleRoutes = filterVisibleProviderRoutes(modelRegistryEntry.provider_order);
  const primaryRoute = visibleRoutes[0] ?? null;
  if (!primaryRoute) return null;
  const providerHealth = providerHealthMap.get(primaryRoute.provider);
  if (providerHealth && providerHealth.until > now) {
    return {
      state: providerHealth.state,
      until: new Date(providerHealth.until).toISOString(),
      scope: "provider",
    };
  }
  const routeHealth = modelRouteHealthMap.get(composeRouteKey(primaryRoute));
  if (routeHealth && routeHealth.until > now) {
    return {
      state: routeHealth.state,
      until: new Date(routeHealth.until).toISOString(),
      scope: "route",
    };
  }
  return null;
}

function isProviderHealthy(
  providerHealthMap: Map<string, ProviderHealth>,
  providerID: string,
  now: number,
): boolean {
  const health = providerHealthMap.get(providerID);
  if (!health) return true;
  // key_missing state never expires (until: Number.POSITIVE_INFINITY)
  return health.until <= now;
}

function healthStateLabel(state: ProviderHealthState): string {
  switch (state) {
    case "quota": return "QUOTA BACKOFF";
    case "key_dead": return "KEY DEAD";
    case "no_credit": return "NO CREDIT";
    case "key_missing": return "KEY MISSING";
    case "model_not_found": return "MODEL NOT FOUND";
    case "timeout": return "TIMEOUT";
  }
}

export function buildProviderHealthSystemPrompt(
  modelRegistryEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): string | null {
  const activeProviderPenalties = Array.from(providerHealthMap.entries()).filter(
    ([, health]) => health.until > now,
  );
  const activeRoutePenalties = Array.from(modelRouteHealthMap.entries()).filter(
    ([, health]) => health.until > now,
  );

  if (activeProviderPenalties.length === 0 && activeRoutePenalties.length === 0) {
    return null;
  }

  const sections: string[] = [];

  for (const [providerID, health] of activeProviderPenalties) {
    const label = healthStateLabel(health.state);
    const until = new Date(health.until).toISOString();

    const affectedEntries = modelRegistryEntries.filter(
      (entry) =>
        entry.enabled &&
        entry.provider_order.some((route) => route.provider === providerID),
    );

    const fallbackLines = affectedEntries.map((entry) => {
      const fallback = findCuratedFallbackRoute(
        entry,
        providerID,
        providerHealthMap,
        modelRouteHealthMap,
        now,
      );
      return `- ${entry.id} → ${fallback}`;
    });

    sections.push([
      PROVIDER_QUOTA_STATUS_HEADER,
      `Provider ${providerID} [${label}] until ${until}.`,
      `Curated fallbacks (longcat/claude/gpt/grok excluded):`,
      ...fallbackLines,
    ].join("\n"));
  }

  // Route-level penalties: previously ignored by the system prompt because
  // the outer transform hook short-circuited on `providerHealthMap.size === 0`
  // and this function had no code path for route-only state. Reachable via
  // the `assistant.message.completed` zero-token → route quota handler,
  // the `session.error` "model not found" → route `model_not_found` handler,
  // and the hang-detector `setTimeout` → route `timeout` handler — all of
  // which write to `modelRouteHealthMap`, NOT `providerHealthMap`. Without
  // this section an agent running on a just-killed route got no warning at
  // all from the system prompt.
  for (const [routeKey, health] of activeRoutePenalties) {
    const label = healthStateLabel(health.state);
    const until = new Date(health.until).toISOString();

    const owningEntry = modelRegistryEntries.find(
      (entry) =>
        entry.enabled &&
        entry.provider_order.some((route) => composeRouteKey(route) === routeKey),
    );

    const header = [
      PROVIDER_QUOTA_STATUS_HEADER,
      `Route ${routeKey} [${label}] until ${until}.`,
    ];

    if (owningEntry) {
      // `findCuratedFallbackRoute` already consults `modelRouteHealthMap`
      // (per M24), so passing an empty `blockedProviderID` is safe — the
      // bad route is skipped by the route-health check, not by the
      // provider-id check. Any other route (same provider, different
      // model; or different provider entirely) is a valid fallback as
      // long as it is visible + provider-healthy + route-healthy.
      const fallback = findCuratedFallbackRoute(
        owningEntry,
        "",
        providerHealthMap,
        modelRouteHealthMap,
        now,
      );
      header.push(`Curated fallback for ${owningEntry.id}: ${fallback}`);
    }

    sections.push(header.join("\n"));
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}

/**
 * Build a role+task filtered view of currently healthy models for the system prompt.
 * Only injected when at least one provider has a health penalty.
 */
export function buildAvailableModelsSystemPrompt(
  modelRegistryEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): string | null {
  // Fire whenever EITHER map has entries. Route-only penalties (from
  // M27) need the fallback "what else is available" view just as much
  // as provider-level ones.
  if (providerHealthMap.size === 0 && modelRouteHealthMap.size === 0) {
    return null;
  }

  // Group enabled models by their first default_role, filtering to an
  // entry whose first VISIBLE route is both provider-healthy AND
  // route-healthy. Previously this walked raw `provider_order[0]` and
  // only checked provider health — same bug class as M23/M24 at a
  // different call site. An entry whose primary is a hidden/paid route
  // (e.g. openrouter/xiaomi/mimo-v2-pro, togetherai/*) was either
  // listed based on a route the rest of the plugin blocks, or skipped
  // entirely depending on the hidden route's provider health. An entry
  // whose primary had `model_not_found` but a healthy provider was
  // listed as available despite being dead.
  const roleToModels = new Map<string, string[]>();

  for (const entry of modelRegistryEntries) {
    if (!entry.enabled) continue;

    const visibleRoutes = filterVisibleProviderRoutes(entry.provider_order);
    const firstHealthyVisibleRoute = visibleRoutes.find((route) => {
      if (!isProviderHealthy(providerHealthMap, route.provider, now)) return false;
      const routeHealth = modelRouteHealthMap.get(composeRouteKey(route));
      if (routeHealth && routeHealth.until > now) return false;
      return true;
    });
    if (!firstHealthyVisibleRoute) continue;

    for (const role of entry.default_roles) {
      const existing = roleToModels.get(role) ?? [];
      if (existing.length < 2) {
        existing.push(`${entry.id} (${entry.billing_mode})`);
        roleToModels.set(role, existing);
      }
    }
  }

  if (roleToModels.size === 0) {
    return null;
  }

  const lines = Array.from(roleToModels.entries())
    .slice(0, 8)
    .map(([role, models]) => `- ${role}: ${models.join(", ")}`);

  return [AVAILABLE_MODELS_HEADER, ...lines].join("\n");
}

/**
 * Infer task complexity from a prompt description.
 */
/**
 * Keyword stems that signal a `large` complexity task. The match uses a
 * leading word boundary (`\b<stem>`) so inflections like "refactoring",
 * "systems", "completed" still count, but coincidental substrings inside
 * unrelated words (the classic false positive: "carefully" containing
 * "full") do not flip a trivial task into the strong/frontier tier.
 *
 * Note: the `-` in `end-to-end` is not a word char in the JS regex sense,
 * so a literal match is safer than building a regex for it — it's handled
 * as a separate substring check below.
 */
const LARGE_COMPLEXITY_KEYWORD_STEMS = [
  "rework", "refactor", "redesign", "architecture", "system", "across",
  "multiple", "comprehensive", "complete", "full", "entire",
] as const;
const LARGE_COMPLEXITY_LITERAL_PHRASES = ["end-to-end"] as const;

/**
 * Keyword stems for `medium` complexity. Same word-boundary rule: previously
 * `"add"`, `"fix"`, `"test"` matched "address", "prefix", "latest" as
 * substrings.
 */
const MEDIUM_COMPLEXITY_KEYWORD_STEMS = [
  "implement", "add", "update", "fix", "debug", "test", "verify",
  "improve", "enhance", "optimize", "integrate", "connect",
] as const;

function buildLeadingBoundaryRegex(stems: readonly string[]): RegExp {
  // Leading `\b` only, not trailing, so inflections (updates, refactoring,
  // completed, systemic) still match. A trailing boundary would force an
  // exact-word match and silently miss common variants.
  const alternation = stems.map((stem) => stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`\\b(?:${alternation})`, "i");
}

const LARGE_COMPLEXITY_REGEX = buildLeadingBoundaryRegex(LARGE_COMPLEXITY_KEYWORD_STEMS);
const MEDIUM_COMPLEXITY_REGEX = buildLeadingBoundaryRegex(MEDIUM_COMPLEXITY_KEYWORD_STEMS);

function inferTaskComplexity(prompt: string, _explicitComplexity: TaskComplexity | null): TaskComplexity {
  const lowerPrompt = prompt.toLowerCase();

  if (
    LARGE_COMPLEXITY_REGEX.test(lowerPrompt) ||
    LARGE_COMPLEXITY_LITERAL_PHRASES.some((phrase) => lowerPrompt.includes(phrase))
  ) {
    return "large";
  }

  if (MEDIUM_COMPLEXITY_REGEX.test(lowerPrompt)) {
    return "medium";
  }

  // Default to medium for unspecified tasks
  return "medium";
}

/**
 * Read agent metadata from the local .opencode/agents/ directory.
 */
async function readAgentMetadata(
  rootDirectory: string,
  agentName: string,
): Promise<AgentMetadata | null> {
  try {
    const agentFilePath = path.join(rootDirectory, ".opencode", "agents", `${agentName}.md`);
    const rawContent = await readFile(agentFilePath, "utf8");

    const frontmatterMatch = rawContent.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      return null;
    }

    const frontmatter = frontmatterMatch[1];
    const metadata: AgentMetadata = {};

    if (!frontmatter) {
      return null;
    }

    // Line-oriented parser that also understands YAML block lists:
    //   models:
    //     - provider/model-a
    //     - provider/model-b
    // When a `key:` has an empty scalar value, peek the next lines and
    // collect indented `- item` entries until we hit a non-list line.
    const frontmatterLines = frontmatter.split("\n");
    let lineIndex = 0;
    while (lineIndex < frontmatterLines.length) {
      const line = frontmatterLines[lineIndex] ?? "";
      lineIndex += 1;

      const colonIndex = line.indexOf(":");
      if (colonIndex < 1) continue;

      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();

      if (key === "model") {
        metadata.model = value;
      } else if (key === "models") {
        const inlineItems = value.length > 0
          ? value
              .replace(/^\[|\]$/g, "") // strip flow-style brackets if present
              .split(/\s*,\s*/)
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
          : [];

        const blockItems: string[] = [];
        while (lineIndex < frontmatterLines.length) {
          const peekLine = frontmatterLines[lineIndex] ?? "";
          const blockMatch = peekLine.match(/^\s+-\s+(.*)$/);
          if (!blockMatch) break;
          const item = (blockMatch[1] ?? "").trim().replace(/^["']|["']$/g, "");
          if (item.length > 0) blockItems.push(item);
          lineIndex += 1;
        }

        metadata.models = [...inlineItems, ...blockItems];
      } else if (key === "routing_role") {
        metadata.routing_role = value;
      } else if (key === "routing_complexity") {
        if (["small", "medium", "large"].includes(value)) {
          metadata.routing_complexity = value as TaskComplexity;
        }
      }
    }

    return metadata;
  } catch {
    return null;
  }
}

/**
 * Load API keys from the OpenCode auth.json file.
 */
/**
 * Opencode sources provider credentials from auth.json *and* from environment
 * variables. When a user has only the env var set (e.g. `OPENROUTER_API_KEY`)
 * the provider still works, so the plugin must not false-flag it as
 * `key_missing`. Map the provider ID to the env var names opencode honours.
 * Entries with no explicit override fall back to the convention
 * `<PROVIDER>_API_KEY` (dashes → underscores, uppercased).
 */
const PROVIDER_ENV_VAR_OVERRIDES: Record<string, readonly string[]> = {
  "kimi-for-coding": ["KIMI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  togetherai: ["TOGETHER_API_KEY", "TOGETHERAI_API_KEY"],
};

function providerEnvVarCandidates(providerID: string): readonly string[] {
  const overrides = PROVIDER_ENV_VAR_OVERRIDES[providerID];
  if (overrides) {
    return overrides;
  }
  const conventional = `${providerID.replace(/-/g, "_").toUpperCase()}_API_KEY`;
  return [conventional];
}

function providerHasEnvVarCredential(providerID: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const name of providerEnvVarCandidates(providerID)) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Read opencode's auth.json and report whether each provider has a usable
 * credential configured. The real opencode schema is:
 *   - { type: "api", key: "<string>" }              — API key entry
 *   - { type: "oauth", access: "...", refresh: "..." } — OAuth entry
 *
 * An earlier version of this plugin assumed { apiKey: string }, which does
 * not match any real auth.json entry and caused every provider to be
 * incorrectly flagged as `key_missing`. This function is now schema-aware
 * and also consults env var fallbacks so providers configured only through
 * `OPENROUTER_API_KEY` / `MINIMAX_API_KEY` / etc. are not false-flagged.
 */
async function loadAuthKeys(): Promise<Map<string, { hasCredential: boolean }>> {
  const result = new Map<string, { hasCredential: boolean }>();
  try {
    const authFilePath = path.join(
      process.env.HOME ?? "",
      ".local",
      "share",
      "opencode",
      "auth.json",
    );
    const raw = await readFile(authFilePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [providerID, value] of Object.entries(parsed)) {
      result.set(providerID, { hasCredential: hasUsableCredential(value) });
    }
  } catch {
    // auth.json may not exist or be unreadable; env-var fallback still applies.
  }
  return result;
}

/**
 * Check whether an auth.json entry has a usable credential.
 * Accepts the real opencode schemas, the legacy `{ apiKey }` shape (to keep
 * older fixtures working), and bare string values (used in some legacy tests).
 */
function hasUsableCredential(entry: unknown): boolean {
  if (typeof entry === "string") {
    return entry.length > 0;
  }
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as Record<string, unknown>;
  const entryType = typeof record.type === "string" ? record.type : undefined;
  if (entryType === "api") {
    return typeof record.key === "string" && record.key.length > 0;
  }
  if (entryType === "oauth") {
    return typeof record.access === "string" && record.access.length > 0;
  }
  // Legacy / fixture shape: { apiKey: "..." }
  if (typeof record.apiKey === "string" && record.apiKey.length > 0) {
    return true;
  }
  // Fallback: any object that carries a non-empty `key` string.
  if (typeof record.key === "string" && record.key.length > 0) {
    return true;
  }
  return false;
}

/**
 * Initialize provider health state by checking for missing API keys.
 */
async function initializeProviderHealthState(
  modelRegistryEntries: ModelRegistryEntry[],
): Promise<{
  providerHealthMap: Map<string, ProviderHealth>;
  modelRouteHealthMap: Map<string, ModelRouteHealth>;
}> {
  const { providerHealthMap, modelRouteHealthMap } = await loadPersistedProviderHealth();

  const authKeys = await loadAuthKeys();
  const knownProviders = new Set<string>();

  for (const entry of modelRegistryEntries) {
    for (const route of entry.provider_order) {
      knownProviders.add(route.provider);
    }
  }

  const now = Date.now();
  let hasChanges = false;
  for (const providerID of knownProviders) {
    const hasKey =
      authKeys.get(providerID)?.hasCredential === true ||
      providerHasEnvVarCredential(providerID);

    const existing = providerHealthMap.get(providerID);

    if (existing?.state === "key_missing") {
      // Reconcile stale `key_missing` state from disk: if a credential
      // is NOW present (user added an API key or oauth token between
      // plugin restarts), clear the entry so the provider becomes
      // usable again. Previously `key_missing` had until=Infinity and
      // was restored by loadPersistedProviderHealth — once set, it
      // permanently blocked the provider until someone manually edited
      // providerHealth.json, because the old early-exit (`if
      // (!providerHealthMap.has(providerID))`) skipped the hasKey
      // check whenever an entry already existed.
      if (hasKey) {
        providerHealthMap.delete(providerID);
        hasChanges = true;
      }
      continue;
    }

    // Only mark as key_missing if not already in a penalty state
    if (!existing && !hasKey) {
      providerHealthMap.set(providerID, {
        state: "key_missing",
        until: Number.POSITIVE_INFINITY,
        retryCount: 0,
      });
      hasChanges = true;
    }
  }

  if (hasChanges) {
    // Pass both maps so the restored route-level health (loaded above
    // via loadPersistedProviderHealth) is re-persisted alongside the
    // provider map. Without this, any key_missing update would drop
    // route entries from the next on-disk snapshot.
    await persistProviderHealth(providerHealthMap, modelRouteHealthMap);
  }

  return { providerHealthMap, modelRouteHealthMap };
}

/**
 * Recommend a model route for a task, considering agent metadata, provider health, and registry.
 */
async function recommendTaskModelRoute(
  rootDirectory: string,
  task: {
    subagent_type: string;
    prompt: string;
    complexity?: TaskComplexity;
    agent?: string;
    description?: string;
  },
  modelRegistryEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): Promise<ModelRouteDecision> {
  const agentMetadata = task.agent
    ? await readAgentMetadata(rootDirectory, task.agent)
    : task.subagent_type
      ? await readAgentMetadata(rootDirectory, task.subagent_type)
      : null;

  const complexity = task.complexity ??
    agentMetadata?.routing_complexity ??
    inferTaskComplexity(task.prompt, null);

  const preferredModels = agentMetadata?.models ??
    (agentMetadata?.model ? [agentMetadata.model] : []);

  // Only use explicit role from agent metadata; otherwise filter by complexity only
  const role = agentMetadata?.routing_role ?? null;

  // Filter to enabled models that match the role (if specified) and capability tier
  const tierMap: Record<TaskComplexity, CapabilityTier[]> = {
    small: ["tiny", "fast", "standard"],
    medium: ["standard", "strong"],
    large: ["strong", "frontier"],
  };
  const allowedTiers = tierMap[complexity];

  const roleMatchedEntries = modelRegistryEntries.filter((entry) => {
    if (!entry.enabled) return false;
    if (role && !entry.default_roles.includes(role)) return false;

    // Apply capability tier filter based on complexity
    return allowedTiers.includes(entry.capability_tier);
  });

  // When complexity allows multiple tiers, sort to prefer higher tiers first
  if (allowedTiers.length > 1) {
    const tierOrder = ["frontier", "strong", "standard", "fast", "tiny"] as const;
    roleMatchedEntries.sort((a, b) => {
      const aTierIdx = tierOrder.indexOf(a.capability_tier as typeof tierOrder[number]);
      const bTierIdx = tierOrder.indexOf(b.capability_tier as typeof tierOrder[number]);
      return aTierIdx - bTierIdx;
    });
  }

  // If agent has preferred models, try those first.
  //
  // Matching semantics: the agent declares composite routes like
  // `ollama-cloud/glm-5.1`. We find the registry entry that contains that
  // exact route, then return the first HEALTHY visible route from that
  // entry — which may be a different provider for the same model family
  // (e.g. `opencode-go/glm-5.1`) when the declared provider is unhealthy.
  // This honors the agent's model-family preference without stranding it
  // on a single provider.
  if (preferredModels.length > 0) {
    const isRouteHealthy = (route: { provider: string; model: string }): boolean => {
      if (!isProviderHealthy(providerHealthMap, route.provider, now)) return false;
      const routeHealth = modelRouteHealthMap.get(composeRouteKey(route));
      return !routeHealth || routeHealth.until <= now;
    };

    for (const preferredModel of preferredModels) {
      for (const entry of roleMatchedEntries) {
        const visibleRoutes = filterVisibleProviderRoutes(entry.provider_order);
        const entryContainsPreferred = visibleRoutes.some(
          (route) => route.model === preferredModel,
        );
        if (!entryContainsPreferred) continue;

        // Prefer the exact preferred route if it is healthy.
        const exactRoute = visibleRoutes.find(
          (route) => route.model === preferredModel && isRouteHealthy(route),
        );
        if (exactRoute) {
          return {
            selectedModelRoute: exactRoute.model,
            reasoning: `Preferred model from agent metadata, healthy provider`,
          };
        }

        // Otherwise fall back to any healthy visible route in the same
        // registry entry (same model family, different provider).
        const fallbackRoute = visibleRoutes.find((route) => isRouteHealthy(route));
        if (fallbackRoute) {
          return {
            selectedModelRoute: fallbackRoute.model,
            reasoning: `Preferred model from agent metadata, healthy fallback provider`,
          };
        }
      }
    }
  }

  // Fall back to selecting the best model from the registry
  const best = selectBestModelForRoleAndTask(
    roleMatchedEntries,
    providerHealthMap,
    modelRouteHealthMap,
    now,
    role,
    task.description ?? task.prompt,
    null,
  );

  if (best) {
    // Previously this branch used `best.provider_order[0]` unconditionally,
    // which was wrong in two ways:
    //   1. The raw `provider_order[0]` may be a hidden/paid route
    //      (togetherai, xai, cerebras, cloudflare-ai-gateway) that the
    //      curation layer deliberately blocks via filterVisibleProviderRoutes.
    //   2. It never checked provider health OR route-level health, so a
    //      model with a quota-backed-off provider and/or a timed-out route
    //      would still be returned as the "best" route — guaranteeing an
    //      immediate inference failure for the caller.
    // Walk the visible routes in priority order and return the first
    // healthy one. If none are healthy, fall through to the last-resort
    // healthy-route scan below so the caller gets a working route.
    const visibleRoutes = filterVisibleProviderRoutes(best.provider_order);
    const bestRouteIsHealthy = (route: { provider: string; model: string }): boolean => {
      if (!isProviderHealthy(providerHealthMap, route.provider, now)) return false;
      const routeHealth = modelRouteHealthMap.get(composeRouteKey(route));
      return !routeHealth || routeHealth.until <= now;
    };
    const primaryRoute = visibleRoutes.find(bestRouteIsHealthy);
    if (primaryRoute) {
      return {
        // primaryRoute.model is already composite "provider/model-id".
        selectedModelRoute: primaryRoute.model,
        reasoning: `Best registry model for role '${role}' and complexity '${complexity}'`,
      };
    }
  }

  // Last resort: use the first visible route from any role-matched entry
  // whose PROVIDER AND ROUTE are both healthy. Previously this only checked
  // provider health, so it could return a route with a route-level
  // `model_not_found` / quota / hang `timeout` penalty and the caller would
  // get a route that's guaranteed to fail on inference. Same bug class as
  // M29/M31 at the terminal fallback path.
  for (const entry of roleMatchedEntries) {
    const visibleRoutes = filterVisibleProviderRoutes(entry.provider_order);
    for (const route of visibleRoutes) {
      if (!isProviderHealthy(providerHealthMap, route.provider, now)) continue;
      const routeHealth = modelRouteHealthMap.get(composeRouteKey(route));
      if (routeHealth && routeHealth.until > now) continue;
      return {
        selectedModelRoute: route.model,
        reasoning: `Fallback to first healthy visible route`,
      };
    }
  }

  throw new Error(
    `No healthy model route found for agent '${task.subagent_type}' with role '${role}' and complexity '${complexity}'`,
  );
}

/**
 * Select the best available model for a given role and/or task.
 *
 * Selection criteria (in order):
 * 1. Primary provider is currently healthy (not in any penalty state)
 * 2. Billing mode preference: free > subscription > quota > paid_api
 * 3. Capability tier match if requested
 */
export function selectBestModelForRoleAndTask(
  modelRegistryEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
  role: string | null,
  task: string | null,
  capabilityTier: string | null,
): ModelRegistryEntry | null {
  const candidates = modelRegistryEntries.filter((entry) => {
    if (!entry.enabled) return false;

    if (role && !entry.default_roles.includes(role)) return false;

    if (task) {
      // Substring direction: the task is the (usually long) free-text
      // description from the caller — `task.description ?? task.prompt`
      // in `recommendTaskModelRoute`, often tens to hundreds of words.
      // `best_for` entries and `default_roles` are short canonical
      // labels ("coding", "architect", "long_context"). The old check
      // `bf.toLowerCase().includes(lowerTask)` asked "does the short
      // label contain the entire prompt" — virtually never true on real
      // traffic — so the `best` branch silently filtered out every
      // candidate on every non-toy prompt and control always fell
      // through to `recommendTaskModelRoute`'s last-resort scan,
      // bypassing tier + billing preference ranking. Reverse the
      // direction: ask whether the task mentions the label.
      const lowerTask = task.toLowerCase();
      const matchesTask = entry.best_for.some((bf) =>
        lowerTask.includes(bf.toLowerCase()),
      ) || entry.default_roles.some((r) => lowerTask.includes(r.toLowerCase()));
      if (!matchesTask) return false;
    }

    if (capabilityTier && entry.capability_tier !== capabilityTier) return false;

    return true;
  });

  if (candidates.length === 0) return null;

  // Sort: healthy primary provider first, then billing preference, then capability tier.
  const tierOrder = ["frontier", "strong", "standard", "fast", "tiny"] as const;

  candidates.sort((a, b) => {
    // Prefer higher capability tier first
    const aTierIdx = tierOrder.indexOf(a.capability_tier as typeof tierOrder[number]);
    const bTierIdx = tierOrder.indexOf(b.capability_tier as typeof tierOrder[number]);
    if (aTierIdx !== bTierIdx) return aTierIdx - bTierIdx;

    // Rank by healthy visible routes first (descending — more live
    // fallback breadth wins). When healthy counts tie, break the tie by
    // preferring FEWER unhealthy routes (the "cleaner candidate" signal):
    // a candidate with `1 healthy / 0 dead` should beat `1 healthy / 1
    // dead` because the dead sibling is known friction. See M40/M41
    // Completion Notes and `summarizeVisibleRouteHealth`.
    const aHealth = summarizeVisibleRouteHealth(a, providerHealthMap, modelRouteHealthMap, now);
    const bHealth = summarizeVisibleRouteHealth(b, providerHealthMap, modelRouteHealthMap, now);

    if (aHealth.healthy !== bHealth.healthy) return bHealth.healthy - aHealth.healthy;
    if (aHealth.unhealthy !== bHealth.unhealthy) return aHealth.unhealthy - bHealth.unhealthy;

    // Then prefer billing mode
    const aBillingIdx = BILLING_MODE_PREFERENCE_ORDER.indexOf(a.billing_mode as typeof BILLING_MODE_PREFERENCE_ORDER[number]);
    const bBillingIdx = BILLING_MODE_PREFERENCE_ORDER.indexOf(b.billing_mode as typeof BILLING_MODE_PREFERENCE_ORDER[number]);
    if (aBillingIdx !== bBillingIdx) return aBillingIdx - bBillingIdx;

    return 0;
  });

  return candidates[0] ?? null;
}

async function listCuratedModels(
  options: {
    freeOnly: boolean;
    role: string | null;
    provider: string | null;
  },
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
): Promise<string> {
  const now = Date.now();
  const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
  const filteredEntries = filterModelRegistryEntries(modelRegistry.models, {
    freeOnly: options.freeOnly,
    roleFilter: options.role,
    providerFilter: options.provider,
    enabledOnly: false,
  });

  return JSON.stringify(
    {
      count: filteredEntries.length,
      models: filteredEntries.map((entry) => {
        const payload = buildModelRegistryPayload(entry);
        // Report health of the first VISIBLE route AND factor in route-level
        // health — a route with model_not_found or route-level quota is
        // dead even when its provider is overall healthy (see M29).
        const healthReport = computeRegistryEntryHealthReport(
          entry,
          providerHealthMap,
          modelRouteHealthMap,
          now,
        );
        return {
          ...payload,
          providerHealth: healthReport,
        };
      }),
    },
    null,
    2,
  );
}

// Exported functions for testing and external use
export { inferTaskComplexity, recommendTaskModelRoute, initializeProviderHealthState };

export const ModelRegistryPlugin: Plugin = async () => {
  const { providerHealthMap, modelRouteHealthMap } = await loadPersistedProviderHealth();
  const sessionActiveProviderMap = new Map<string, string>();
  const sessionActiveModelMap = new Map<string, { id: string; providerID: string }>();
  const sessionStartTimeMap = new Map<string, number>();

  // Re-exposed from module scope so the plugin-closure code paths keep
  // their existing references. Pure helpers outside the closure
  // (e.g. `evaluateSessionHangForTimeoutPenalty`) reference the
  // module-scope constants directly.
  const QUOTA_BACKOFF_DURATION_MS = ROUTE_QUOTA_BACKOFF_DURATION_MS;
  const KEY_DEAD_DURATION_MS = PROVIDER_KEY_DEAD_DURATION_MS;
  const NO_CREDIT_DURATION_MS = PROVIDER_NO_CREDIT_DURATION_MS;

  function recordProviderHealth(
    providerID: string,
    state: ProviderHealthState,
    durationMs: number,
  ): void {
    const existing = providerHealthMap.get(providerID);
    const newUntil = Date.now() + durationMs;
    providerHealthMap.set(
      providerID,
      computeProviderHealthUpdate(existing, state, newUntil),
    );
    void persistProviderHealth(providerHealthMap, modelRouteHealthMap);
  }

  return {
    tool: {
      list_curated_models: tool({
        description: "List curated routing models from aicoder-opencode models.jsonc. Includes current provider health status.",
        args: {
          freeOnly: tool.schema.boolean().default(false),
          role: tool.schema.string().nullable().default(null),
          provider: tool.schema.string().nullable().default(null),
        },
        async execute(args) {
          return listCuratedModels(args, providerHealthMap, modelRouteHealthMap);
        },
      }),

      select_models_for_role: tool({
        description: "List curated routing models recommended for a role. Annotates blocked providers with their health state.",
        args: {
          role: tool.schema.string(),
          freeOnly: tool.schema.boolean().default(false),
          provider: tool.schema.string().nullable().default(null),
        },
        async execute(args) {
          return listCuratedModels(
            { freeOnly: args.freeOnly, role: args.role, provider: args.provider },
            providerHealthMap,
            modelRouteHealthMap,
          );
        },
      }),

      recommend_model_for_role: tool({
        description: [
          "Return the single best currently-available model for a role and/or task.",
          "Filters out providers in quota backoff, with dead keys, or with no credit.",
          "Prefers healthy free/subscription providers over penalized paid ones.",
          "Use this instead of select_models_for_role when you need one concrete recommendation.",
        ].join(" "),
        args: {
          role: tool.schema.string().nullable().default(null).describe(
            "Agent role, e.g. 'architect', 'coder', 'fixer', 'implementation_worker', 'deep_reviewer'",
          ),
          task: tool.schema.string().nullable().default(null).describe(
            "Task description, e.g. 'coding', 'debugging', 'architecture', 'review', 'maintenance'. Matched against best_for field.",
          ),
          capabilityTier: tool.schema.string().nullable().default(null).describe(
            "Required capability tier: 'frontier', 'strong', 'standard', 'fast', 'tiny'",
          ),
        },
        async execute(args) {
          const now = Date.now();
          const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);

          // Expire stale entries.
          expireHealthMaps(providerHealthMap, modelRouteHealthMap, now);

          const best = selectBestModelForRoleAndTask(
            modelRegistry.models,
            providerHealthMap,
            modelRouteHealthMap,
            now,
            args.role,
            args.task,
            args.capabilityTier,
          );

          if (!best) {
            return JSON.stringify({
              recommendation: null,
              reason: "No model found matching role/task/tier filters",
              providerHealthSummary: Object.fromEntries(
                Array.from(providerHealthMap.entries()).map(([id, h]) => [
                  id,
                  { state: h.state, until: new Date(h.until).toISOString() },
                ]),
              ),
            }, null, 2);
          }

          const visibleRoutes = filterVisibleProviderRoutes(best.provider_order);
          const primaryRoute = visibleRoutes[0] ?? null;
          const isRouteHealthy = (route: { provider: string; model: string }): boolean => {
            if (!isProviderHealthy(providerHealthMap, route.provider, now)) return false;
            const routeHealth = modelRouteHealthMap.get(composeRouteKey(route));
            if (routeHealth && routeHealth.until > now) return false;
            return true;
          };
          const primaryHealthy = primaryRoute ? isRouteHealthy(primaryRoute) : false;

          return JSON.stringify({
            recommendation: {
              modelID: best.id,
              // route.model fields in provider_order are already the
              // composite "provider/model-id" form per registry convention.
              primaryRoute: primaryRoute ? primaryRoute.model : null,
              capabilityTier: best.capability_tier,
              billingMode: best.billing_mode,
              roles: best.default_roles,
              bestFor: best.best_for,
              primaryProviderHealthy: primaryHealthy,
            },
            alternativeRoutes: visibleRoutes.slice(1).map((route) => ({
              route: route.model,
              healthy: isRouteHealthy(route),
            })),
          }, null, 2);
        },
      }),

      get_quota_backoff_status: tool({
        description: "Return all LLM providers currently penalized (quota backoff, dead key, no credit) and when they expire.",
        args: {},
        async execute() {
          const now = Date.now();
          const status: Record<string, { state: string; until: string; type: string; retryCount: number } | null> = {};

          // Include provider health
          for (const [providerID, health] of providerHealthMap.entries()) {
            if (health.until <= now) {
              providerHealthMap.delete(providerID);
              continue;
            }
            status[providerID] = {
              state: health.state,
              until: new Date(health.until).toISOString(),
              type: "provider",
              retryCount: health.retryCount,
            };
          }

          // Include model route health
          for (const [routeKey, health] of modelRouteHealthMap.entries()) {
            if (health.until <= now) {
              modelRouteHealthMap.delete(routeKey);
              continue;
            }
            status[routeKey] = {
              state: health.state,
              until: new Date(health.until).toISOString(),
              type: "model_route",
              retryCount: health.retryCount,
            };
          }

          return JSON.stringify(status, null, 2);
        },
      }),
    },

    provider: {
      id: OPENROUTER_PROVIDER_ID,
      async models(provider) {
        try {
          const now = Date.now();
          const health = providerHealthMap.get(OPENROUTER_PROVIDER_ID);
          if (health && health.until > now) {
            return {};
          }

          const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
          const enabledOpenRouterModels = buildEnabledProviderModelSet(
            modelRegistry.models,
            OPENROUTER_PROVIDER_ID,
          );

          return filterProviderModelsByRouteHealth(
            provider.models as Record<string, unknown>,
            enabledOpenRouterModels,
            OPENROUTER_PROVIDER_ID,
            modelRouteHealthMap,
            now,
          ) as typeof provider.models;
        } catch (error) {
          logRegistryLoadError(error);
          return provider.models;
        }
      },
    },

    async event({ event }: { event: Event }) {
      if (event.type === "session.error") {
        const sessionError = event.properties;
        if (!sessionError?.error || sessionError.error.name !== "APIError") {
          return;
        }

        const apiError = sessionError.error;
        const statusCode: number = apiError.data.statusCode ?? 0;
        const message: string = (apiError.data.message ?? "").toLowerCase();

        const sessionID = sessionError.sessionID;
        if (!sessionID) return;

        // Read provider/model BEFORE clearing so we can still classify.
        // The helper removes all three session map entries so long-running
        // plugin processes don't accumulate stale session state forever.
        const providerID = sessionActiveProviderMap.get(sessionID);
        const model = (sessionError as any).model ?? sessionActiveModelMap.get(sessionID);
        clearSessionHangState(
          sessionID,
          sessionStartTimeMap,
          sessionActiveProviderMap,
          sessionActiveModelMap,
        );
        if (!providerID) return;
        const modelID = model?.id;

        // "Model not found" message → model_not_found backoff (1h).
        // Gated on `shouldClassifyAsModelNotFound`: authoritative status
        // codes 401/402/403/429 suppress the keyword match so a dead key
        // or quota-throttled provider isn't misclassified as a per-route
        // missing-model problem. Accepted statuses: 0 (no status), 404
        // (direct providers), 500 (openrouter router synthesis).
        const isModelNotFound =
          modelID !== undefined && shouldClassifyAsModelNotFound(statusCode, message);
        if (isModelNotFound && modelID) {
          const { routeKey, health } = buildRouteHealthEntry(
            providerID,
            modelID,
            "model_not_found",
            QUOTA_BACKOFF_DURATION_MS,
            modelRouteHealthMap.get(
              composeRouteKey({ provider: providerID, model: modelID }),
            ),
            Date.now(),
          );
          modelRouteHealthMap.set(routeKey, health);
          void persistProviderHealth(providerHealthMap, modelRouteHealthMap);
          return;
        }

        // Authoritative-priority classification: status codes win over
        // keyword heuristics. See `classifyProviderApiError` docstring for
        // the bugs the previous `||` cascade produced (402+rate-limit and
        // 401+rate-limit both misclassified as quota, dead keys retried
        // every hour forever).
        const errorClass = classifyProviderApiError(statusCode, message);
        if (errorClass === "quota") {
          recordProviderHealth(providerID, "quota", QUOTA_BACKOFF_DURATION_MS);
        } else if (errorClass === "no_credit") {
          recordProviderHealth(providerID, "no_credit", NO_CREDIT_DURATION_MS);
        } else if (errorClass === "key_dead") {
          recordProviderHealth(providerID, "key_dead", KEY_DEAD_DURATION_MS);
        }
        // "unclassified" → no penalty. Transient upstream errors must not
        // quarantine healthy providers.
        return;
      }

      if ((event as any).type === "assistant.message.completed") {
        const props = (event as any).properties as any;
        const sessionID = props.sessionID;
        if (!sessionID) return;

        const tokens = props.tokens;
        if (!tokens) return;

        // Deliberate: do NOT classify based on wall-clock duration here.
        // A completed turn is by definition not hung — deep reasoning turns
        // (kimi-k2-thinking, minimax-m2.7, cogito-2.1 with 200+ tool calls)
        // routinely exceed any ambient timeout but succeed normally. The
        // setTimeout-based hang detector in chat.params is the only valid
        // "still running after N seconds" signal; once completion fires we
        // clear that session's start-time so the late-firing setTimeout
        // becomes a no-op.
        // Read provider/model BEFORE clearing so the zero-token quota
        // classification below still has context. Clearing removes all
        // three session maps so they don't grow unbounded.
        const providerID = sessionActiveProviderMap.get(sessionID);
        const model = sessionActiveModelMap.get(sessionID);
        clearSessionHangState(
          sessionID,
          sessionStartTimeMap,
          sessionActiveProviderMap,
          sessionActiveModelMap,
        );

        // Zero tokens on both input and output indicates quota exhaustion
        if (tokens.input === 0 && tokens.output === 0) {
          if (!providerID || !model) return;

          const { routeKey, health } = buildRouteHealthEntry(
            providerID,
            model.id,
            "quota",
            QUOTA_BACKOFF_DURATION_MS,
            modelRouteHealthMap.get(
              composeRouteKey({ provider: providerID, model: model.id }),
            ),
            Date.now(),
          );
          modelRouteHealthMap.set(routeKey, health);
          void persistProviderHealth(providerHealthMap, modelRouteHealthMap);
        }
        return;
      }
    },

    async "chat.params"(input, output) {
      try {
        sessionActiveProviderMap.set(input.sessionID, input.provider.info.id);
        sessionActiveModelMap.set(input.sessionID, {
          id: input.model.id,
          providerID: input.model.providerID,
        });
        sessionStartTimeMap.set(input.sessionID, Date.now());

        const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);
        const modelRegistryEntry = findRegistryEntryByModel(modelRegistry.models, {
          id: input.model.id,
          providerID: input.model.providerID,
        });

        if (modelRegistryEntry) {
          output.temperature =
            CAPABILITY_TIER_TO_TEMPERATURE[modelRegistryEntry.capability_tier];
        }

        // Schedule a timeout check that runs after the timeout period
        const timeoutMs = parseInt(process.env.AICODER_ROUTE_HANG_TIMEOUT_MS ?? "900000", 10);

        // For testing purposes with very short timeouts, mark as timeout immediately
        if (timeoutMs < 1000) {
          const providerID = input.provider.info.id;
          const model = input.model;
          if (providerID && model) {
            const { routeKey, health } = buildRouteHealthEntry(
              providerID,
              model.id,
              "timeout",
              QUOTA_BACKOFF_DURATION_MS,
              modelRouteHealthMap.get(
                composeRouteKey({ provider: providerID, model: model.id }),
              ),
              Date.now(),
            );
            modelRouteHealthMap.set(routeKey, health);
            void persistProviderHealth(providerHealthMap, modelRouteHealthMap);
          }
        } else {
          // Capture only primitive `sessionID` plus the outer Map refs so
          // the closure does NOT retain a reference to the full `input`
          // object (prompt body, tool list, message history). `unref()`
          // below is orthogonal: it keeps the timer from blocking
          // process exit but does not break closure retention, so the
          // narrow-capture pattern is what actually bounds memory here.
          // See `evaluateSessionHangForTimeoutPenalty` docstring for the
          // full rationale and semantics.
          const capturedSessionID = input.sessionID;
          const capturedTimeoutMs = timeoutMs;
          const hangTimer = setTimeout(() => {
            // `finalizeHungSessionState` (not the bare `evaluate…` query)
            // so the three per-session maps are also evicted when a
            // penalty is recorded. Silent-death sessions (network drop,
            // client kill, parent crash) never fire session.error or
            // assistant.message.completed, so this hang-timer firing is
            // the ONLY cleanup opportunity for their session tuples.
            const result = finalizeHungSessionState(
              capturedSessionID,
              sessionStartTimeMap,
              sessionActiveProviderMap,
              sessionActiveModelMap,
              modelRouteHealthMap,
              capturedTimeoutMs,
              Date.now(),
            );
            if (!result) return;
            modelRouteHealthMap.set(result.routeKey, result.health);
            void persistProviderHealth(providerHealthMap, modelRouteHealthMap);
          }, timeoutMs + 100); // Check slightly after the timeout threshold
          // Do not keep the Node event loop alive waiting on a hang timer —
          // the timer is best-effort health telemetry, not critical work.
          hangTimer.unref?.();
        }
      } catch {
        return;
      }
    },

    async "experimental.chat.system.transform"(input, output) {
      try {
        const now = Date.now();
        const modelRegistry = await loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY);

        // Expire stale health entries in BOTH maps. The transform hook
        // runs on every message, so this keeps memory and the persisted
        // providerHealth.json file bounded. Previously only the provider
        // map was expired; route-health entries accumulated forever.
        expireHealthMaps(providerHealthMap, modelRouteHealthMap, now);

        const modelRegistryEntry = findRegistryEntryByModel(modelRegistry.models, {
          id: input.model.id,
          providerID: input.model.providerID,
        });

        if (modelRegistryEntry) {
          output.system.push(buildRoutingContextSystemPrompt(modelRegistryEntry));
        }

        // Only inject health/available-models sections when there are active
        // penalties. Route-level penalties count too — previously this guard
        // was `providerHealthMap.size === 0` which skipped the entire block
        // whenever only `modelRouteHealthMap` had entries, silently hiding
        // route-specific failures (model_not_found, route-level quota from
        // zero-token completion, route-level timeout from hang detector).
        if (providerHealthMap.size === 0 && modelRouteHealthMap.size === 0) {
          return;
        }

        const providerHealthPrompt = buildProviderHealthSystemPrompt(
          modelRegistry.models,
          providerHealthMap,
          modelRouteHealthMap,
          now,
        );
        if (providerHealthPrompt) {
          output.system.push(providerHealthPrompt);
        }

        const availableModelsPrompt = buildAvailableModelsSystemPrompt(
          modelRegistry.models,
          providerHealthMap,
          modelRouteHealthMap,
          now,
        );
        if (availableModelsPrompt) {
          output.system.push(availableModelsPrompt);
        }
      } catch {
        return;
      }
    },
  };
};
