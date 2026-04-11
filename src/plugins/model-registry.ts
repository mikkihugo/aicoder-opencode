import type { Event } from "@opencode-ai/sdk";
import { type Plugin, tool } from "@opencode-ai/plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";

import {
  buildModelRegistryPayload,
  type CapabilityTier,
  type ModelRegistry,
  type ModelRegistryEntry,
  type ProviderRoute,
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
const MAX_AVAILABLE_MODELS_ROLES_RENDERED = 8;
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
/**
 * Regex patterns for proprietary model families that must never be used
 * as a fallback route, even if they show up inside a permitted provider's
 * `provider.models` catalog (e.g. an aggregator wrapping OpenAI).
 *
 * Why regex instead of the old bare-substring list `["longcat", "claude",
 * "gpt", "grok"]`: `"gpt".includes(modelID)` over-matches `gpt-oss:120b`
 * and `gpt-oss:20b`, which are legitimate FREE open-weights models hosted
 * on ollama-cloud and explicitly recommended in the user's model catalog
 * for A/B cross-checks. The substring check silently excluded them from
 * every fallback cascade, collapsing A/B diversity to whatever other
 * ollama-cloud models were healthy and quietly removing a lineage the
 * catalog explicitly asks for. The same shape would regress again the
 * moment any other `gpt-*` open-weights model (gpt-j, gpt-neo, gpt-oss
 * successors) appeared in `models.jsonc`.
 *
 * The distinguishing feature of proprietary OpenAI models is the
 * numbered version suffix (`gpt-4`, `gpt-5`, `gpt-5.3-codex-spark`,
 * `chatgpt-4o`) — open-weights releases use word suffixes (`gpt-oss`,
 * `gpt-j`, `gpt-neox`). Requiring a digit after the optional hyphen
 * keeps the proprietary family blocked and the open-weights family
 * reachable. Mirror the shape for `grok` (xAI's proprietary brand
 * always uses numbered versions). `claude` and `longcat` are
 * single-brand names with no ambiguity — they stay as plain anchored
 * matches.
 */
const FALLBACK_BLOCKED_MODEL_PATTERNS: readonly RegExp[] = [
  /longcat/i,
  /claude/i,
  /\bgpt-?\d/i,
  /\bchatgpt/i,
  /\bgrok-?\d/i,
];

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

export type ProviderHealth = {
  state: ProviderHealthState;
  until: number;
  retryCount: number;
};

export type ModelRouteHealth = {
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

export type PersistedHealthEntry = Omit<ProviderHealth, 'until'> & { until: number | "never" };

type PersistedHealthMap = Record<string, PersistedHealthEntry>;

/**
 * Convert an in-memory health entry to its on-disk serialized form.
 *
 * SSoT for the two-site spread + infinity-to-"never" transform inside
 * `persistProviderHealth`. The function used to inline this shape in
 * two places: once for `providerHealthMap` entries (flattened via
 * `Object.fromEntries`) and once for `modelRouteHealthMap` entries
 * (added via a for-loop). The two blocks converged on the same output
 * shape by copy-paste convention, not by a named boundary — a future
 * edit that grew the persisted shape (e.g. adding a `reason` telemetry
 * field) would have to propagate the change to both blocks by hand,
 * and forgetting one silently produces asymmetric JSON where route
 * entries carry the new field and provider entries do not (or vice
 * versa). The asymmetry would not throw at persist time because both
 * shapes are still valid `PersistedHealthEntry` values — it would
 * only surface as missing fields on one half of the health state
 * after a plugin restart, which is the exact class of
 * impossible-to-reproduce-from-a-unit-test bug M68 / M73 closed at
 * the record layer.
 *
 * The helper accepts the `ProviderHealth | ModelRouteHealth` union
 * because both types are structurally identical today (`state`,
 * `until`, `retryCount`) — routing through a single serializer makes
 * that identity explicit and pins the contract at the compiler
 * level. If the two types ever diverge, the helper's parameter shape
 * will have to be updated in one place rather than two.
 *
 * The `Number.POSITIVE_INFINITY → "never"` conversion is the one
 * non-spread part of the transform: `key_missing` entries are stored
 * in-memory with `until = Number.POSITIVE_INFINITY` (so the expiry
 * check `until <= now` is always false and the sentinel never
 * expires), but `JSON.stringify(Infinity)` emits `null`, which
 * `parsePersistedHealthEntry` would reject as a missing field. The
 * `"never"` string is the stable on-disk form, hydrated back to
 * `Number.POSITIVE_INFINITY` on load.
 *
 * Args:
 *   health: In-memory health entry — either provider-scope or
 *     route-scope.
 *
 * Returns:
 *   The `PersistedHealthEntry` shape ready for `JSON.stringify`.
 */
/**
 * Render a `ProviderHealth` / `ModelRouteHealth` entry into the
 * on-disk `PersistedHealthEntry` shape with the `Number.POSITIVE_INFINITY`
 * `until` sentinel replaced by the string `"never"`.
 *
 * This is the inverse of `parsePersistedHealthEntry` (M108) — the two
 * functions are a round-trip pair, used by `persistProviderHealth`
 * (writer) and `loadPersistedProviderHealth` (reader) respectively to
 * serialize and deserialize the flat JSON health map shared by the
 * provider-level and route-level in-memory maps. The `"never"` sentinel
 * exists because `JSON.stringify(Number.POSITIVE_INFINITY) === "null"`
 * — i.e. `JSON.stringify` silently lowers infinity to `null`, and
 * `parsePersistedHealthEntry` then rejects the entry as
 * missing-field corrupt on reload, which would silently drop every
 * `key_missing` penalty across a plugin restart. The `"never"` string
 * is chosen because it is a human-readable breadcrumb that survives
 * `JSON.stringify` / `JSON.parse` unchanged and is recognized by the
 * load path as the re-hydration trigger for `Number.POSITIVE_INFINITY`.
 *
 * The spread form `{...health, until: ...}` is load-bearing: it
 * auto-propagates any NEW fields that future `ProviderHealth` /
 * `ModelRouteHealth` schemas grow (for example a `lastError` string or
 * a `firstObserved` timestamp) into the persisted form with zero
 * changes here, so the serializer and `parsePersistedHealthEntry` stay
 * in sync without having to list fields in two places. A refactor to
 * explicit field listing (`{state, until, retryCount}`) for "clarity"
 * would regress forward-compatibility silently.
 *
 * ## Drift surfaces (M111 PDD)
 *
 * Pre-existing pins (M81) cover three return-value facts: infinity →
 * `"never"`, finite numbers pass through, `state` and `retryCount`
 * survive the spread. They do NOT cover:
 *
 * 1. **Return value is a FRESH object, not the input by reference.**
 *    The `{...health, until: ...}` spread creates a brand-new object.
 *    A plausible "optimization" regression to
 *    `Object.assign(health, { until: "never" })` (or a bare
 *    `health.until = "never"; return health;`) would mutate the
 *    in-memory caller's handle — replacing its `Number.POSITIVE_INFINITY`
 *    with the string `"never"`, turning a valid `ProviderHealth`
 *    object into a type-violating half-serialized form that still
 *    sits in `providerHealthMap`. Every subsequent reader of that
 *    entry (`findLiveProviderPenalty`, `computeRegistryEntryHealthReport`,
 *    `formatHealthExpiry`) would see a string where it expects a
 *    number, and the `until > now` comparison would silently become
 *    `"never" > 123456789` which in JavaScript is `false` — so the
 *    penalty would appear to be expired on the next read, leaking
 *    `key_missing` entries out of the health gate. The pre-existing
 *    M81 pins only inspect the `serialized` return and never re-read
 *    the input, so this regression passes all three of them. Pin:
 *    after the call, the input handle's `until` is still
 *    `Number.POSITIVE_INFINITY` (not mutated), and `serialized !== health`.
 *
 * 2. **Forward-compat: the spread carries unknown/new fields through.**
 *    The function's contract is "replace `until` sentinel, pass
 *    everything else through." This lets future `ProviderHealth` /
 *    `ModelRouteHealth` schemas grow new fields without touching the
 *    serializer. A regression to explicit field listing
 *    (`return { state: health.state, until: ..., retryCount: health.retryCount };`)
 *    would silently drop any new field. M81 pin #3 asserts only the
 *    two canonical fields and would pass the regression because the
 *    canonical fields are still listed. Pin: inject a non-schema
 *    test-only field on the input, assert the serialized output
 *    carries the same field verbatim. Uses `as unknown as` coercion
 *    because TypeScript would reject the non-schema field at the
 *    call site — the test is for the runtime spread, not the static
 *    type.
 *
 * 3. **Strict `===` infinity check — NaN and `-Infinity` are NOT
 *    converted to `"never"`.** The check is `health.until === Number.POSITIVE_INFINITY`
 *    — strictly positive infinity. A plausible "generalization"
 *    refactor to `!Number.isFinite(health.until) ? "never" : ...`
 *    would fold NaN AND `-Infinity` AND `+Infinity` all into the
 *    `"never"` sentinel. That looks defensive but silently corrupts
 *    the load path: NaN and `-Infinity` in the in-memory health map
 *    are not valid states — they should be rejected on reload, not
 *    silently re-hydrated as `key_missing`-equivalent permanent
 *    penalties. `parsePersistedHealthEntry`'s M108 docstring explicitly
 *    says it rejects `NaN` / non-finite / negative `retryCount` via
 *    the `!Number.isFinite` clause; the serializer's strict `===`
 *    check is the intentional symmetric counterpart that keeps the
 *    corrupt signal observable. M81 pin #1 uses `Number.POSITIVE_INFINITY`
 *    exactly and passes under both the strict and the generalized
 *    forms. Pin: NaN input passes through as `NaN` (or equivalent
 *    verification that the result is NOT `"never"`).
 *
 * Args:
 *   health: A runtime `ProviderHealth` or `ModelRouteHealth` entry.
 *     The serializer does not care which — both share the
 *     `{state, until, retryCount}` shape and the `until === POSITIVE_INFINITY`
 *     sentinel convention.
 *
 * Returns:
 *   A fresh `PersistedHealthEntry` object whose `until` is either
 *   the original finite number or the literal string `"never"`. The
 *   caller installs the result directly into the flat JSON map that
 *   `persistProviderHealth` atomically writes to disk.
 */
export function serializeHealthEntryForPersistence(
  health: ProviderHealth | ModelRouteHealth,
): PersistedHealthEntry {
  return {
    ...health,
    until: health.until === Number.POSITIVE_INFINITY ? "never" : health.until,
  };
}

type ModelIdentity = {
  id: string;
  providerID: string;
};

function logRegistryLoadError(error: unknown): void {
  console.error(MODEL_REGISTRY_LOAD_ERROR_MESSAGE, error);
}

/**
 * Surface a hook-level exception before it is swallowed by a `catch`.
 *
 * Motivation — silent-swallow drift: the `chat.params` and
 * `experimental.chat.system.transform` hooks wrap their bodies in
 * `try/catch { return; }` so a throw inside the hook cannot crash the
 * host opencode process. The swallow is the right policy (a plugin
 * must not take down the editor session), but silencing the error
 * entirely removes the ONLY operator signal that the hook stopped
 * working. A real-world manifestation: if `loadModelRegistry` throws
 * because `config/models.jsonc` has a syntax error introduced by a
 * hand edit, both hooks silently return, the plugin stops setting
 * temperatures / injecting system prompts / expiring health maps, and
 * nothing is written to stderr. Operators notice days later when
 * routing quality degrades or the health file grows unbounded. The
 * `provider.models` hook already logs through `logRegistryLoadError`,
 * but that helper's message is registry-load-specific and does not
 * fit the general hook-failure shape.
 *
 * This helper is the SSoT for that class of log: a hook-qualified
 * "[aicoder-opencode plugin] `<hookName>` hook failed — ignoring and
 * continuing: `<error>`" line, written to the injected log function
 * (defaults to `console.error`). The `logFn` injection is what makes
 * the helper pinnable — tests capture the message and error so the
 * helper's output shape is observable without spying on
 * `console.error` globally.
 *
 * Args:
 *   hookName: The opencode hook that threw — used verbatim in the
 *     logged message so operators can grep for "chat.params hook
 *     failed" without knowing the plugin's internals.
 *   error: The caught value. Passed through to `logFn` as-is so
 *     stack traces survive the swallow.
 *   logFn: Injected sink. Defaults to a small wrapper over
 *     `console.error` so production callers stay one-liners.
 */
export function logPluginHookFailure(
  hookName: string,
  error: unknown,
  logFn: (message: string, error: unknown) => void = defaultHookFailureLogSink,
): void {
  logFn(
    `[aicoder-opencode plugin] ${hookName} hook failed — ignoring and continuing:`,
    error,
  );
}

function defaultHookFailureLogSink(message: string, error: unknown): void {
  console.error(message, error);
}

/**
 * Render a health-entry `until` timestamp for logs, system prompts, and tool
 * output without throwing on the `key_missing` sentinel.
 *
 * `key_missing` entries are persisted with `until: "never"` and hydrated to
 * `Number.POSITIVE_INFINITY` by `parsePersistedHealthEntry`. `new Date(Infinity)
 * .toISOString()` throws `RangeError: Invalid Date`, which used to crash the
 * `chat.params` hook, the `get_quota_backoff_status` tool, the
 * `recommend_model_for_role` fallback payload, and
 * `computeRegistryEntryHealthReport`. This helper formats `Infinity` back to
 * the same `"never"` sentinel so the render paths remain closed over the
 * entire `ProviderHealth` domain — no code path can panic on a live
 * key_missing entry.
 *
 * Extracted as a pure helper so the contract can be pinned with unit tests
 * and so every call site shares one source of truth for the sentinel. Before
 * this helper, M58's `ModelRegistryPlugin` wire-up exposed a latent crash
 * because pre-M58 the factory never installed any `key_missing` entries at
 * startup, so the `new Date(Infinity)` branch was unreachable in practice.
 *
 * Args:
 *   until: The `until` timestamp from a `ProviderHealth` or `ModelRouteHealth`
 *     entry — a finite millisecond epoch or `Number.POSITIVE_INFINITY`.
 *
 * Returns:
 *   `"never"` when `until` is infinite, otherwise the ISO-8601 string.
 *
 * ## Drift surfaces (M116 PDD)
 *
 * The pre-M116 docstring names the Infinity → `"never"` round-trip contract
 * but ships zero direct unit pins — `formatHealthExpiry` is only exercised
 * indirectly by two callers inside `buildProviderHealthSummaryForTool` and
 * `buildAgentVisibleBackoffStatus`, both of which assert larger compound
 * payloads. That leaves three independent invariants unpinned:
 *
 * 1. **`!Number.isFinite` rejects NaN AND both infinities — not just
 *    `=== Number.POSITIVE_INFINITY`.** The guard is a finite-check, not an
 *    infinity-equality check, and the distinction matters because
 *    `parsePersistedHealthEntry` hydrates `rawUntil === "never"` to
 *    `Number.POSITIVE_INFINITY` but the same pipeline has nothing that
 *    prevents an in-memory corruption (a stale arithmetic on `until`, a
 *    `Math.min`/`Math.max` that received a non-number, a `Date.parse` that
 *    returned `NaN`) from producing `NaN` in `until`. `new Date(NaN)
 *    .toISOString()` throws `RangeError: Invalid time value` — the exact
 *    crash this helper was extracted to prevent. A plausible refactor that
 *    narrows the guard to `until === Number.POSITIVE_INFINITY` ("I only
 *    want the key_missing sentinel") silently lets `NaN` fall into
 *    `new Date(NaN).toISOString()` and re-introduces the M58 crash. The
 *    pin asserts `formatHealthExpiry(Number.NaN)` returns a string
 *    without throwing; sabotaging the guard fires only this pin because
 *    the ISO-branch and sentinel-string pins both receive inputs that
 *    take the finite branch under the sabotage.
 *
 * 2. **Finite-epoch formatting contract is ISO-8601 via `toISOString()`,
 *    not `toUTCString()` / `toString()`.** The return value is embedded
 *    in log lines, tool JSON payloads (`get_quota_backoff_status`), and
 *    the `buildProviderHealthSummaryForTool` synopsis — all of which
 *    are consumed by downstream parsers (dashboards, jq queries, agent
 *    system prompts) that assume the RFC 3339 / ISO 8601 shape
 *    `YYYY-MM-DDTHH:MM:SS.sssZ`. A refactor that switches to
 *    `toUTCString()` (`"Thu, 01 Jan 1970 00:00:00 GMT"`) or a
 *    locale-sensitive `toLocaleString()` looks cosmetically similar in
 *    a single log line but silently breaks every downstream parse —
 *    worse, it breaks asymmetrically because only finite-until entries
 *    would drift, while `"never"` entries keep rendering unchanged. The
 *    pin asserts the finite-epoch return matches an ISO-8601 regex;
 *    sabotaging `.toISOString()` fires only this pin because the NaN
 *    and Infinity pins both take the `"never"` branch and never reach
 *    the Date formatter.
 *
 * 3. **`"never"` sentinel must round-trip through
 *    `parsePersistedHealthEntry`.** The write side of the persistence
 *    contract is `serializeHealthEntryForPersistence` / this helper
 *    (for Infinity entries), and the read side is
 *    `parsePersistedHealthEntry`'s `rawUntil === "never"` clause. The
 *    exact string literal `"never"` is the ONLY value that crosses that
 *    boundary — a drift to `"forever"`, `"infinity"`, `"∞"`, or an
 *    empty string silently breaks `key_missing` persistence: the next
 *    plugin restart reads the drifted sentinel, fails the `=== "never"`
 *    check, falls into the `typeof rawUntil === "number"` branch which
 *    also fails, and returns `null` → the entry is dropped, the
 *    key_missing penalty evaporates, and the provider is treated as
 *    healthy again even though the env var is still absent. The pin
 *    writes `formatHealthExpiry(Number.POSITIVE_INFINITY)` into a
 *    minimal persisted shape, round-trips it through
 *    `parsePersistedHealthEntry`, and asserts `until ===
 *    Number.POSITIVE_INFINITY`; sabotaging the literal fires only this
 *    pin because the NaN pin asserts "doesn't throw" (a drifted
 *    sentinel is still a non-throwing string) and the finite-epoch
 *    pin never takes the sentinel branch.
 */
export function formatHealthExpiry(until: number): string {
  if (!Number.isFinite(until)) {
    return "never";
  }
  return new Date(until).toISOString();
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
 *
 * ## Drift surfaces (M108 PDD)
 *
 * The eight pre-existing pins cover the happy path, the "never" literal,
 * null entry, unknown state, corrupt-string until, NaN until, past
 * until, and missing retryCount — good breadth, but the three input-
 * validation boundaries below have zero direct coverage and each has a
 * plausible regression:
 *
 * 1. **`until === now` exact boundary — `<= now` not `< now`.** The
 *    expiry check is `if (until <= now) return null;` — an entry whose
 *    until lands on the CURRENT wall-clock ms is treated as already-
 *    expired, not "still live for this tick." This matters because
 *    `loadPersistedProviderHealth` calls this helper with a single
 *    `now` shared across every entry, and on a fast-enough machine a
 *    penalty written in the same ms as the next plugin-boot read-back
 *    would land on the boundary. A drift to `if (until < now)` would
 *    keep the entry alive, re-apply a stale penalty across plugin
 *    restarts whose semantics were "already expired at the time of
 *    persist," and feed that ghost penalty to callers who rely on
 *    `findLive*Penalty`'s `<= now` convention (M103). The existing
 *    "past" pin uses `now - 1000` — strictly less — so both `<` and
 *    `<=` behave identically for it and neither path is actually pinned.
 *
 * 2. **Negative retryCount rejected via `|| retryCount < 0`.** The
 *    retryCount guard is a three-clause disjunction: `typeof !==
 *    "number"`, `!Number.isFinite`, and `< 0`. The missing-retryCount
 *    pin exercises the `typeof` clause (undefined fails the typeof
 *    check). Nothing exercises the sign clause. A negative retryCount
 *    in the on-disk state file — plausibly produced by a hand-edit, a
 *    future refactor that introduces signed delta accounting, or a
 *    corrupted write that flips a sign bit — would be silently
 *    accepted if someone "simplified" the guard to drop the `< 0`
 *    clause as "defensive paranoia." Downstream `retryCount++` logic
 *    in `computeProviderHealthUpdate` and `buildRouteHealthEntry`
 *    assumes non-negative; a negative seed would quietly shift the
 *    entire retry escalation ladder and could make `retryCount > 0`
 *    display checks in `computeRegistryEntryHealthReport` lie about
 *    whether a penalty is "fresh" or "repeated."
 *
 * 3. **Non-finite retryCount rejected via `!Number.isFinite`.** The
 *    second guard clause rejects `Infinity` / `-Infinity` / `NaN` for
 *    retryCount. Pin #8 (missing) fails on `typeof !== "number"` and
 *    never touches this clause. Pin #6 (NaN until) is the UNTIL
 *    finite-check, a completely separate branch — it does not
 *    transitively exercise the retryCount finite-check. A hand-edited
 *    or corrupt persisted file with `retryCount: Infinity` (or the
 *    JSON `"retryCount": null` which V8 coerces to 0 under sloppy
 *    parsers but a strict parser leaves as null → typeof object →
 *    caught by the `typeof` clause; Infinity specifically survives
 *    the typeof check and needs its own guard) would pass a
 *    `typeof === "number"` check, fail only the `Number.isFinite`
 *    clause, and silently propagate Infinity retryCounts if that
 *    clause were ever dropped. `computeProviderHealthUpdate` then
 *    computes `Infinity + 1 === Infinity` and the retry escalation
 *    ladder is broken forever on that entry.
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

      // M83: `classifyPersistedHealthKey` SSoTs the provider-vs-route
      // classification alongside `composeRouteKey`, so a future edit
      // to the composite-key delimiter cannot silently desync the
      // read-side classifier from the write-side key builder. See the
      // helper docstring for the multi-segment-key drift shape.
      if (classifyPersistedHealthKey(key) === "route") {
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
    // M81: route both provider and route serialization through
    // `serializeHealthEntryForPersistence` so the spread +
    // infinity-to-"never" transform lives in exactly one place. Prior
    // to this both blocks copy-pasted the same shape, so a future
    // field added to the persisted form would ship asymmetrically
    // across provider vs route entries if the maintainer updated only
    // one block.
    const obj: PersistedHealthMap = Object.fromEntries(
      Array.from(healthMap.entries()).map(([key, health]) => [
        key,
        serializeHealthEntryForPersistence(health),
      ]),
    );

    if (routeHealthMap) {
      for (const [routeKey, health] of routeHealthMap.entries()) {
        obj[routeKey] = serializeHealthEntryForPersistence(health);
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
 * Three independent drift surfaces in this tiny body that are NOT covered
 * by the pre-existing enabled-gate and route-penalty pins:
 *
 *  1. **Iteration source is `providerModels`, never `enabledRawModelIDs`.**
 *     The loop walks `Object.entries(providerModels)` and uses the enabled
 *     set only as a positive-filter `.has` probe. A refactor that inverts
 *     this — iterating the enabled set and reading `providerModels[id]`
 *     back — silently fabricates entries for enabled-but-absent models.
 *     Opencode's runtime `provider.models` map only lists the raw models
 *     the provider's own discovery call returned; a registry row whose
 *     primary route was DROPPED by the provider (model renamed, retired,
 *     or hidden behind a feature flag) will be present in
 *     `enabledRawModelIDs` but absent from `providerModels`. Iterating
 *     the enabled set writes `filtered[ghostModel] = undefined` and
 *     opencode's downstream router interprets the key as a live model,
 *     dispatches to it, and the provider returns "model not found" — a
 *     penalty cascade fully attributable to the drift. The current
 *     iteration source bounds the output domain to keys opencode
 *     actually expects to route.
 *
 *  2. **Original `modelValue` is passed through byte-identical.** The
 *     assignment is `filtered[modelID] = modelValue`, not `= true`, `=
 *     {}`, or `= { id: modelID }`. Downstream opencode readers consume
 *     `modelValue.id`, `modelValue.label`, provider-specific capability
 *     hints, context-window metadata, and tool-support flags directly
 *     from these objects. Replacing the stored value with a stub or
 *     boolean silently strips all metadata while still presenting the
 *     key as advertised — the router sees the model as available and
 *     dispatches without knowing the context window, tool support, or
 *     pricing band. A refactor that "normalises" the value to a minimal
 *     shape is the exact drift class this pin catches.
 *
 *  3. **`providerModels` is read-only — the helper never mutates its
 *     input.** The `provider.models` hook hands us the opencode-owned
 *     map by reference; the same reference may flow to other hooks in
 *     the same turn or be cached across turns inside opencode. A
 *     refactor that `delete`s excluded keys from `providerModels`
 *     in-place (a tempting micro-optimisation that "avoids building a
 *     new object") would mutate the caller's map, corrupting every
 *     downstream reader. The helper signals non-mutation by building a
 *     fresh `filtered` object and returning that instead — the input
 *     map leaves the function with the exact key set it entered with.
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
    if (findLiveRoutePenalty(modelRouteHealthMap, providerID, modelID, now)) continue;
    filtered[modelID] = modelValue;
  }
  return filtered;
}

/**
 * Build the set of raw (provider-relative) model IDs that an opencode
 * `provider.models` hook should keep visible for one provider, based on
 * the curated registry.
 *
 * This helper is the sole source of truth for three independent drift
 * surfaces that the `provider.models` curation hook relies on. Each
 * surface has a concrete failure mode history, and collapsing them into
 * one named helper is the only way to keep them from drifting apart:
 *
 *  1. **Enabled gate.** A `modelRegistryEntry.enabled === false` row in
 *     `models.jsonc` is the operator-facing "hide this model from the
 *     router" switch. A refactor that drops `if (!entry.enabled)
 *     continue;` resurrects every disabled model at the provider-hook
 *     boundary — the model becomes visible again to the agent / to
 *     opencode's model picker even though the operator explicitly
 *     disabled it. The enabled flag is the only lever an operator has
 *     to temporarily quarantine a flaky model without deleting its
 *     registry row, so breaking it turns the `enabled` field into a
 *     no-op.
 *
 *  2. **Provider filter.** Each entry's `provider_order` array may list
 *     fallback routes through OTHER providers (e.g. a model with a
 *     primary openrouter route and a secondary ollama-cloud route). When
 *     building the visible set for `providerID = "openrouter"`, only
 *     routes whose `providerRoute.provider === providerID` are relevant
 *     — the cross-provider fallback routes belong to the OTHER
 *     provider's visible set, not this one. A refactor that drops
 *     `if (providerRoute.provider !== providerID) continue;` silently
 *     leaks cross-provider model IDs into the visible set; the
 *     `provider.models` hook for openrouter then claims visibility over
 *     ollama-cloud/* models, the Set.has check at the call site passes
 *     against the wrong key space, and filtering produces a nonsense
 *     result.
 *
 *  3. **Prefix-strip normalization.** Opencode's `provider.models` map
 *     is keyed by the provider-RELATIVE raw model id (e.g.
 *     `"xiaomi/mimo-v2-pro"` for the openrouter provider), but
 *     `provider_order[].model` in `models.jsonc` is the COMPOSITE form
 *     (`"openrouter/xiaomi/mimo-v2-pro"`) by registry convention. The
 *     filter in the `provider.models` hook compares `Set.has(modelID)`
 *     against those RAW keys, so this helper must strip the
 *     `${providerID}/` prefix before adding to the set. A refactor that
 *     drops the `.startsWith(providerPrefix) ? .slice(prefix.length) :
 *     raw` normalization silently produces a set keyed on composite
 *     strings; the provider-hook's Set.has check then never matches any
 *     opencode key and the curation hook returns `{}` — zero models
 *     visible to the router, which looks like a full provider outage
 *     even though the provider is healthy.
 *
 * The routes that do NOT start with the expected prefix (a small
 * handful of provider-specific unprefixed registry entries like the
 * `LongCat-Flash-*` family, where the composite form matches
 * LongCat's own raw key space) are added verbatim — the ternary
 * preserves unprefixed entries untouched so the asymmetry
 * `findRegistryEntryByModel` docstring calls out is handled at both
 * the read and write paths.
 *
 * Args:
 *   modelRegistryEntries: All curated registry rows. Walked once.
 *   providerID: The opencode provider ID whose visible set we are
 *     building (e.g. `"openrouter"`, `"ollama-cloud"`).
 *
 * Returns:
 *   A new `Set<string>` of raw (provider-relative) model IDs the
 *   `provider.models` hook should retain for this provider.
 */
export function buildEnabledProviderModelSet(
  modelRegistryEntries: ModelRegistryEntry[],
  providerID: string,
): Set<string> {
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

/**
 * Resolve the curated registry entry that owns the runtime `{id, providerID}`
 * model tuple — the single readers-side funnel for every code path that
 * needs to go from "what is opencode dispatching right now" to "which
 * `ModelRegistryEntry` governs this dispatch".
 *
 * ## Drift surfaces (M122 PDD)
 *
 * The body is five statements but each of the three load-bearing lines
 * carries one orthogonal invariant, and the five pre-existing M47
 * cartesian pins exercise every (prefixed/unprefixed) × (runtime/registry)
 * cell of the four-way matrix without ever isolating WHICH side of the
 * `composeRouteKey` pair broke on a single-line sabotage. Dropping
 * `composeRouteKey` on the runtime side fires two M47 pins simultaneously
 * (the two raw-runtime cells); dropping it on the registry side fires two
 * DIFFERENT M47 pins (the two unprefixed-registry cells); replacing
 * `.find(.some(...))` with `[0]` fires only the negative-match pin. Each
 * sabotage leaves failure messages unable to localise which surface
 * actually broke — the pin signatures are correlated with the cartesian
 * axis, not with the code axis. M122 adds three asymmetric pins each
 * designed to fire on exactly one of the three orthogonal surfaces.
 *
 *   (1) **Runtime-side `composeRouteKey` normalization.** The helper
 *       wraps the opencode runtime tuple `{providerID, id}` into a
 *       canonical composite key via
 *       `composeRouteKey({provider: model.providerID, model: model.id})`.
 *       This is load-bearing for the "raw runtime id + composite
 *       registry entry" cell: when opencode hands the plugin `{id:
 *       "glm-5", providerID: "ollama-cloud"}` (the common case — the
 *       runtime short id is NOT provider-prefixed) and the registry row
 *       stores `"ollama-cloud/glm-5"` (the common authored form),
 *       dropping the wrap leaves the raw short id compared against the
 *       normalized composite and the entry is silently dropped. The
 *       downstream consequences are wide: the capability-tier
 *       temperature override, the `## Active model routing context`
 *       system-prompt injection, every fallback ranking, and every
 *       health-surface prompt all read through this funnel. The new
 *       pin constructs the exact common case and asserts the match
 *       exists — idempotent on the already-composite-runtime cell, so
 *       it fires alone among the M122 pins when the runtime wrap is
 *       dropped.
 *
 *   (2) **Registry-side `composeRouteKey` normalization.** The helper
 *       also wraps each `providerRoute` from `entry.provider_order`
 *       through `composeRouteKey(providerRoute)` inside the `.some`
 *       predicate. This is load-bearing for the "already-composite
 *       runtime id + unprefixed registry entry" cell — the shape that
 *       every `longcat/LongCat-Flash-*` registry row lives in (the
 *       registry authors them without the `longcat/` prefix because
 *       the longcat provider takes bare model ids). A sabotage that
 *       drops the registry-side wrap compares raw `"LongCat-Flash-Chat"`
 *       against the normalized runtime `"longcat/LongCat-Flash-Chat"`
 *       and the entry silently drops — exactly the M47 headline
 *       regression that motivated putting `composeRouteKey` on BOTH
 *       sides of the comparison. The new pin isolates this surface by
 *       constructing an already-composite runtime id paired with an
 *       unprefixed registry entry — idempotent on the runtime-wrap
 *       axis, so it fires alone on a registry-wrap drop.
 *
 *   (3) **`.find(entry => entry.provider_order.some(...))` iteration
 *       structure.** The outer walk is `.find` (first-match,
 *       short-circuit, returns the entry), the inner walk is `.some`
 *       (first-match, boolean, feeds the outer predicate). A plausible
 *       "simplification" refactor to `modelRegistryEntries[0]` (on the
 *       theory that "the caller has already pre-filtered to a single
 *       candidate") silently ignores the provider_order match entirely
 *       and returns the first entry regardless of whether its routes
 *       actually contain the requested model. This kind of drift is
 *       invisible when the registry has one entry (the M47 cartesian
 *       pins all use single-entry fixtures), which is why the new pin
 *       uses TWO entries where the SECOND entry is the correct match
 *       — an `[0]`-style drift returns the wrong entry and the pin
 *       fires. Composite-on-both-sides inputs so the two
 *       `composeRouteKey` surfaces are idempotent and cannot mask the
 *       iteration-structure signal.
 *
 * ## Body contract
 *
 * Bitwise-identical to pre-M122. Two `composeRouteKey` calls (one
 * runtime-side, one registry-side inside the `.some`), one `.find(.some)`
 * nested iteration. Asymmetric pins at
 * `findRegistryEntryByModel_whenRuntimeIdIsRawCompositeRegistry_requiresRuntimeNormalization`,
 * `..._whenRuntimeCompositeUnprefixedRegistry_requiresRegistryNormalization`,
 * and `..._whenTwoEntriesAndSecondContainsMatch_returnsSecondViaFindSemantics`.
 *
 * Args:
 *   modelRegistryEntries: The curated registry rows, as loaded from
 *     `models.jsonc`. Walked once via `.find` — caller supplies input
 *     order (author order from the registry file).
 *   model: Opencode runtime `{id, providerID}` tuple, where `id` may be
 *     raw-short OR already-composite and `providerID` is the canonical
 *     opencode provider slug.
 *
 * Returns:
 *   The first matching `ModelRegistryEntry` whose `provider_order`
 *   contains a route whose `composeRouteKey`-normalized form equals the
 *   runtime tuple's normalized form, or `undefined` when no entry
 *   matches.
 */
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

/**
 * Load the curated registry and resolve the entry matching an opencode
 * `input.model` tuple in one call.
 *
 * ## Drift shape this closes
 *
 * Both `chat.params` and `experimental.chat.system.transform` perform the
 * same two-step ritual at the top of their body: `await
 * loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY)`, then
 * `findRegistryEntryByModel(registry.models, { id: input.model.id,
 * providerID: input.model.providerID })`. The two sites are textually
 * identical except for the surrounding hook body, and the object
 * literal that narrows `input.model` to the `ModelIdentity` shape is a
 * silent drift surface: if a future opencode release grows `input.model`
 * new fields AND one hook is refactored to spread `{...input.model}`
 * verbatim while the other keeps the explicit narrow, the two sites
 * begin comparing different subsets of the runtime model against the
 * registry. Worse, if one site drops the `providerID` field during a
 * refactor the lookup collapses to matching-by-id-only, which silently
 * "succeeds" for any curated entry whose first provider route happens
 * to share the same model id — a false-positive match that would
 * inject the wrong temperature override or the wrong routing-context
 * system prompt without any observable error.
 *
 * Centralising the load + narrow + lookup in one helper makes the
 * `{ id, providerID }` narrowing a property of the helper instead of a
 * property the two call sites must preserve in lock-step by hand.
 *
 * Both call sites still need the loaded `registry` for other work
 * (`transform` uses `registry.models` three more times to build the
 * provider-health and available-models prompts), so the helper returns
 * the `{ registry, entry }` tuple rather than just the entry.
 *
 * Args:
 *   controlPlaneRootDirectory: Absolute path to the control-plane root,
 *     forwarded verbatim to the loader. Tests inject a throwing or
 *     fixture-returning loader via `loadFn`.
 *   inputModel: The runtime model tuple. Only `id` and `providerID`
 *     are read — any extra fields the runtime may grow are ignored.
 *   loadFn: Injected registry loader. Defaults to `loadModelRegistry`
 *     so production call sites do not need to pass it.
 *
 * Returns:
 *   `{ registry, entry }` where `entry` is `undefined` when the
 *   runtime model does not resolve to any curated registry row.
 */
export async function loadRegistryAndLookupEntryForInputModel(
  controlPlaneRootDirectory: string,
  inputModel: { id: string; providerID: string },
  loadFn: (root: string) => Promise<ModelRegistry> = loadModelRegistry,
): Promise<{ registry: ModelRegistry; entry: ModelRegistryEntry | undefined }> {
  const registry = await loadFn(controlPlaneRootDirectory);
  const entry = findRegistryEntryByModel(registry.models, {
    id: inputModel.id,
    providerID: inputModel.providerID,
  });
  return { registry, entry };
}

/**
 * Render the "Active model routing context" system prompt section that
 * is injected into the chat params when the active model is a curated
 * registry entry. The agent reads this section to know which model it
 * is currently routed to, what that model is best/not-for, and what
 * the cost + billing picture looks like — all fields the operator
 * curated in `models.jsonc` rather than anything opencode computes.
 *
 * This renderer is the sole source of truth for three independent
 * drift surfaces. Each surface has a concrete failure mode history at
 * parallel rendering sites elsewhere in this plugin, and collapsing
 * them into one named, documented helper is the only way to keep them
 * from drifting apart:
 *
 *  1. **Header-first invariant.** The section MUST begin with the
 *     canonical `ACTIVE_MODEL_ROUTING_CONTEXT_HEADER` literal
 *     (`"## Active model routing context"`) as its very first line —
 *     opencode's `experimental.chat.system.transform` pipeline
 *     concatenates multiple system prompt sections, and downstream
 *     splitters find this section by header match. A refactor that
 *     drops the header line (e.g. "the Model line is enough context")
 *     silently merges this section into whichever section happened to
 *     render before it, and agent-facing tools that look for the
 *     header to extract the active-model context get nothing back.
 *
 *  2. **Multi-value comma-space separator (`.join(", ")`).** Three
 *     list-valued fields (`default_roles`, `best_for`, `not_for`) all
 *     join their array values with the canonical `", "` separator —
 *     the same separator every other renderer in this plugin uses for
 *     agent-readable lists. A refactor that drops the space (the
 *     "commas are commas, why waste bytes" drift class) silently
 *     produces `"coding,architect"` instead of `"coding, architect"`,
 *     and any downstream parser that splits on `", "` stops seeing
 *     individual values — the whole list collapses into one opaque
 *     string. The three fields are structurally parallel so the drift
 *     surface is global: one sabotage changes all three.
 *
 *  3. **Cost-tier + billing-mode `" | "` fusion.** The final line
 *     fuses two distinct semantic axes (economic classification via
 *     `cost_tier` and billing-relationship classification via
 *     `billing_mode`) onto ONE line with a pipe separator. Keeping
 *     them on one line is deliberate — the agent reads them together
 *     to decide whether to prefer this model for cheap-bulk work vs
 *     paid-deliberation work — but the pipe separator is the only
 *     signal that the two axes are distinct. A refactor that changes
 *     the separator (to `/`, `-`, `,`, or just whitespace) silently
 *     makes the line ambiguous: `"Cost tier: cheap / Billing:
 *     paid_api"` could be read as a cost-tier value of `"cheap /
 *     Billing: paid_api"` by any naive `Cost tier: (\w+)` extractor.
 *
 * ## Drift surfaces (M130 PDD)
 *
 * The prose above describes three CONTENT-level surfaces (header
 * literal, comma-space separator, pipe fusion) — each already has one
 * M97 regression pin. What those pins do NOT cover are three
 * STRUCTURAL surfaces that are equally load-bearing and equally easy
 * to silently regress during a "let me tidy this template" refactor.
 * The M130 pin set closes that gap:
 *
 *  A. **Exact line count == 8.** The rendered string has EXACTLY
 *     eight newline-separated lines: header, Model, Description,
 *     Roles, Best for, Not for, Concurrency limit, Cost tier+Billing.
 *     Adding a new curated field (or quietly dropping one the agent
 *     "doesn't seem to use") changes the count, and downstream
 *     splitters that index by position — `lines[0]` for the header,
 *     `lines[7]` for the cost/billing fusion — silently point at the
 *     wrong content. No existing pin asserts the count: the M97 pins
 *     all test line content by `.includes(...)` or by locating the
 *     header index, which happily passes on a 9-line variant that
 *     inserts a new row anywhere after line 0.
 *
 *  B. **`Model:` line is bound to `.id`, not any other string
 *     field.** The line template is `` `Model: ${entry.id}` `` — NOT
 *     `${entry.description}` or the top `provider_order[0].model`
 *     route or anything else stringy. This matters because the
 *     operator curates stable canonical IDs in `models.jsonc` (e.g.
 *     `glm-5`) and the agent uses the `Model:` line as its
 *     identity-of-record for routing decisions. A copy-paste drift
 *     that swaps `.id` for `.description` (both are strings, both
 *     look plausible in the template, typecheck passes) replaces
 *     `"Model: glm-5"` with a 40-word prose blurb and every agent
 *     self-identifies as its own description. No existing pin
 *     distinguishes `.id` from `.description` because the M97 pin
 *     only asserts the header literal is the first line.
 *
 *  C. **`Concurrency limit:` line is bound to `.concurrency`, not
 *     any other numeric-or-stringified field.** The line template is
 *     `` `Concurrency limit: ${entry.concurrency}` `` — NOT
 *     `${entry.cost_tier}` or any other field that `String(…)` would
 *     happily stringify. The concurrency value gates how many
 *     parallel agent sessions the runtime will dispatch against this
 *     model; a field-binding drift that puts `cost_tier` on this line
 *     produces `"Concurrency limit: cheap"`, which the agent reads as
 *     "unbounded concurrency" (parse-failure → fallback default) and
 *     silently over-dispatches to rate-limited providers. No existing
 *     pin binds a specific non-header line to its specific entry
 *     field: the M97 pins are all separator/format assertions.
 *
 * Asymmetric sabotage model: pin A fires on any line-count delta
 * (insert or delete a template row), pin B fires on any `Model:`
 * field-binding swap, pin C fires on any `Concurrency limit:`
 * field-binding swap. The three sabotages are orthogonal — none of
 * them moves the header off line 0, changes the list separator, or
 * touches the Cost/Billing fusion — so the existing M97 pins remain
 * green on every individual sabotage and each new pin fires alone
 * in its partition.
 *
 * Args:
 *   modelRegistryEntry: The curated registry row for the currently
 *     active model.
 *
 * Returns:
 *   A single multi-line string ready to be pushed into
 *   `output.system` by the `chat.params` hook.
 */
export function buildRoutingContextSystemPrompt(modelRegistryEntry: ModelRegistryEntry): string {
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
 *
 * ## Drift surfaces (M115 PDD)
 *
 * One pre-existing pin (three-assertion, `_whenRegistryEntryIsUnprefixed_
 * producesCompositeKey`) covers three happy branches: unprefixed longcat
 * wraps, already-composite ollama-cloud passes through, multi-segment
 * openrouter aggregator passes through. It doesn't exercise three
 * orthogonal invariants that each correspond to a plausible "defensive
 * simplification" refactor:
 *
 * 1. **Prefix-collision safety: the `startsWith` check uses
 *    `${provider}/` WITH the trailing slash.** Without the trailing
 *    slash, a provider/model pair whose model id *begins with* the
 *    provider name but is NOT actually prefixed by `provider/` would
 *    be misclassified as already-composite and pass through verbatim.
 *    Concrete case: provider `"llama"` with model `"llama3-8b"` —
 *    `"llama3-8b".startsWith("llama")` is `true` but `"llama3-8b"
 *    .startsWith("llama/")` is `false`. The trailing slash forces a
 *    boundary check so only true prefixes short-circuit. A refactor
 *    that "simplified" to `startsWith(provider)` for "fewer allocs"
 *    would turn the `llama`/`llama3-8b` case into a bare-key write
 *    that `classifyPersistedHealthKey` misclassifies as `provider`,
 *    collapsing the route penalty into a provider-wide ban. The
 *    pre-existing pin uses longcat / ollama-cloud / openrouter
 *    combinations where no name-collision exists, so this surface is
 *    unpinned.
 *
 * 2. **Mismatched-prefix composites wrap, not pass through.** The
 *    check is `startsWith(${provider}/)` — not a generic "has any
 *    slash". A model id that happens to be composite but whose prefix
 *    is a DIFFERENT provider (e.g. provider `"cloudflare-ai-gateway"`
 *    with model `"openrouter/xiaomi/mimo"`, which arises when the
 *    registry threads an aggregator-resolved id through a
 *    cloudflare-fronted gateway) must still be wrapped to the
 *    CURRENT provider's namespace, producing
 *    `"cloudflare-ai-gateway/openrouter/xiaomi/mimo"` — otherwise the
 *    penalty recorded under the gateway's provider id would land on
 *    the wrong composite key and be invisible to the gateway's health
 *    readers. A refactor to `.includes("/")` or `.split("/").length
 *    >= 2` as a "simpler composite detector" would pass the
 *    pre-existing pin (all three assertions have either no slash or
 *    the matching provider prefix) but would return the mismatched
 *    composite verbatim. Pin: explicit mismatched-prefix wrap case.
 *
 * 3. **Idempotency fixed-point: applying the helper twice equals
 *    applying it once.** Writers and readers routinely round-trip keys
 *    through the helper (lookupRouteHealthByIdentifiers →
 *    buildRouteHealthEntry → composeRouteKey again), so
 *    `composeRouteKey({provider, model: composeRouteKey({provider,
 *    model})}) === composeRouteKey({provider, model})` must hold for
 *    every input. A refactor that dropped the `startsWith` short-
 *    circuit entirely (always wrapping) would break idempotency: the
 *    first call produces `"openrouter/xiaomi/mimo"`, the second call
 *    on that result produces `"openrouter/openrouter/xiaomi/mimo"`.
 *    The pre-existing pin's three assertions all assert single-call
 *    outputs — they never compose the helper with itself. A dedicated
 *    idempotency pin catches any refactor that breaks the fixed-point
 *    contract, including the "always wrap" and "always slash-split"
 *    simplifications that surfaces 1 and 2 independently catch for
 *    their specific branches.
 */
export function composeRouteKey(providerRoute: { provider: string; model: string }): string {
  if (providerRoute.model.startsWith(`${providerRoute.provider}/`)) {
    return providerRoute.model;
  }
  return `${providerRoute.provider}/${providerRoute.model}`;
}

/**
 * Classify a key from the persisted `providerHealth.json` flat map into
 * the provider-level vs route-level bucket it belongs to.
 *
 * `persistProviderHealth` writes BOTH `providerHealthMap` entries (raw
 * provider IDs like `"iflowcn"`, `"ollama-cloud"`) and
 * `modelRouteHealthMap` entries (composite `provider/model` keys
 * produced by `composeRouteKey`, e.g. `"iflowcn/qwen3-coder-plus"`,
 * `"openrouter/anthropic/claude-3.5-sonnet"`) into one flat JSON
 * document. On load, `loadPersistedProviderHealth` must split the flat
 * map back into the two in-memory maps so route-level backoffs survive
 * plugin restart without zombie-accumulating in the provider map (and
 * vice-versa). The classification rule is: route keys are exactly the
 * composite-form keys `composeRouteKey` produces, and
 * `composeRouteKey`'s invariant is that every composite form contains
 * at least one `/`. Provider IDs, by registry convention, never do.
 *
 * ## Drift shape this closes
 *
 * Prior to this helper `loadPersistedProviderHealth` classified each
 * key inline with `const isRouteKey = key.includes("/")`. That inline
 * predicate has two silent drift surfaces:
 *
 *   1. `composeRouteKey` and the classifier are linked: they share the
 *      `/` delimiter convention by implicit coincidence, not by
 *      shared code. If `composeRouteKey` is ever changed to use a
 *      different delimiter (`::`, `|`, `#`), the inline `.includes("/")`
 *      check silently keeps returning `false` for every new-form route
 *      key — every route penalty gets re-hydrated into the provider
 *      map, corrupting both halves of the health state on plugin
 *      restart, with no validation error. Encoding the classification
 *      as a helper next to `composeRouteKey` co-locates the delimiter
 *      convention so a future edit to one prompts review of the other.
 *   2. The inline predicate mis-handles multi-segment route keys. For
 *      keys like `"openrouter/anthropic/claude-3.5-sonnet"` (three
 *      segments, two slashes — `composeRouteKey` produces this when
 *      the opencode runtime model id already contains a `/`, which
 *      happens for aggregator-routed models on openrouter) the
 *      `.includes("/")` check correctly returns `true`, but a future
 *      refactor that "tightens" the predicate to `.split("/").length
 *      === 2` (a plausible "expect exactly provider + model" narrowing)
 *      would silently misclassify every multi-segment route key as a
 *      provider ID. That's the exact class of refactor this helper
 *      pins against: the unit tests encode the multi-segment case
 *      explicitly so a tightening attempt fails a concrete assertion
 *      instead of silently corrupting on-disk state.
 *
 * Args:
 *   persistedKey: One key from the flat persisted-health JSON map —
 *     either a raw provider ID or a composite route key.
 *
 * Returns:
 *   `"route"` if the key is a composite route key (contains at least
 *   one `/`), `"provider"` otherwise. Callers use the discriminant to
 *   decide which of the two in-memory maps receives the parsed entry.
 */
export function classifyPersistedHealthKey(
  persistedKey: string,
): "provider" | "route" {
  return persistedKey.includes("/") ? "route" : "provider";
}

/**
 * Look up an existing `ModelRouteHealth` entry by runtime identifiers.
 *
 * Exists because every route-level health writer in the plugin factory
 * builds a fresh penalty entry via `buildRouteHealthEntry` /
 * `buildModelNotFoundRouteHealth`, which requires the CURRENT entry for
 * the (provider, model) pair so the M43 "preserve longer-lived penalty"
 * invariant can dominate the merge. Pre-M67 four distinct writers —
 * `evaluateSessionHangForTimeoutPenalty` (the pure timeout helper), the
 * `session.error` model-not-found path, the `assistant.message.completed`
 * zero-token-quota path, and the `chat.params` early-fire test timeout
 * path — each inlined the same three-step lookup:
 *
 *   1. Build the composite route key via `composeRouteKey({provider, model})`
 *   2. `modelRouteHealthMap.get(routeKey)`
 *   3. Pass the result as the `existing` argument to the builder.
 *
 * The inline triplet is small (one line after formatting) but it has
 * the same drift shape the M64 `isRouteCurrentlyHealthy` consolidation
 * closed at the reader side: four independent writers all have to agree
 * on the exact composite-key construction, and any divergence (say, a
 * writer that forgets to wrap `{provider, model}` through `composeRouteKey`
 * and instead builds its own `${providerID}/${modelID}` string — exactly
 * the M30 bug that motivated `composeRouteKey`) silently looks up the
 * wrong key, finds `undefined`, and discards any in-flight penalty. The
 * `buildRouteHealthEntry` merge then treats the write as a fresh entry,
 * the preserve-longer invariant evaporates, and a shorter penalty
 * silently overwrites a longer one.
 *
 * Centralizing the lookup here means the single point of truth for
 * "how does a writer find its existing entry" lives next to
 * `composeRouteKey` where the key convention is documented. Future
 * additions (a fifth writer, a writer in a shim, a test harness) cannot
 * invent a new key shape — they have to route through this helper.
 *
 * Args:
 *   modelRouteHealthMap: Runtime composite-route-keyed health map.
 *   providerID: Provider identifier as it appears on the runtime session.
 *   modelID: Model identifier as it appears on the runtime session.
 *
 * Returns:
 *   The current `ModelRouteHealth` entry if one exists, or `undefined`
 *   when the route has no recorded health. The caller passes the result
 *   directly into `buildRouteHealthEntry` / `buildModelNotFoundRouteHealth`
 *   as the `existing` argument so the M43 preserve-longer merge invariant
 *   dominates any fresh writes.
 */
export function lookupRouteHealthByIdentifiers(
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  providerID: string,
  modelID: string,
): ModelRouteHealth | undefined {
  return modelRouteHealthMap.get(composeRouteKey({ provider: providerID, model: modelID }));
}

/**
 * Look up a route-level health entry AND return it only when the penalty
 * is currently live (`until > now`). Expired and absent entries both map
 * to `null`.
 *
 * Exists because two readers — `filterProviderModelsByRouteHealth` (the
 * `provider.models` opencode-hook that hides route-penalized models from
 * opencode's model map) and `computeRegistryEntryHealthReport` (the
 * `list_curated_models` tool reader that surfaces route-scope blocks to
 * the agent) — each inlined the same three-line sequence:
 *
 *   const routeKey = composeRouteKey({ provider: providerID, model: modelID });
 *   const routeHealth = modelRouteHealthMap.get(routeKey);
 *   if (routeHealth && routeHealth.until > now) { ... }
 *
 * M67 extracted `lookupRouteHealthByIdentifiers` for the four WRITERS
 * (session.error model-not-found, assistant.message.completed zero-token
 * quota, chat.params test-mode timeout, chat.params hang-timer timeout)
 * so they all funnel through `composeRouteKey` and cannot drift into the
 * naive `${providerID}/${modelID}` template bug from M30. But the two
 * reader sites above were overlooked — their inline `composeRouteKey`
 * calls worked today, but any future change to composite-key semantics
 * (a new normalization step, a new collision class, a registry-shape
 * migration) would have to be replicated inline in both places, with
 * nothing forcing the update. The classic drift setup: "the writers go
 * through the helper, the readers rediscover the convention by hand."
 *
 * This helper closes the boundary. It composes `lookupRouteHealthByIdentifiers`
 * (M67) with the expiry check so the two readers can drop their inline
 * `composeRouteKey` call AND their `until > now` conjunction in favor of
 * a single call. The canonical leaf predicate `isRouteCurrentlyHealthy`
 * deliberately does NOT use this helper — it keeps the inline
 * `modelRouteHealthMap.get(composeRouteKey(...))` form because it is the
 * one-line negation "no live penalty" and delegating a one-liner into
 * another one-liner adds pointless indirection. That divergence is
 * explicit: `findLiveRoutePenalty` serves callers that need the penalty
 * ENTRY (for scope reporting, for filter-out skip), while
 * `isRouteCurrentlyHealthy` serves callers that only need the boolean.
 *
 * Args:
 *   modelRouteHealthMap: Runtime composite-route-keyed health map.
 *   providerID: Provider identifier as it appears on the runtime session.
 *   modelID: Model identifier as it appears on the runtime session.
 *   now: Wall-clock timestamp in ms used for the expiry comparison.
 *
 * Returns:
 *   The `ModelRouteHealth` entry when one exists AND `until > now`
 *   (penalty still active). `null` when the entry is absent or its
 *   penalty window has already elapsed.
 *
 * ## Drift surfaces (M110 PDD)
 *
 * The four pre-existing pins (empty map, expired-at-boundary, live
 * entry, composite-idempotence) assert exclusively on return-value
 * shape via `deepEqual` / `equal`. They do NOT assert HOW the return
 * value is produced, the map state after the call, or the exact
 * return-type discriminant. Three orthogonal surfaces remain unpinned:
 *
 * 1. **Return-by-reference, not a defensive copy.** The live-entry
 *    path returns the exact `ModelRouteHealth` object that
 *    `recordRouteHealthPenalty` / `recordModelNotFoundRouteHealthByIdentifiers`
 *    installed into the map. Callers rely on this identity to detect
 *    "same penalty as last check" without deep-comparing — the
 *    `computeRegistryEntryHealthReport` reader captures the reference
 *    at tool-call time so a later retry-count bump by
 *    `buildRouteHealthEntry` is visible through the same handle. A
 *    future regression that spread `{...routeHealth}` for "safety" (a
 *    plausible defensive refactor) would break reference equality
 *    while still passing every pre-existing `deepEqual` pin. This is
 *    the M104 #1 surface mirrored to the route level — the parallel
 *    dual-map twin pattern. Pin: strict `===` identity check against
 *    the inserted object.
 *
 * 2. **Read-only map — no mutation on expired hit.** The expired
 *    branch returns `null` via the combined `!routeHealth || routeHealth.until <= now`
 *    short-circuit and leaves the map untouched. Deletion is the job
 *    of `expireHealthMaps` (called once per chat turn by
 *    `experimental.chat.system.transform`), NOT findLive*. Keeping
 *    findLive read-only matters because callers read the same map
 *    many times per turn for different routes; if findLive deleted
 *    the expired entry on first touch, the retryCount escalation
 *    ladder would reset mid-turn whenever an unrelated caller happened
 *    to probe an expired entry before the next real penalty, AND
 *    parallel provider-map readers would see an inconsistent dual-map
 *    snapshot. A regression that "helpfully" cleaned up on read
 *    would still pass the existing `result === null` return-value
 *    assertion in pin #2. This is the M104 #2 surface mirrored to
 *    the route level. Pin: after an expired-entry call, the map
 *    still contains the expired entry at its original composite key.
 *
 * 3. **Multi-segment non-prefixed model is wrapped, not passed
 *    through.** The pre-existing composite-idempotence pin (#4) uses
 *    `{provider: "ollama-cloud", model: "ollama-cloud/glm-5"}` — the
 *    model already carries the exact provider prefix, so
 *    `composeRouteKey` leaves it alone. The INVERSE case — a model
 *    that already contains `/` but whose leading segment is NOT the
 *    provider ID — is unpinned. This matters for openrouter
 *    aggregator routes: when the runtime opencode session passes
 *    `{provider: "openrouter", model: "anthropic/claude-3.5-sonnet"}`,
 *    the stored key must be `"openrouter/anthropic/claude-3.5-sonnet"`
 *    (three segments, two slashes) — `composeRouteKey` wraps because
 *    `"anthropic/claude-3.5-sonnet".startsWith("openrouter/")` is
 *    false. A plausible "simplification" refactor to
 *    `if (providerRoute.model.includes("/")) return providerRoute.model;`
 *    (incorrectly treating "already has a slash" as "already composite")
 *    would silently skip the wrap and produce the bare `"anthropic/claude-3.5-sonnet"`
 *    key, which misses the stored `"openrouter/anthropic/claude-3.5-sonnet"`
 *    entry. Pin #4 (prefix-matches case) would still pass the
 *    refactor because both the old and new branches leave the model
 *    untouched. The inverse case is the only one that discriminates.
 *    `classifyPersistedHealthKey`'s docstring explicitly flags this
 *    class of refactor as a load-bearing silent drift; this pin
 *    tripwires it at the `findLiveRoutePenalty` reader boundary.
 */
export function findLiveRoutePenalty(
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  providerID: string,
  modelID: string,
  now: number,
): ModelRouteHealth | null {
  const routeHealth = lookupRouteHealthByIdentifiers(modelRouteHealthMap, providerID, modelID);
  if (!routeHealth || routeHealth.until <= now) return null;
  return routeHealth;
}

/**
 * Return the `ProviderHealth` entry for `providerID` iff it is currently
 * active (not expired), otherwise `null`.
 *
 * Exists because three readers inlined the same two-line sequence:
 *
 *   const health = providerHealthMap.get(providerID);
 *   if (health && health.until > now) { ... use health.state / health.until ... }
 *
 * — the `computeRegistryEntryHealthReport` tool reader that surfaces
 * provider-scope blocks to the agent, the `provider.models` openrouter
 * hook that short-circuits the model map to `{}` when openrouter is
 * unhealthy, and the internal `isProviderHealthy` boolean predicate. Each
 * one encoded the SAME `until > now` boundary convention in a slightly
 * different shape: one returned the entry, one returned empty, one
 * returned a bool. Any future change to expiry semantics (a grace window,
 * a new permanent state, a boundary flip from `>` to `>=`) would need to
 * be replicated in every site, with nothing forcing the update — the
 * classic drift setup that M67/M68/M70 fixed at the route layer.
 *
 * This helper is the provider-level analog of `findLiveRoutePenalty`
 * (M70): same "return entry or null" shape, same `until <= now`
 * expiry boundary. Callers that need the entry (for scope reporting,
 * for short-circuit) read it directly. `isProviderHealthy` delegates
 * as the boolean negation "no live penalty" so the predicate and the
 * entry-returning readers cannot drift.
 *
 * ## Drift surfaces (M104 PDD)
 *
 * Beyond the pre-existing M71 boundary pins (empty map, expired entry,
 * live entry, key_missing infinity) three orthogonal drift surfaces
 * remain unpinned. Any of them could regress silently because the
 * existing pins only assert the return value, not HOW the return value
 * was produced, and not the map state after the call.
 *
 * 1. **Return-by-reference, not a defensive copy.** The live-entry path
 *    is `return health` where `health` is the exact object installed by
 *    `recordProviderHealthPenalty`. Callers rely on this identity to
 *    detect "same penalty as last check" without deep-comparing — the
 *    `computeRegistryEntryHealthReport` reader captures the reference
 *    at tool-call time so a later retry-count bump by
 *    `computeProviderHealthUpdate` is visible through the same handle.
 *    A future regression that spread `{...health}` for "safety" would
 *    break reference equality while still passing every M71 deepEqual
 *    pin. Pin: strict `===` identity check against the inserted object.
 *
 * 2. **Read-only map — no mutation on expired hit.** The expired branch
 *    returns `null` and leaves the map untouched. Deletion is the job
 *    of `expireHealthMaps` (called once per chat turn by
 *    `experimental.chat.system.transform`), NOT findLive*. Keeping
 *    findLive read-only matters because callers read the same map many
 *    times per turn for different providers; if findLive deleted the
 *    expired entry on first touch, the retryCount escalation ladder
 *    would reset mid-turn whenever an unrelated caller happened to
 *    probe an expired entry before the next real penalty. A regression
 *    that "helpfully" cleaned up on read would still pass the return-
 *    value pin. Pin: after an expired-entry call, the map still
 *    contains the expired entry.
 *
 * 3. **Exact provider-ID keying — no case folding, no composite form.**
 *    The lookup is a bare `providerHealthMap.get(providerID)`; the
 *    helper does NOT normalize case or strip any `provider/model`
 *    composite suffix. Provider IDs are canonical slugs (`"openrouter"`,
 *    `"ollama-cloud"`, `"iflowcn"`) and callers pass them verbatim from
 *    session state. The dual-map architecture (ProviderHealth vs
 *    ModelRouteHealth) depends on this: route keys go through
 *    `composeRouteKey` and provider keys do not, and confusing the two
 *    would create phantom hits or phantom misses. A regression that
 *    introduced `providerID.toLowerCase()` for defensive reasons would
 *    pass the existing lowercase-ID pins but silently miss any mixed-
 *    case probe, which matters because the `provider.models` hook
 *    receives provider IDs from opencode's session state unchanged.
 *    Pin: mixed-case provider ID is NOT found when the map key is
 *    lowercase.
 *
 * Args:
 *   providerHealthMap: Runtime provider-keyed health map.
 *   providerID: Provider identifier (e.g. `"openrouter"`, `"ollama-cloud"`).
 *   now: Wall-clock timestamp in ms used for the expiry comparison.
 *
 * Returns:
 *   The `ProviderHealth` entry when one exists AND `until > now`
 *   (penalty still active — including `key_missing` whose `until` is
 *   `Number.POSITIVE_INFINITY`). `null` when the entry is absent or its
 *   penalty window has already elapsed.
 */
export function findLiveProviderPenalty(
  providerHealthMap: Map<string, ProviderHealth>,
  providerID: string,
  now: number,
): ProviderHealth | null {
  const health = providerHealthMap.get(providerID);
  if (!health || health.until <= now) return null;
  return health;
}

/**
 * Type of the persistence side-effect function injected into
 * `recordRouteHealthPenalty`. Matches the signature of the factory-local
 * `persistProviderHealth` helper.
 */
export type PersistProviderHealthFn = (
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
) => Promise<void> | void;

/**
 * Write a route-level health penalty AND schedule disk persistence as
 * an atomic pair.
 *
 * Exists because four event-hook writers in the plugin factory —
 * `session.error` model-not-found, `session.error` assistant zero-token
 * quota, `chat.params` early-fire test timeout, and the `chat.params`
 * setTimeout hang-detector — each inlined the same two-line sequence:
 *
 *   modelRouteHealthMap.set(routeKey, health);
 *   void persistProviderHealth(providerHealthMap, modelRouteHealthMap);
 *
 * The pair is a durability invariant, not a convenience: the map-set
 * alone keeps the penalty in memory for the current plugin instance,
 * but drops it on plugin reload, plugin crash, or cross-process handoff
 * (dr-repo and letta-workspace shims share the same on-disk state file
 * via opencode's plugin mechanism). Any writer that forgets the persist
 * call silently produces penalties that work locally for a few minutes
 * and then vanish on the next bounce — exactly the class of bug that's
 * impossible to reproduce from a unit test and surfaces only as
 * intermittent "why is this known-dead route being tried again?"
 * telemetry noise.
 *
 * Pre-M68 the pairing was enforced by convention: each of the four
 * call sites carried both lines because the author of the original
 * session.error handler wrote them together, and subsequent writers
 * copy-pasted the pattern. But there was no named boundary enforcing
 * the pair — a fifth writer (a new health state, a new event hook, a
 * test harness, a shim-level override) has nothing forcing it through
 * the pair. This helper names the boundary, takes `persistFn` as an
 * injected dependency (so tests can pass a spy instead of touching
 * the real atomic-write path), and becomes the one place future
 * writers have to route through.
 *
 * Args:
 *   modelRouteHealthMap: Runtime composite-route-keyed health map.
 *     Written in place.
 *   providerHealthMap: Provider-keyed health map. Passed to `persistFn`
 *     so provider-level entries (including `key_missing` sentinels)
 *     are co-persisted with the new route penalty.
 *   routeKey: Composite route key — must be produced by `composeRouteKey`
 *     so longcat's unprefixed registry entries land under the canonical
 *     `"longcat/LongCat-Flash-Chat"` form (M30 drift shape).
 *   health: The new `ModelRouteHealth` entry to write. Usually the
 *     `health` field of a `{routeKey, health}` tuple returned by
 *     `buildRouteHealthEntry` / `buildModelNotFoundRouteHealth` (which
 *     already honors the M43 preserve-longer merge against the existing
 *     entry looked up via `lookupRouteHealthByIdentifiers`).
 *   persistFn: The persistence side-effect function. In production this
 *     is the factory-local `persistProviderHealth` (atomic tmp-file
 *     rename to survive concurrent-writer corruption across dr-repo,
 *     letta-workspace, and aicoder-opencode services sharing the state
 *     file). In tests it can be a spy to verify the pairing.
 *
 * Returns:
 *   `void`. The helper is fire-and-forget: it writes the map synchronously,
 *   invokes `persistFn` without awaiting, and returns. Persistence errors
 *   are swallowed inside `persistProviderHealth` itself (see its docstring
 *   — best-effort cleanup of tmp files on failure, intentional because a
 *   failed persist must not escalate into a runtime exception that crashes
 *   the event hook).
 */
export function recordRouteHealthPenalty(
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  providerHealthMap: Map<string, ProviderHealth>,
  routeKey: string,
  health: ModelRouteHealth,
  persistFn: PersistProviderHealthFn,
): void {
  modelRouteHealthMap.set(routeKey, health);
  void persistFn(providerHealthMap, modelRouteHealthMap);
}

/**
 * Write a provider-level health penalty AND schedule disk persistence as
 * an atomic pair — the provider-layer analog of `recordRouteHealthPenalty`
 * (M68).
 *
 * Exists because the factory-local `recordProviderHealth` (inside the
 * `ModelRegistryPlugin` closure) inlined the same set+persist pair as
 * M68's four route writers:
 *
 *   providerHealthMap.set(providerID, computeProviderHealthUpdate(...));
 *   void persistProviderHealth(providerHealthMap, modelRouteHealthMap);
 *
 * The pair is the same durability invariant M68 enumerated: `map.set`
 * alone keeps the penalty in memory for the current plugin instance but
 * drops it on plugin reload, plugin crash, or cross-process handoff
 * (dr-repo and letta-workspace shims share the same on-disk state file).
 * Pre-M73 the provider-layer pairing was enforced only by convention —
 * the factory-local helper happened to carry both lines because its
 * author wrote them together — and there was no regression pin. A
 * future refactor (a new provider-level state, a new error-classification
 * branch in `session.error`, a test harness, a shim-level override) that
 * re-did the `providerHealthMap.set` call alone would silently produce
 * provider backoffs that work for a few minutes and vanish on the next
 * bounce. M68 closed this gap at the route layer and left the provider
 * layer as a TODO; M73 is the symmetric follow-up.
 *
 * This helper takes the already-computed `newHealth` entry (callers run
 * `computeProviderHealthUpdate` themselves so the M43 preserve-longer
 * merge against the existing entry stays outside this durability-only
 * boundary — same split M68 used between `buildRouteHealthEntry` and
 * `recordRouteHealthPenalty`). The factory-local `recordProviderHealth`
 * becomes a thin wrapper: compute `newUntil` from `durationMs`, run
 * `computeProviderHealthUpdate`, and delegate here.
 *
 * Args:
 *   providerHealthMap: Runtime provider-keyed health map. Written in place.
 *   modelRouteHealthMap: Route-keyed health map. Passed through to
 *     `persistFn` so a provider-penalty write also re-serializes the
 *     route-level entries (same atomic-snapshot shape as M68).
 *   providerID: Provider identifier whose entry is being updated.
 *   newHealth: The pre-merged `ProviderHealth` entry to store. Callers
 *     produce this by running `computeProviderHealthUpdate(existing,
 *     state, newUntil)` so the M43 preserve-longer invariant dominates
 *     before the durability boundary fires.
 *   persistFn: The persistence side-effect function. In production this
 *     is the factory-local `persistProviderHealth` (atomic tmp-file
 *     rename). In tests it can be a spy to verify the pairing.
 *
 * Returns:
 *   `void`. Fire-and-forget: writes the map synchronously, invokes
 *   `persistFn` without awaiting, returns. Persistence errors are
 *   swallowed inside `persistProviderHealth` itself, intentional because
 *   a failed persist must not escalate into a runtime exception that
 *   crashes the `session.error` event hook.
 */
export function recordProviderHealthPenalty(
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  providerID: string,
  newHealth: ProviderHealth,
  persistFn: PersistProviderHealthFn,
): void {
  providerHealthMap.set(providerID, newHealth);
  void persistFn(providerHealthMap, modelRouteHealthMap);
}

/**
 * Look up the existing route-health entry, build the updated entry via
 * `buildRouteHealthEntry` (which enforces the M43 preserve-longer merge
 * invariant), and write it through `recordRouteHealthPenalty` — as one
 * atomic write-ritual.
 *
 * ## Drift shape this closes
 *
 * Two hooks in the plugin (`session.error` zero-token-quota classifier
 * and `chat.params` early-timeout branch) inlined the exact same
 * three-step sequence by hand:
 *
 *     const { routeKey, health } = buildRouteHealthEntry(
 *       providerID,
 *       model.id,
 *       <state>,
 *       <durationMs>,
 *       lookupRouteHealthByIdentifiers(
 *         modelRouteHealthMap, providerID, model.id,
 *       ),
 *       Date.now(),
 *     );
 *     recordRouteHealthPenalty(
 *       modelRouteHealthMap,
 *       providerHealthMap,
 *       routeKey,
 *       health,
 *       persistProviderHealth,
 *     );
 *
 * Every future route-level writer that wants to quarantine a route must
 * perform all three steps — look up the existing entry (so the M43
 * preserve-longer merge has its input), build the new entry (so the
 * merge fires), and write through `recordRouteHealthPenalty` (so the
 * M68 durability pair fires). Omitting any of the three produces a
 * subtle bug:
 *
 *   - Skipping the lookup → the merge runs with `undefined` as
 *     `existing`, so a fresh short penalty silently overrides an active
 *     longer one (the exact M43 drift shape at the route layer).
 *   - Skipping the build → no merge, the caller writes a raw entry that
 *     may shrink an active penalty.
 *   - Skipping the record wrapper → the M68 persist pair is broken, the
 *     penalty lives in memory but vanishes on plugin reload.
 *
 * A third future writer (new classifier, retry-count-based escalation,
 * shim-level override) copy-pasting the pattern inherits all three
 * bug classes unless the ritual is a single named call.
 *
 * ## Why a wrapper, not a shared inline snippet
 *
 * The three steps have no independent semantic meaning at the call site
 * — they always fire together, in order, with the same arguments
 * threaded through. The call-site arity collapses from ~11 lines to one
 * invocation with seven arguments (the same seven the inline version
 * already threads). That is a pure readability-and-drift-safety win,
 * not an abstraction cost.
 *
 * ## Not for `buildModelNotFoundRouteHealth`
 *
 * The `session.error` model-not-found branch uses a different builder
 * (`buildModelNotFoundRouteHealth`) with a hard-coded 6h duration and no
 * state parameter. That branch stays inline for now — adding it here
 * would require either a union-typed parameter or an overload, both of
 * which blur the state+duration contract the wrapper enforces. The
 * model-not-found path is its own small ritual and keeps its own
 * inline shape.
 *
 * Args:
 *   modelRouteHealthMap: Live route-level health map.
 *   providerHealthMap: Live provider-level health map (threaded to
 *     `recordRouteHealthPenalty` so the atomic-snapshot shape is
 *     preserved — a route write also re-serializes pending provider
 *     entries).
 *   providerID: Provider identifier.
 *   modelID: Model identifier.
 *   state: Penalty classification (any `ProviderHealthState` except
 *     `model_not_found`, which has its own builder).
 *   durationMs: Penalty window in milliseconds.
 *   now: Wall-clock timestamp; injected so tests can pin arithmetic
 *     without stubbing `Date.now`.
 *   persistFn: Injected persister (production always passes
 *     `persistProviderHealth`; tests pass a spy).
 */
export function recordRouteHealthByIdentifiers(
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  providerHealthMap: Map<string, ProviderHealth>,
  providerID: string,
  modelID: string,
  state: ProviderHealthState,
  durationMs: number,
  now: number,
  persistFn: PersistProviderHealthFn,
): void {
  const existing = lookupRouteHealthByIdentifiers(
    modelRouteHealthMap,
    providerID,
    modelID,
  );
  const { routeKey, health } = buildRouteHealthEntry(
    providerID,
    modelID,
    state,
    durationMs,
    existing,
    now,
  );
  recordRouteHealthPenalty(
    modelRouteHealthMap,
    providerHealthMap,
    routeKey,
    health,
    persistFn,
  );
}

/**
 * Model-not-found sibling of `recordRouteHealthByIdentifiers` — performs
 * the same three-step write ritual (`lookup` → `buildModelNotFoundRouteHealth`
 * → `recordRouteHealthPenalty`) for the `session.error` branch that
 * classifies a 0/404/500 + "model not found" keyword response as a
 * structural missing-model penalty.
 *
 * ## Why a separate helper (not a branch on `recordRouteHealthByIdentifiers`)
 *
 * The M75 wrapper takes `(state, durationMs)` as explicit parameters and
 * feeds them into `buildRouteHealthEntry`. The model-not-found path
 * doesn't have those degrees of freedom — the state is always
 * `"model_not_found"` and the duration is always the dedicated
 * `ROUTE_MODEL_NOT_FOUND_DURATION_MS` (6h, vs 1h for quota/timeout).
 * Folding this into M75 would require either:
 *
 *   1. An overload with a `state: "model_not_found"` discriminator that
 *      silently ignored the `durationMs` argument (bug-prone: a caller
 *      passing 1h would get 6h with no warning), or
 *   2. A union-typed builder parameter that blurred the clean
 *      `buildRouteHealthEntry` / `buildModelNotFoundRouteHealth` split
 *      M43 established.
 *
 * Keeping a dedicated wrapper preserves the contract that each builder
 * has one caller shape, and the shared drift target (the three-step
 * ritual) still collapses to one named operation per branch.
 *
 * ## Drift shape this closes
 *
 * Identical to M75: pre-fix, the `session.error` model-not-found branch
 * inlined the exact same three-step composition by hand. M75 extracted
 * the wrapper for the `buildRouteHealthEntry` flavor and explicitly
 * left this branch for M76 ("keeps its own inline shape"). M76 closes
 * that last inline site so every route-level write path in the plugin
 * routes through a named wrapper with compiler-enforced argument shape.
 *
 * Args:
 *   modelRouteHealthMap: Live route-level health map.
 *   providerHealthMap: Live provider-level health map (threaded for the
 *     atomic-snapshot shape).
 *   providerID: Provider identifier from the runtime session.
 *   modelID: Model identifier from the runtime session.
 *   now: Wall-clock timestamp; injected so tests can pin arithmetic
 *     without stubbing `Date.now`.
 *   persistFn: Injected persister (production passes
 *     `persistProviderHealth`; tests pass a spy).
 *
 * ## Drift surfaces (M114 PDD)
 *
 * Three M76 pins cover the wrapper's happy-path shape (6h
 * model_not_found write under composite key), the preserve-longer
 * merge inherited from `buildRouteHealthEntry` (pre-populated shorter
 * quota entry dominated by incoming 6h model_not_found with
 * retryCount carried), and the durability-pair invocation
 * (persistFn called once with both maps by reference). Three
 * wrapper-level invariants — orthogonal to those three pins and to
 * the underlying `buildModelNotFoundRouteHealth` / `recordRoute
 * HealthPenalty` pin sets — remain unpinned:
 *
 * 1. **Write-before-persist order: persistFn observes the NEW route
 *    entry in `modelRouteHealthMap`**. The durability-pair contract
 *    (see `recordRouteHealthPenalty` docstring) is `map.set` FIRST,
 *    then invoke `persistFn`. A refactor that swapped the order to
 *    "fire persistFn first for lower-latency flush" would let
 *    persistFn serialize a pre-write snapshot that omits the new
 *    penalty — after a plugin reload, the route would appear
 *    healthy even though the in-memory map briefly recorded it as
 *    penalized. M76 pin 3 only counts persistFn invocations and
 *    captures the map references; it never inspects the map
 *    contents INSIDE the persistFn callback, so a swapped order
 *    passes all three M76 pins. The drift is observable only from
 *    inside the persistFn closure.
 * 2. **`providerHealthMap` is threaded through unmutated — no
 *    provider-level side effect**. The model-not-found branch is
 *    deliberately route-level only (structural "this model does not
 *    exist at this provider" does NOT imply "provider is dead").
 *    The wrapper accepts `providerHealthMap` purely to satisfy the
 *    durability-pair signature of `recordRouteHealthPenalty` —
 *    `persistFn` needs both maps to serialize atomically. A refactor
 *    that "also bumped" the provider-level entry as a defensive
 *    cleanup ("since the route is dead, let's also mark the provider
 *    as degraded") would silently quarantine every other model
 *    served by the same provider whenever any one model returned a
 *    model_not_found — e.g. one typo'd modelID would take down every
 *    healthy sibling route through `openrouter`. M76 pins do not
 *    assert the post-call state of `providerHealthMap`; a side-effect
 *    write into it would pass all three.
 * 3. **Lookup threading: the pre-write lookup uses the SAME
 *    `(providerID, modelID)` pair passed to the builder, so a second
 *    call with the same unprefixed modelID finds the first call's
 *    entry and carries retryCount through the M43 preserve-longer
 *    merge**. M76 pin 2 pre-populates the map with a composite key
 *    (`"openrouter/xiaomi/gone-tomorrow"`) and asserts the merge
 *    carries `retryCount: 3 → 4`, but it never exercises the
 *    write-then-lookup round trip with an unprefixed modelID (where
 *    `composeRouteKey` must collapse both the write key and the
 *    lookup key to the same composite form). A refactor that broke
 *    the lookup's `(providerID, modelID)` threading — e.g. passing
 *    the raw `modelID` into `modelRouteHealthMap.get(modelID)` —
 *    would pass M76 pin 2 only because its pre-populated map key is
 *    already composite; under an unprefixed modelID, the second call
 *    would re-write `retryCount: 1` because the lookup missed its
 *    own prior write. A dedicated pin that calls the wrapper twice
 *    with an unprefixed modelID and asserts `retryCount: 2` on the
 *    second call closes the surface.
 */
export function recordModelNotFoundRouteHealthByIdentifiers(
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  providerHealthMap: Map<string, ProviderHealth>,
  providerID: string,
  modelID: string,
  now: number,
  persistFn: PersistProviderHealthFn,
): void {
  const existing = lookupRouteHealthByIdentifiers(
    modelRouteHealthMap,
    providerID,
    modelID,
  );
  const { routeKey, health } = buildModelNotFoundRouteHealth(
    providerID,
    modelID,
    existing,
    now,
  );
  recordRouteHealthPenalty(
    modelRouteHealthMap,
    providerHealthMap,
    routeKey,
    health,
    persistFn,
  );
}

/**
 * Return `true` when a provider+model pair must be excluded from fallback
 * routing. Exported so the regex semantics can be unit-tested directly
 * without constructing the plugin closure.
 *
 * Two layers:
 *   1. Provider-id blocklist (`FALLBACK_BLOCKED_PROVIDER_IDS`) — direct
 *      proprietary endpoints like `openai`, `anthropic`, `xai`,
 *      `github-copilot`, `longcat`, `longcat-openai`. These are blocked
 *      regardless of what model id the registry points at.
 *   2. Model-id pattern blocklist (`FALLBACK_BLOCKED_MODEL_PATTERNS`) —
 *      catches proprietary model families exposed via aggregator providers
 *      (openrouter, cloudflare ai gateway, etc.) where the provider id
 *      itself is permitted but a specific model within its catalog must
 *      still be excluded. The patterns deliberately require a digit after
 *      the brand prefix for `gpt` / `grok` so open-weights releases like
 *      `gpt-oss:120b` (legitimate free ollama-cloud model) are NOT caught
 *      by the proprietary-OpenAI guard.
 */
export function isFallbackBlocked(providerID: string, modelID: string): boolean {
  if (FALLBACK_BLOCKED_PROVIDER_IDS.has(providerID)) {
    return true;
  }
  return FALLBACK_BLOCKED_MODEL_PATTERNS.some((pattern) => pattern.test(modelID));
}

/**
 * Drop entries from both health maps whose penalty window has elapsed.
 *
 * Called from `experimental.chat.system.transform` on every invocation
 * so long-running sessions do not accumulate stale health state in
 * memory OR in the persisted `providerHealth.json` file (which is
 * rewritten from these maps whenever an error event fires).
 *
 * Three independent drift surfaces in this tiny body that are NOT
 * covered by the pre-existing mixed-expiry and infinity-preservation
 * pins:
 *
 *  1. **Provider boundary is `<= now` (inclusive).** An entry with
 *     `until === now` is treated as expired and deleted — the
 *     penalty window closes the moment wall-clock reaches the
 *     stamped deadline, not one tick later. A refactor to `< now`
 *     (an easy "strictly expired" mis-read of the semantics) would
 *     leak boundary-exact entries: the penalty window would extend
 *     one tick past its nominal end, and on a fast-retry code path
 *     the just-expired provider would still look dead to
 *     `isProviderHealthy` (which uses the same `<= now` convention
 *     at `src/plugins/model-registry.ts`), causing a stale-penalty
 *     phantom. Pre-existing pin 1 uses `now - 1` deadlines so the
 *     `< now` drift still expires those entries; the boundary pin
 *     is the only way to catch the inclusivity invariant.
 *
 *  2. **Route boundary is `<= now` (inclusive) — independently of
 *     the provider boundary.** The two loops have two independent
 *     `<= now` comparisons, and both must stay inclusive. A drift
 *     on just the route loop (e.g. a partial refactor that only
 *     touches the second comparison) would leak route-map
 *     boundary-exact entries while leaving provider-map expiry
 *     correct — a split-brain state where route-level penalties
 *     linger one tick past their deadline while provider-level
 *     penalties expire promptly. Pre-existing pin 1 uses `now - 1`
 *     on both maps, so neither drift is caught structurally; the
 *     route boundary needs its own dedicated pin that is disjoint
 *     from the provider boundary pin.
 *
 *  3. **Non-expired entries are preserved UNCHANGED — the helper
 *     touches nothing on the surviving branch.** There is no
 *     `else` clause; entries whose `until > now` are walked over
 *     and left byte-identical. `retryCount` in particular must
 *     survive, because `computeProviderHealthUpdate` reads the
 *     existing `retryCount` on the next penalty hit to compute the
 *     next-penalty duration (retry escalation). A refactor that
 *     added an `else { set(...) }` clause "to normalise" preserved
 *     entries — e.g. resetting `retryCount` to zero on every sweep,
 *     capping it, or rebuilding the object with `{ ...health }` —
 *     would silently undo escalation state on every
 *     `experimental.chat.system.transform` invocation (once per
 *     chat turn). The penalty escalation ladder would flatten to
 *     "always first-attempt duration" because every previous
 *     retryCount would be zeroed before the next penalty hit.
 *     Pre-existing pins assert `.has(...)` on surviving entries
 *     but never read `retryCount` back, so this drift class has
 *     zero structural coverage.
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
 *
 * ## Drift surfaces (M106 PDD)
 *
 * The four pre-existing pins assert field values across both branches
 * (preserve-longer, key_missing-infinity, incoming-longer, fresh-record)
 * but leave three orthogonal invariants unguarded. Each is load-bearing
 * and each has a plausible refactor that would silently regress it:
 *
 * 1. **Preserve branch returns a fresh object, not a shared reference
 *    to `existing`.** The caller `recordProviderHealth` stores the
 *    return value back into `providerHealthMap` under the same key
 *    `existing` was read from. If this helper ever `return existing;`
 *    then `map.get(providerID) === existing === next` — a later writer
 *    that mutates `next.retryCount += 1` would retroactively mutate the
 *    already-committed prior entry through the shared handle. Today
 *    that path is inert because callers treat the return as immutable,
 *    but the invariant "the map never holds the literal object passed
 *    in as `existing`" is what lets reviewers reason about aliasing
 *    without tracing every caller. A naive optimization like
 *    `return existing;` in the preserve branch (to skip an allocation)
 *    would pass a shallow field-equality check but break the aliasing
 *    invariant. The existing pins fail coincidentally because they
 *    check `retryCount === existing.retryCount + 1` and the drop-the-
 *    allocation sabotage also drops the increment — but a more careful
 *    sabotage like `return { ...existing, retryCount: existing.retryCount + 1 }`
 *    would restore all fields while still potentially leaking a shared
 *    reference via `...existing`'s enumerable own-properties. A strict
 *    `next !== existing` identity pin is the only way to catch the
 *    bare `return existing;` form directly.
 *
 * 2. **Strict `>` (not `>=`) — equal-until takes the NEW path.** The
 *    condition `existing.until > newUntil` uses strict inequality so
 *    that when the incoming penalty expires at EXACTLY the same
 *    timestamp as the existing one, the new `state` wins. This matters
 *    when two writers (e.g. a route-level zero-token quota and a
 *    provider-level 429) compute the same `now + 1h` boundary in the
 *    same tick and the newer classification is genuinely more accurate
 *    (e.g. `no_credit` refining a preliminary `quota`). Flipping `>`
 *    to `>=` would silently preserve the stale classification on the
 *    tie and the operator-visible state label in `healthStateLabel`
 *    would lag reality by up to the full lockout window. None of the
 *    four existing pins exercise the tie — they all use clearly-
 *    unequal untils (`now + 2h` vs `now + 1h`) — so the strict/
 *    non-strict distinction is currently an unpinned property of the
 *    source.
 *
 * 3. **Input `existing` record is never mutated.** Both branches
 *    allocate a fresh object literal; neither path writes through
 *    `existing`. If a future refactor chose `Object.assign(existing,
 *    { state: newState, until: newUntil, retryCount: ... })` in the
 *    new-path branch to save an allocation, the field-equality pins
 *    would all still pass (the return value carries the right fields
 *    because Object.assign mutates AND returns the first argument),
 *    but the caller's local reference to `existing` — which
 *    `recordProviderHealth` captured before calling this helper — would
 *    now report the new values. Any code that held onto `existing`
 *    for logging, metric emission, or diff-against-previous would
 *    misattribute the new state to the prior observation. The only
 *    way to pin this is to snapshot a field of `existing` before the
 *    call and assert it is unchanged after.
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
// `model_not_found` is structurally longer-lived than `quota`: a quota
// window refills on a clock, but a missing model means the upstream
// provider does not expose this model id at all — retrying on the 1h
// quota schedule produces guaranteed 404s every hour, polluting health
// telemetry and wasting a request budget. 6h is long enough to skip an
// entire interactive session without re-probing, short enough that a
// newly-deployed model the next morning gets picked up on the first
// attempt. Safe to bump independently of quota after M43 made
// `buildRouteHealthEntry` preserve the longer-lived penalty on merge,
// so interleaving a shorter quota penalty on the same route cannot
// shrink an active model_not_found window.
export const ROUTE_MODEL_NOT_FOUND_DURATION_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Authoritative mapping from `ProviderApiErrorClass` to backoff duration.
 *
 * ## Drift shape this closes
 *
 * The `session.error` hook used to hand-wire the penalty lookup as three
 * parallel if-else branches:
 *
 *     if (errorClass === "quota") {
 *       recordProviderHealth(..., "quota", QUOTA_BACKOFF_DURATION_MS);
 *     } else if (errorClass === "no_credit") {
 *       recordProviderHealth(..., "no_credit", NO_CREDIT_DURATION_MS);
 *     } else if (errorClass === "key_dead") {
 *       recordProviderHealth(..., "key_dead", KEY_DEAD_DURATION_MS);
 *     }
 *
 * This couples the class→duration mapping to its single call site, and if
 * `ProviderApiErrorClass` gains a new penalty state (say `"blocked"`), TS
 * would NOT fail — the new state would silently fall through the chain
 * and be dropped as though it were `"unclassified"`, quarantining nothing.
 *
 * ## Why a Record with `Exclude<>`
 *
 * `Record<Exclude<ProviderApiErrorClass, "unclassified">, number>` forces
 * exhaustiveness: every penalty state in the union MUST appear as a key,
 * and `"unclassified"` is excluded from the mapping by construction (not
 * by an if-guard that can forget to be added). Adding a new penalty state
 * to the union fails compilation at this Record literal until the author
 * assigns a duration, making the mapping impossible to forget.
 */
export const PROVIDER_PENALTY_CLASS_TO_BACKOFF_DURATION_MS: Record<
  Exclude<ProviderApiErrorClass, "unclassified">,
  number
> = {
  quota: ROUTE_QUOTA_BACKOFF_DURATION_MS,
  no_credit: PROVIDER_NO_CREDIT_DURATION_MS,
  key_dead: PROVIDER_KEY_DEAD_DURATION_MS,
};

/**
 * Default hang-timer budget used when `AICODER_ROUTE_HANG_TIMEOUT_MS` is
 * unset or unparseable. 15 minutes matches the upper bound of interactive
 * deep-reasoning turns on kimi-k2-thinking / minimax-m2.7 / cogito-2.1
 * without forcing genuinely-hung silent-death sessions to linger longer.
 */
export const DEFAULT_ROUTE_HANG_TIMEOUT_MS = 900000;

/**
 * Parse the `AICODER_ROUTE_HANG_TIMEOUT_MS` env var into a validated
 * millisecond budget for the `chat.params` hang timer.
 *
 * The previous inline `parseInt(raw ?? "900000", 10)` had three latent
 * misbehaviors that only a real misconfiguration would surface, but when
 * any of them did fire the consequences cascaded across every active
 * session until the operator noticed:
 *
 *  1. **NaN fall-through.** `parseInt("abc", 10)` returns `NaN`. The
 *     downstream check `timeoutMs < 1000` evaluates to `false` for `NaN`
 *     (all comparisons against `NaN` are `false`), so the code enters the
 *     production `setTimeout(fn, NaN + 100)` branch. Node coerces the
 *     delay to `1` ms, the timer fires almost immediately, and
 *     `finalizeHungSessionState` records a spurious `"timeout"` penalty
 *     on whatever provider/model the session is using. Every subsequent
 *     session repeats the penalty — a typo in an env var silently blacks
 *     out every route in the registry.
 *  2. **Trailing garbage accepted.** `parseInt("900000abc", 10)` returns
 *     `900000`, hiding the operator error instead of flagging it.
 *  3. **Negative values.** `parseInt("-1", 10)` returns `-1`, which is
 *     `< 1000`, so the "test mode" branch fires and immediately penalizes
 *     the route — a negative timeout is not a test request, it is a
 *     misconfiguration.
 *
 * The replacement rules: reject any input that is not a finite
 * non-negative integer (via `Number()` + `Number.isFinite()` + `< 0`
 * guard), falling back to `DEFAULT_ROUTE_HANG_TIMEOUT_MS`. `Number("")`
 * is `0`, so empty strings are treated as unset and also fall back. The
 * test-mode short-path (`< 1000`) is preserved: a caller who genuinely
 * wants immediate-penalty test semantics can still pass `"0"` or `"500"`
 * and have them honored.
 *
 * Args:
 *   rawValue: The raw env-var string, or `undefined` when unset.
 *
 * Returns:
 *   A non-negative integer millisecond budget. Defaults to
 *   `DEFAULT_ROUTE_HANG_TIMEOUT_MS` on any invalid input.
 */
export function parseHangTimeoutMs(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.length === 0) {
    return DEFAULT_ROUTE_HANG_TIMEOUT_MS;
  }
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    return DEFAULT_ROUTE_HANG_TIMEOUT_MS;
  }
  return Math.trunc(parsedValue);
}

/**
 * Threshold (milliseconds) below which `chat.params` records a "timeout"
 * route-health penalty **synchronously** at hook entry instead of
 * arming the usual `setTimeout`-based hang detector.
 *
 * The `< THRESHOLD` (strict) branch is a test-mode short-path referenced
 * by `parseHangTimeoutMs`'s docstring: a caller who wants immediate-
 * penalty semantics (e.g. a regression test that cannot afford to wait
 * 15 minutes for the default hang timer to fire) sets
 * `AICODER_ROUTE_HANG_TIMEOUT_MS="0"` or `"500"` and the hook takes the
 * synchronous branch. Production operation always sets
 * `DEFAULT_ROUTE_HANG_TIMEOUT_MS` (900000), which is comfortably above
 * this threshold.
 *
 * Previously the `chat.params` hook carried the literal `1000` inline
 * with a one-line `// For testing purposes with very short timeouts`
 * comment and no named constant — a drift surface on three axes:
 *   1. The literal has no documented semantics at the call site, so a
 *      future developer could tune it (`< 100`? `< 500`?) without
 *      understanding that `parseHangTimeoutMs`'s docstring references
 *      this exact boundary as the "test-mode short-path".
 *   2. The `<` boundary is implicit; flipping to `<=` or `>` changes
 *      the semantics silently.
 *   3. The branch gate re-reads `input.provider.info.id` and `input.model`
 *      directly and repeats the null-guard inline, so a refactor could
 *      drop either half of the `&& hasProviderID && hasModel` policy
 *      and record a penalty against an undefined identifier tuple.
 *
 * Naming the threshold and pairing it with
 * `shouldRecordImmediateTimeoutPenalty` makes all three invariants
 * single-site properties instead of convention-by-comment.
 */
export const HANG_TIMEOUT_IMMEDIATE_THRESHOLD_MS = 1000;

/**
 * Decide whether the `chat.params` hook should record an immediate
 * "timeout" route-health penalty instead of arming the hang timer.
 *
 * The three-way AND encodes the full gate: (a) the parsed timeout
 * budget is under the test-mode short-path threshold
 * (`HANG_TIMEOUT_IMMEDIATE_THRESHOLD_MS`, strict `<`), (b) the input
 * session carries a non-empty provider identifier, and (c) the input
 * session carries a non-null model tuple. Dropping any of the three
 * conditions silently changes who gets penalized:
 *
 *   - Drop the threshold check → every session records an immediate
 *     timeout penalty on entry, blacking out every route in the
 *     registry within seconds of the plugin loading.
 *   - Drop the providerID check → a session that never bound its
 *     provider records a timeout penalty keyed on `undefined`, which
 *     `recordRouteHealthByIdentifiers` either crashes on or silently
 *     writes to the wrong map slot.
 *   - Drop the model check → same failure mode, one layer deeper
 *     (the `modelRouteHealthMap` composite key becomes
 *     `"provider/undefined"`).
 *
 * The helper is a pure boolean predicate so the test pins can sabotage
 * each AND-term independently and fire exactly one pin per sabotage.
 *
 * Args:
 *   rawTimeoutMs: The output of `parseHangTimeoutMs(process.env.*)` —
 *     non-negative integer milliseconds.
 *   hasProviderID: `true` when `input.provider.info.id` is non-empty.
 *   hasModel: `true` when `input.model` is a non-null object.
 *
 * Returns:
 *   `true` iff all three conditions hold and the caller should take
 *   the synchronous immediate-penalty branch; `false` means arm the
 *   `setTimeout`-based hang detector instead.
 */
export function shouldRecordImmediateTimeoutPenalty(
  rawTimeoutMs: number,
  hasProviderID: boolean,
  hasModel: boolean,
): boolean {
  return (
    rawTimeoutMs < HANG_TIMEOUT_IMMEDIATE_THRESHOLD_MS
    && hasProviderID
    && hasModel
  );
}

/**
 * Assemble the ordered health-aware system-prompt list that the
 * `experimental.chat.system.transform` hook appends to `output.system`.
 *
 * ## Drift shape
 *
 * Previously the transform hook carried two near-identical inline
 * blocks:
 *
 *     const providerHealthPrompt = buildProviderHealthSystemPrompt(...);
 *     if (providerHealthPrompt) {
 *       output.system.push(providerHealthPrompt);
 *     }
 *     const availableModelsPrompt = buildAvailableModelsSystemPrompt(...);
 *     if (availableModelsPrompt) {
 *       output.system.push(availableModelsPrompt);
 *     }
 *
 * Four drift surfaces sat on that twelve-line fragment:
 *
 *   1. **Order**. Provider-health must land in `output.system` BEFORE
 *      the available-models block — the former describes "what's
 *      broken right now" and the latter describes "what to use
 *      instead". A future refactor that reorders the two `push` calls
 *      silently inverts the prompt narrative the agent reads top-to-
 *      bottom, which changes both the first-hit salience and the
 *      way the health story frames the fallback list.
 *   2. **Null filter** (provider-health). Dropping the `if (...)` guard
 *      on the first block silently pushes `null` into `output.system`,
 *      which is typed as `string[]` at the opencode layer — the push
 *      succeeds through the TypeScript `string | null` widening at
 *      the call site and the broken prompt surfaces only downstream.
 *   3. **Null filter** (available-models). Mirror of surface 2 on the
 *      second block.
 *   4. **Asymmetric guard loss**. A refactor could delete the guard on
 *      ONE block but keep it on the other, producing an arrangement
 *      where one builder's null output crashes and the other
 *      silently tolerates it — the worst kind of inconsistency
 *      because it manifests only when one specific builder returns
 *      null, which is itself rare in production.
 *
 * The helper collapses the fragment into one call-site conditional
 * whose ordering, null-filter, and single-source-of-truth invariant
 * are all properties of one exported function. The two builders are
 * still invoked at the call site so the 4-arg registry+maps calls
 * remain visible and type-checked there — the helper's job is the
 * ordering-and-null-filter policy, not the builder invocation.
 *
 * Args:
 *   providerHealthPrompt: The `buildProviderHealthSystemPrompt` output,
 *     which is `string | null` — null when no agent-visible penalties
 *     exist or the renderer produces an empty body.
 *   availableModelsPrompt: The `buildAvailableModelsSystemPrompt`
 *     output, same nullable contract.
 *
 * Returns:
 *   A zero-to-two-element string array in canonical transform-hook
 *   order (provider-health first, available-models second). Spread
 *   into `output.system.push(...)`. Empty when both inputs are null.
 */
export function assembleHealthAwareSystemPrompts(
  providerHealthPrompt: string | null,
  availableModelsPrompt: string | null,
): string[] {
  const systemPrompts: string[] = [];
  if (providerHealthPrompt !== null) {
    systemPrompts.push(providerHealthPrompt);
  }
  if (availableModelsPrompt !== null) {
    systemPrompts.push(availableModelsPrompt);
  }
  return systemPrompts;
}

/**
 * Runtime-validate and extract an explicit `{ id, providerID }` model
 * tuple from a `session.error` event payload.
 *
 * Motivation — the `session.error` handler previously read the explicit
 * model off the event with an `as any` type assertion:
 *
 *     const model = (sessionError as any).model ?? mappedModel;
 *
 * Two silent drift surfaces:
 *
 *   1. The cast swallows every TypeScript error about the shape of
 *      `sessionError.model`. If a future opencode release moves the
 *      field (to `sessionError.data.model`, `sessionError.context.model`,
 *      `sessionError.routeInfo.model`), the expression silently
 *      evaluates to `undefined` and the `?? mappedModel` fallback
 *      covers for it — the session-mapped model is always populated
 *      from the chat.params binding path, so the classification branch
 *      keeps running against the STALE session-mapped model instead of
 *      the potentially-divergent error-specific model the event was
 *      meant to carry. No exception, no warning, no telemetry. The
 *      explicit-vs-mapped distinction exists specifically for cases
 *      where the two diverge (e.g. fallback routing where the failing
 *      model is not the one the session was originally bound to), so
 *      silently collapsing into the fallback corrupts classification
 *      exactly in the scenarios the field was added to handle.
 *
 *   2. No runtime validation on the extracted value. A malformed
 *      `sessionError.model = "bare-string"` or `sessionError.model = {}`
 *      would previously pass through as-is and crash (or silently
 *      no-op) at the downstream `.id` access a few lines later. The
 *      `modelID = model?.id` guard catches the crash case but not the
 *      semantic case — a `{model: {id: "x"}}` without `providerID`
 *      hands the wrong-shape tuple to `recordModelNotFoundRouteHealthByIdentifiers`
 *      (which takes `providerID, modelID` as positional strings, not
 *      a tuple, so the tuple-shape bug actually can't reach that
 *      helper today — but the guard is structural, not dependent on
 *      the current call-site wiring).
 *
 * This helper replaces the `as any` cast with explicit
 * field-by-field narrowing, returning `undefined` unless the event
 * carries a structurally valid `{ id: string, providerID: string }`
 * under the `.model` key. The caller retains the `?? mappedModel`
 * fallback externally so the explicit-preference policy stays
 * visible at the call site.
 *
 * ## Drift shape this closes
 *
 * Per-narrowing-step drift: the three runtime checks (object shape,
 * `id` type, `providerID` type) form a defensive ladder where
 * dropping any one step silently widens the accepted input. The test
 * split pins each step independently so a sabotage that drops a
 * single check fires exactly one pin — the same per-narrowing-step
 * partition that M81 and M82 used at different layers of the plugin.
 *
 * Args:
 *   sessionError: The `event.properties` payload for a `session.error`
 *     event — type `unknown` because the opencode host does not
 *     currently export a stable TypeScript shape for the `model`
 *     field, and the whole point of this helper is to narrow it
 *     defensively rather than trust an `as any` cast.
 *
 * Returns:
 *   The structurally valid `{ id, providerID }` tuple from the event,
 *   or `undefined` when the field is missing or malformed. Callers
 *   should supply their own fallback (e.g. `?? mappedModel`) at the
 *   call site so the policy is visible.
 *
 * ## Drift surfaces (M112 PDD)
 *
 * The three pre-existing pins cover the happy path and the two
 * innermost narrowing steps (`id` string, `providerID` string), but
 * three orthogonal surfaces remain unpinned — each closed by an
 * explicit guard that a "defensive simplification" refactor could
 * silently drop:
 *
 * 1. **Outer-object null-guard.** The first gate is
 *    `if (sessionError === null || typeof sessionError !== "object") return undefined;`.
 *    It exists because `typeof null === "object"` in JavaScript, so
 *    the `typeof` check alone admits `null` — and the very next line
 *    reads `(sessionError as Record<string, unknown>).model`, which
 *    on `null` throws `TypeError: Cannot read properties of null`.
 *    A "simplification" that drops the explicit null disjunction as
 *    "redundant with typeof" silently crashes the `session.error`
 *    handler any time opencode emits a synthetic `session.error`
 *    with `properties: null` — which happens in older opencode
 *    versions when the error shape is not fully populated before
 *    the handler fires. The pre-existing pins feed real objects and
 *    never exercise the null branch. Pin: `null` input returns
 *    `undefined`, not a throw.
 *
 * 2. **Inner `.model` null-guard.** The second gate is
 *    `if (candidate === null || typeof candidate !== "object") return undefined;`.
 *    Identical foot-gun at the inner layer: `sessionError.model = null`
 *    is a real shape that opencode emits when the error originates
 *    from a pre-bind failure (no model yet attached to the session).
 *    The next line reads `(candidate as Record<string, unknown>).id`
 *    which on `null` throws. A defensive-simplification refactor that
 *    drops the null disjunction passes every pre-existing pin —
 *    which all use either a missing `.model` key (covered by the
 *    outer check) or a fully-populated `.model` object — but crashes
 *    on pre-bind error events. Pin: `{model: null}` returns
 *    `undefined`, not a throw.
 *
 * 3. **Return tuple is fresh and strict — extra fields on
 *    `candidate.model` are DROPPED, not forwarded.** The return
 *    statement explicitly lists the two fields:
 *    `return { id: candidateObj.id, providerID: candidateObj.providerID };`.
 *    A "simpler" refactor to `return candidateObj as { id: string; providerID: string };`
 *    or `return { ...candidateObj } as ...` would leak any extra
 *    fields the opencode event happens to carry under `.model`
 *    (provider-version breadcrumbs, debug tags, telemetry markers)
 *    into the downstream classification path. Callers pass the
 *    result to `recordModelNotFoundRouteHealthByIdentifiers`, which
 *    positionally consumes `providerID, modelID` as strings — so
 *    today's call site tolerates extra fields. But the canonical
 *    drift this pin catches is the forward-compat INVERSE of
 *    M111's serializer surface: at a narrowing gate, extra fields
 *    must be SHED (strict narrow), not PRESERVED (wide forward-compat).
 *    A future downstream consumer that starts destructuring all
 *    fields would silently pick up any upstream shape-leak. The
 *    pre-existing pins use inputs with no extra fields so shape-leak
 *    is invisible. Pin: inject an extra field on the input
 *    `.model`, assert via `Object.keys(result)` that the result has
 *    exactly `["id", "providerID"]` — no leaks.
 */
export function extractSessionErrorExplicitModel(
  sessionError: unknown,
): { id: string; providerID: string } | undefined {
  if (sessionError === null || typeof sessionError !== "object") {
    return undefined;
  }
  const candidate = (sessionError as Record<string, unknown>).model;
  if (candidate === null || typeof candidate !== "object") {
    return undefined;
  }
  const candidateObj = candidate as Record<string, unknown>;
  if (typeof candidateObj.id !== "string") {
    return undefined;
  }
  if (typeof candidateObj.providerID !== "string") {
    return undefined;
  }
  return { id: candidateObj.id, providerID: candidateObj.providerID };
}

/**
 * Narrow the opencode `session.error` event payload to the
 * structurally-required `{ sessionID, statusCode, lowerMessage }`
 * tuple when the underlying error is a recognized `APIError`, or
 * `undefined` when any gate fails.
 *
 * ## Drift shape
 *
 * Previously the `session.error` handler opened with five inline
 * narrowing gates spread across nine lines:
 *
 *     if (!sessionError?.error || sessionError.error.name !== "APIError") {
 *       return;
 *     }
 *     const apiError = sessionError.error;
 *     const statusCode: number = apiError.data.statusCode ?? 0;
 *     const message: string = (apiError.data.message ?? "").toLowerCase();
 *     const sessionID = sessionError.sessionID;
 *     if (!sessionID) return;
 *
 * Four independent drift surfaces lived on that fragment:
 *
 *   1. **Error-type gate**. `error.name !== "APIError"` is a hardcoded
 *      discriminator — opencode emits `session.error` for several
 *      error classes (NotFoundError, ProviderAuthError, APIError), and
 *      only APIError carries the `data: {statusCode, message}` shape
 *      the classification ladder downstream depends on. A refactor
 *      that widens the gate to `error.name.includes("Error")` or
 *      drops it entirely silently propagates non-APIError shapes
 *      into the `apiError.data.statusCode` raw read, producing
 *      `undefined` that coalesces to `0` and mis-classifies every
 *      non-APIError session event as an "unknown-status APIError".
 *   2. **Status code default**. The `?? 0` fallback encodes policy:
 *      an absent statusCode means "no authoritative signal, fall
 *      through to keyword heuristics". A future refactor that
 *      replaces `?? 0` with `?? -1` or `!!` would change which
 *      classification branches fire in `classifyProviderApiError`
 *      (the status-code dispatch table compares against specific
 *      numeric codes) and in `shouldClassifyAsModelNotFound` (which
 *      checks membership in `MODEL_NOT_FOUND_HTTP_STATUS_CODES`).
 *   3. **Message default + case-fold**. The `?? ""` + `.toLowerCase()`
 *      pair encodes the "keyword matching is case-insensitive against
 *      a guaranteed string" contract that every downstream keyword
 *      predicate relies on (`shouldClassifyAsModelNotFound`,
 *      `NO_CREDIT_KEYWORDS.some(kw => msg.includes(kw))`, etc.).
 *      Dropping the `.toLowerCase()` silently breaks every keyword
 *      match for messages that capitalize even one letter; dropping
 *      the `?? ""` fallback pushes `undefined.toLowerCase()` and
 *      crashes the handler on any APIError that omits a message.
 *   4. **Session ID gate**. `!sessionID` must run AFTER the APIError
 *      check, not before — reordering silently widens the handler
 *      to non-APIError paths that happen to carry a sessionID,
 *      re-introducing drift surface 1 via a different door.
 *
 * The helper collapses all four gates into one call-site conditional.
 * The `?? 0` / `?? ""` / `.toLowerCase()` policy lives in one place.
 * Renaming the helper return field from `message` to `lowerMessage`
 * pins the case-fold contract in the type system — a consumer that
 * passes the field to a case-sensitive comparison is naming it wrong.
 *
 * Args:
 *   sessionError: The `event.properties` payload for a `session.error`
 *     event — type `unknown` because the opencode host does not
 *     currently export a stable TypeScript shape for the outer
 *     envelope, and the whole point of this helper is to narrow it
 *     defensively rather than trust raw `sessionError.error.data.*`
 *     reads.
 *
 * Returns:
 *   `{ sessionID, statusCode, lowerMessage }` when the payload
 *   carries a recognized APIError and a non-empty sessionID.
 *   `undefined` on any gate failure — the `session.error` handler
 *   must `return` immediately on undefined because every downstream
 *   classifier assumes the APIError shape.
 *
 * ## Drift surfaces (M113 PDD)
 *
 * The four drift surfaces enumerated above cover the original
 * inline-narrowing regression this helper closed. Three additional
 * narrower-internal surfaces — orthogonal to the pre-existing M88
 * pins at `_whenShapeIsValid`, `_whenErrorNameIsWrong`, and
 * `_whenSessionIDIsMissing` — remained unpinned because every M88
 * pin ships a valid `data: {statusCode: <finite>, message: <string>}`
 * payload and a non-empty `sessionID`. Those pins exercise the
 * outer gate ladder (envelope object → error object → APIError name
 * → sessionID typeof) but never cross the inner `dataObj` / numeric-
 * default / length-clause boundaries. The three surfaces pinned below:
 *
 *   A. **Empty-string sessionID rejection**. The sessionID guard is
 *      `typeof envelope.sessionID !== "string" || envelope.sessionID
 *      .length === 0`. The pre-existing `_whenSessionIDIsMissing` pin
 *      omits the field entirely, failing at the `typeof` limb and
 *      never reaching the `.length === 0` limb. A refactor that drops
 *      the length clause (reading it as defensive overkill since
 *      opencode "never emits empty sessionIDs") would silently emit a
 *      context object with `sessionID: ""` — every `modelRouteHealth
 *      Map.set(sessionID, …)` downstream would clobber entries under
 *      the empty-string key, collapsing per-session route health
 *      into a single shared bucket. Non-local, observable only as
 *      mysterious cross-session penalty bleed.
 *   B. **Non-finite statusCode → 0 default**. The statusCode resolver
 *      is `typeof statusCodeRaw === "number" && Number.isFinite(status
 *      CodeRaw) ? statusCodeRaw : 0`. Existing pins all pass finite
 *      integers (429, 404). A refactor that simplifies to `typeof
 *      === "number" ? : 0` (dropping the `Number.isFinite` limb as
 *      "redundant because JSON.parse cannot produce NaN/Infinity")
 *      would let a host that stringifies statusCode from a failed
 *      `parseInt` path inject `NaN`, which then cascades into
 *      `classifyProviderApiError`'s numeric-dispatch table where
 *      `NaN === 429` is false for every branch — misclassifying a
 *      rate-limit as "unknown status" and skipping the quota-cooldown
 *      penalty. The `isFinite` guard is load-bearing precisely
 *      because the raw shape is `unknown`.
 *   C. **Missing `.data` object → zero/empty defaults without throwing**.
 *      The `dataObj` resolver is `data !== null && typeof data ===
 *      "object" ? (data as Record<string, unknown>) : {}`. Existing
 *      pins all pass `data: { statusCode, message }`. A refactor that
 *      assumes `.data` is always present (e.g. `const dataObj =
 *      errorObj.data as Record<string, unknown>`) would crash on
 *      `dataObj.statusCode` when opencode ever emits an APIError
 *      without a `.data` envelope (auth-failure, provider-config,
 *      early-stage connection errors all produce `{name: "APIError"}`
 *      with no `.data`). The `?? {}` fallback encodes "return a
 *      zero-statusCode, empty-lowerMessage context so the keyword-
 *      heuristic ladder in `classifyProviderApiError` can still run
 *      on the envelope's other fields". A sabotage that requires
 *      `.data` to be present fires a dedicated pin that passes
 *      `error: {name: "APIError"}` alone and asserts
 *      `{sessionID: …, statusCode: 0, lowerMessage: ""}`.
 */
export function extractSessionErrorApiErrorContext(
  sessionError: unknown,
): { sessionID: string; statusCode: number; lowerMessage: string } | undefined {
  if (sessionError === null || typeof sessionError !== "object") {
    return undefined;
  }
  const envelope = sessionError as Record<string, unknown>;
  const error = envelope.error;
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  const errorObj = error as Record<string, unknown>;
  if (errorObj.name !== "APIError") {
    return undefined;
  }
  if (typeof envelope.sessionID !== "string" || envelope.sessionID.length === 0) {
    return undefined;
  }
  const data = errorObj.data;
  const dataObj =
    data !== null && typeof data === "object"
      ? (data as Record<string, unknown>)
      : {};
  const statusCodeRaw = dataObj.statusCode;
  const statusCode =
    typeof statusCodeRaw === "number" && Number.isFinite(statusCodeRaw)
      ? statusCodeRaw
      : 0;
  const messageRaw = dataObj.message;
  const lowerMessage = (typeof messageRaw === "string" ? messageRaw : "").toLowerCase();
  return {
    sessionID: envelope.sessionID,
    statusCode,
    lowerMessage,
  };
}

/**
 * Narrow the opencode `assistant.message.completed` event payload to the
 * structurally-required `{ sessionID, tokens }` tuple or `undefined`.
 *
 * ## Drift shape
 *
 * Per-narrowing-step drift: the `event` hook previously opened the
 * `assistant.message.completed` branch with `(event as any).type ===
 * "..."` followed by `const props = (event as any).properties as any;`
 * and raw field reads `const sessionID = props.sessionID; const tokens
 * = props.tokens;`. Two independent `as any` casts stack on one call
 * site — the same "TypeScript-silent, runtime-silent, log-silent"
 * drift class M84 closed on the `session.error` handler. Two concrete
 * drift surfaces: (1) the opencode host does not export a stable
 * TypeScript shape for the `assistant.message.completed` event, so a
 * future release that renames `sessionID` → `session_id`, wraps the
 * payload in `properties.message.tokens`, or promotes `tokens` to a
 * tagged union silently delivers a malformed object into the
 * zero-token quota-exhaustion classifier with no thrown error; (2) a
 * future refactor that spreads `{...props}` verbatim loses the
 * implicit `!sessionID` / `!tokens` guards, pushing `undefined`
 * through `readAndClearSessionHangState` (a session-id keyed map
 * operation that would silently return undefined bindings and skip
 * the whole classification pass). The three-pin split pins each
 * narrowing step independently so a sabotage that drops a single
 * check fires exactly one pin — the same per-narrowing-step partition
 * M84 used on `extractSessionErrorExplicitModel`. The helper is kept
 * minimal so the `?? {}` vs skip-pass policy stays at the call site.
 *
 * ## Drift surfaces (M105 PDD)
 *
 * The three pre-existing M85 pins (valid shape, missing sessionID,
 * missing tokens) each target ONE narrowing step in isolation so a
 * sabotage that drops a single check fires exactly one pin — a clean
 * per-step partition. But the narrowing body encodes three further
 * orthogonal invariants that the M85 pins do not exercise, each of
 * which is a silent-drift vector the `assistant.message.completed`
 * hook depends on:
 *
 * 1. **The `type` tag check is LOAD-BEARING, not redundant.** The
 *    opencode event bus dispatches by event name and every handler is
 *    registered under `"assistant.message.completed"`, so the `type`
 *    check *looks* redundant at the dispatch site. It is not: the
 *    opencode runtime also forwards a consolidated event stream
 *    through `assistant.message.completed` handlers for out-of-band
 *    lifecycle events (partial flushes, provider-side keepalive
 *    frames) whose `properties` happens to include a `sessionID` and
 *    may or may not include a `tokens` shape. A future simplification
 *    that drops the `type` check "because the event hook already
 *    filters" would pass through those off-type events into
 *    `isZeroTokenQuotaSignal`, which would then fire zero-token
 *    quota penalties for every keepalive — a silent cascade that
 *    quarantines healthy providers. All three M85 pins use the
 *    correct `type` tag so none of them exercise this drift. Pin:
 *    wrong `type` with otherwise-valid shape returns undefined.
 *
 * 2. **Empty-string sessionID is rejected even though it is a
 *    string.** The `typeof propertiesObj.sessionID !== "string"` check
 *    is followed by an AND clause `|| propertiesObj.sessionID.length
 *    === 0`. The M85 "missing sessionID" pin passes `undefined`,
 *    which fails at `typeof !== "string"` and never reaches the
 *    length clause. A refactor that "simplified" the check to just
 *    `typeof === "string"` would pass empty-string sessionIDs through
 *    to `readAndClearSessionHangState`, which is a `Map<string, ...>`
 *    keyed lookup — an empty string key silently collides with any
 *    other empty-string binding across every session map in the
 *    plugin. Pin: `sessionID: ""` with valid tokens returns undefined.
 *
 * 3. **The returned `tokens` must be the exact input reference.** The
 *    hook pipes `tokens` directly into `isZeroTokenQuotaSignal`, which
 *    reads nested objects via `Object.values(value as Record<string,
 *    unknown>)`. If this helper spread `{ ...tokens }` for "safety",
 *    the top-level numeric counters would be preserved but the nested
 *    cache object reference would still be aliased — a half-copy that
 *    looks identical for shallow reads but could mask a future
 *    freeze / clone / normalization step downstream. More importantly,
 *    reference stability is the contract downstream consumers rely on
 *    when they capture `tokens` for later comparison or diffing.
 *    M85's deepEqual pin cannot distinguish identity from equality.
 *    Pin: strict `===` identity check between the returned `tokens`
 *    and the input object.
 *
 * Args:
 *   event: The opencode event value — type `unknown` because the host
 *     does not currently export a stable TypeScript shape for
 *     `assistant.message.completed`, and the whole point of this
 *     helper is to narrow it defensively rather than trust a cast.
 *
 * Returns:
 *   The structurally valid `{ sessionID, tokens }` tuple from the
 *   event, or `undefined` when the type tag is wrong, the properties
 *   object is missing, or either required field is malformed.
 *   `tokens` is returned as `Record<string, unknown>` — the shape the
 *   downstream `isZeroTokenQuotaSignal` expects.
 */
export function extractAssistantMessageCompletedPayload(
  event: unknown,
): { sessionID: string; tokens: Record<string, unknown> } | undefined {
  if (event === null || typeof event !== "object") {
    return undefined;
  }
  const eventObj = event as Record<string, unknown>;
  if (eventObj.type !== "assistant.message.completed") {
    return undefined;
  }
  const properties = eventObj.properties;
  if (properties === null || typeof properties !== "object") {
    return undefined;
  }
  const propertiesObj = properties as Record<string, unknown>;
  if (typeof propertiesObj.sessionID !== "string" || propertiesObj.sessionID.length === 0) {
    return undefined;
  }
  const tokens = propertiesObj.tokens;
  if (tokens === null || typeof tokens !== "object") {
    return undefined;
  }
  return {
    sessionID: propertiesObj.sessionID,
    tokens: tokens as Record<string, unknown>,
  };
}

/**
 * Build the `{routeKey, health}` pair for the four route-level health
 * writers (`session.error` model_not_found, `assistant.message.completed`
 * zero-token quota, `chat.params` immediate timeout, `chat.params`
 * hang-timer timeout) so the key-composition, preserve-longer merge,
 * and retryCount arithmetic all live behind a single pure helper.
 *
 * This is the route-level analog of `computeProviderHealthUpdate` —
 * same M43-era preserve-longer invariant, same retryCount-always-
 * increments rule, same fresh-object-per-return contract — with the
 * additional responsibility of normalizing the route key through
 * `composeRouteKey` so writers and readers cannot drift on already-
 * composite model ids.
 *
 * Args:
 *   providerID: The opencode runtime provider id.
 *   modelID: The opencode runtime model id, which may or may not
 *     already contain the provider prefix — `composeRouteKey` handles
 *     both shapes idempotently.
 *   state: The classified penalty state for the incoming error.
 *   durationMs: How long (from `now`) the penalty should last.
 *   existing: The current entry at the composed route key, used to
 *     carry `retryCount` and to enforce the preserve-longer merge.
 *   now: Current wall-clock timestamp in ms (injected for testability).
 *
 * Returns:
 *   `{ routeKey, health }` — the caller writes `map.set(routeKey, health)`
 *   and triggers persistence. The caller remains responsible for the
 *   mutation so this helper stays pure.
 *
 * ## Drift surfaces (M107 PDD)
 *
 * The seven pre-existing pins cover the four-way routeKey composition
 * cartesian (composite/unprefixed/openrouter/readback) plus three M43
 * preserve-longer field-equality checks (existing-retryCount carry,
 * preserve-longer-existing, accept-longer-incoming). They leave three
 * orthogonal invariants unguarded — each is load-bearing and each has
 * a plausible refactor that would silently regress it. These mirror
 * the M106 surfaces on `computeProviderHealthUpdate` because the two
 * functions are parallel twins across the dual-map architecture and
 * the same drift classes apply symmetrically:
 *
 * 1. **Preserve branch returns a fresh `health` object, not `existing`
 *    by reference.** The four writers store the return's `health`
 *    field back into `modelRouteHealthMap` under `routeKey`. A
 *    `health: existing` optimization would make `map.get(routeKey) ===
 *    existing === result.health` — any later writer that bumps
 *    `retryCount` through the fresh return handle would retroactively
 *    mutate the caller's prior local reference to `existing`. The M43
 *    field-equality pins fail coincidentally on the bare `health:
 *    existing` form (because they expect `retryCount + 1`), but a
 *    careful `health: { ...existing, retryCount: existing.retryCount
 *    + 1 }` regression would pass every M43 pin while still leaking
 *    shared nested references (e.g. if a future `ModelRouteHealth`
 *    shape grew a nested object field). Only a strict `result.health
 *    !== existing` identity pin catches the bare-reference form
 *    directly.
 *
 * 2. **Strict `>` (not `>=`) — equal-until takes the NEW path.** The
 *    condition `existing.until > newUntil` uses strict inequality so
 *    that when an incoming penalty computes `now + durationMs ===
 *    existing.until` (very reachable: two writers firing in the same
 *    tick with the same backoff constant produce byte-identical
 *    untils), the NEW `state` wins. This matters across route-level
 *    classifiers: a route that was flagged `timeout` at T and
 *    simultaneously produces a `model_not_found` classification at the
 *    SAME T (e.g. a hang-timer and a session.error firing in the same
 *    event-loop tick) must commit to the more structural classification
 *    so `healthStateLabel` and the fallback-route resolver see reality,
 *    not a stale label. None of the seven existing pins uses tie-case
 *    untils — they all compute clearly-unequal values — so the strict/
 *    non-strict boundary is currently an unpinned property of the
 *    source.
 *
 * 3. **Input `existing` record is never mutated.** Both branches build
 *    fresh object literals for the `health` field; neither path writes
 *    through `existing`. If a future refactor chose `Object.assign(
 *    existing, { state, until, retryCount })` in the new-path branch
 *    to skip an allocation, the field-equality pins would all still
 *    pass (Object.assign returns its first argument with the right
 *    fields, and all seven M43 pins check the return value's fields
 *    not the input's), but any caller that captured a pre-call
 *    reference to `existing` for logging, metric emission, or
 *    diff-against-previous would misattribute new observations to
 *    prior turns. The only way to pin this is to snapshot a field of
 *    `existing` before the call and assert it is unchanged after.
 */
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

/**
 * Build a route-level `model_not_found` penalty entry using the
 * dedicated `ROUTE_MODEL_NOT_FOUND_DURATION_MS` (6h) rather than the
 * shorter `ROUTE_QUOTA_BACKOFF_DURATION_MS` (1h).
 *
 * History: the `session.error` handler used to pass the quota backoff
 * duration directly for the model-missing path. Semantically this is
 * wrong — a quota window expires on a refill clock, but a missing model
 * is a structural property of the upstream: the provider simply does
 * not serve that model id. Retrying on the 1h quota cadence produces a
 * guaranteed 404 every hour. A dedicated longer window skips the
 * wasted retries across an interactive session while still being short
 * enough to pick up a newly-deployed model the next morning.
 *
 * Thin wrapper around `buildRouteHealthEntry` — the M43 preserve-longer
 * invariant still applies, so a previously-set longer penalty (e.g. if
 * another process persisted an even-longer window, or a future writer
 * introduces a longer duration) continues to dominate the merge.
 *
 * Args:
 *   providerID: Provider identifier from the runtime session.
 *   modelID: Model identifier from the runtime session.
 *   existing: Current entry for the composite route key, if any.
 *   now: Wall-clock timestamp in ms.
 *
 * Returns:
 *   `{ routeKey, health }` — the caller writes `map.set(routeKey, health)`
 *   and triggers persistence.
 */
export function buildModelNotFoundRouteHealth(
  providerID: string,
  modelID: string,
  existing: ModelRouteHealth | undefined,
  now: number,
): { routeKey: string; health: ModelRouteHealth } {
  return buildRouteHealthEntry(
    providerID,
    modelID,
    "model_not_found",
    ROUTE_MODEL_NOT_FOUND_DURATION_MS,
    existing,
    now,
  );
}

/**
 * Decide whether an `assistant.message.completed` event's `tokens`
 * payload represents the canonical "silent quota exhaustion" signal
 * that should fire a route-level `quota` penalty.
 *
 * History: the `assistant.message.completed` handler tested
 * `tokens.input === 0 && tokens.output === 0` and unconditionally
 * penalized the route with a 1h quota backoff on match. That predicate
 * is too narrow: it covers only the two primary billing axes and
 * ignores every other token counter opencode may expose (`reasoning`
 * for deep-thinking models, nested `cache.read` / `cache.write`, and
 * future counters added by upstream providers).
 *
 * Failure shape: a successful deep-reasoning turn on `kimi-k2-thinking`
 * / `minimax-m2.7` / `cogito-2.1` — the exact three models the handler
 * docstring already cites as routinely running 200+ tool calls — can
 * plausibly report `{input: 0, output: 0, reasoning: N>0}` (zero
 * billing on the primary axes because the work happened in the
 * reasoning channel). The old predicate would see `input=0, output=0`,
 * ignore `reasoning`, and penalize the route as quota-exhausted on a
 * SUCCESSFUL completion. The route would flip to 1h backoff, the
 * retryCount would tick, and the next session would bypass a healthy
 * model for one cited as a premier deep-reasoning combatant in the
 * user's catalog. Even if current opencode versions don't populate
 * `reasoning` at this event, a future opencode release that does would
 * silently start corrupting health state the moment it lands — the
 * defensive predicate insulates against that.
 *
 * The correct signal is "every numeric counter is zero" — a genuine
 * silent-failure turn produces nothing on any axis. Walk the
 * top-level numeric properties and any one-level-nested object values
 * (to handle shapes like `cache: {read, write}`). Any non-zero number
 * means real activity occurred and the quota signal must be suppressed.
 *
 * The helper is pure so it is unit-testable without any live health
 * maps or opencode runtime event payloads.
 *
 * Args:
 *   tokens: The `tokens` field from `assistant.message.completed`,
 *     as an unknown-shaped record.
 *
 * Returns:
 *   `true` when all numeric counters (top-level and one-level nested)
 *   are zero. `false` otherwise.
 *
 * ## Drift surfaces (M109 PDD)
 *
 * The nine pre-existing pins cover the primary-axis short-circuit, the
 * top-level sibling counter check (reasoning), nested cache.read /
 * cache.write counters, the nested-empty-object-is-true path, and a
 * top-level non-numeric string field. Three surfaces have zero direct
 * coverage and each has a plausible regression:
 *
 * 1. **Nested `value && typeof === "object"` guards against `null`.**
 *    The inner walk iterates `Object.values(tokens)` and descends into
 *    any value that is both truthy AND `typeof === "object"`. The
 *    truthy guard is load-bearing: `typeof null === "object"` in
 *    JavaScript, so without the `value &&` short-circuit a `cache:
 *    null` token field would invoke `Object.values(null)` and throw
 *    `TypeError: Cannot convert undefined or null to object` from
 *    inside the `assistant.message.completed` hook — which the plugin
 *    catches via `logPluginHookFailure` and swallows, but the effect
 *    is that the quota classifier silently no-ops on any event whose
 *    `tokens` field contains a null nested record. A refactor that
 *    "simplified" the guard to `typeof value === "object"` (dropping
 *    the `value &&` half because "typeof already handles objects")
 *    would flip every null-containing token payload from a
 *    well-defined `true` return to a silent exception. The nine
 *    existing pins all use concrete objects or omit the nested field;
 *    none exercises the null-typeof-object foot-gun.
 *
 * 2. **NaN top-level counter is treated as non-zero → `false`.** The
 *    top-level number check is `if (value !== 0) return false;` —
 *    `NaN !== 0` evaluates to `true` (NaN is not equal to anything,
 *    including itself), so a NaN reasoning counter hits the `return
 *    false` path. The current semantic is "any ambiguous top-level
 *    number is conservatively treated as real activity and the
 *    quota penalty is NOT applied." A defensive refactor that added
 *    `Number.isFinite(value) && value !== 0` to "skip NaN because it
 *    represents a missing counter" would flip the behavior: NaN
 *    fields would be ignored, and a session whose only non-zero
 *    counter was NaN would be classified as silent quota exhaustion
 *    and quarantine a healthy route. None of the existing pins uses
 *    NaN at any position — the `!== 0` semantic over NaN is unpinned.
 *
 * 3. **Nested non-numeric field is ignored, not rejected.** The
 *    nested walker checks `if (typeof nestedValue === "number" &&
 *    nestedValue !== 0) return false;` — anything that is NOT a number
 *    (string, boolean, nested object, null) is skipped without
 *    affecting the return value. Pin #8 (top-level string) exercises
 *    the analogous top-level branch, but the nested branch's
 *    non-number skip is untested: a `cache: { backend: "redis" }`
 *    field must NOT cause the classifier to think the cache had
 *    activity just because the field is truthy. A future refactor
 *    that "tightened" the nested walker to reject any unexpected type
 *    as a safety measure would silently flip every debug/metadata
 *    field in nested token records from inert to quota-penalizing.
 */
export function isZeroTokenQuotaSignal(tokens: Record<string, unknown>): boolean {
  if (tokens.input !== 0 || tokens.output !== 0) {
    return false;
  }
  for (const value of Object.values(tokens)) {
    if (typeof value === "number") {
      if (value !== 0) return false;
      continue;
    }
    if (value && typeof value === "object") {
      for (const nestedValue of Object.values(value as Record<string, unknown>)) {
        if (typeof nestedValue === "number" && nestedValue !== 0) {
          return false;
        }
      }
    }
  }
  return true;
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
 *
 * ## Drift surfaces (M127 PDD)
 *
 * Three orthogonal invariants beyond the 10 existing pins. Each drifts
 * silently under a plausible refactor that leaves every other pin green:
 *
 *   1. **`NO_CREDIT_KEYWORDS` membership — `"payment"` specifically.**
 *      The keyword set contains `"insufficient credits"`, `"no credit"`,
 *      `"payment"`, `"billing"`. Existing pins exercise the first two but
 *      NOT `"payment"` or `"billing"` on their own. A drive-by cleanup
 *      ("the first two substrings are sufficient, the others are dead
 *      weight") that deletes `"payment"` from the list silently reclassifies
 *      every `"payment required"` upstream body as `"unclassified"` instead
 *      of `"no_credit"`. Callers skip penalty application on unclassified,
 *      so a genuinely out-of-credit provider keeps receiving live traffic
 *      indefinitely — the exact pre-M45 failure mode, reached through a
 *      different dictionary delete. Pin: `statusCode=0,
 *      lowerMessage="payment required on this account"` → `"no_credit"`.
 *
 *   2. **`KEY_DEAD_HTTP_STATUS_CODES` membership — bare 403 alone.**
 *      The status-code set is `{401, 403}`. The existing 403 pin is
 *      `classifyProviderApiError(403, "quota exceeded for this api key")`,
 *      which still classifies as `key_dead` even if 403 is removed from
 *      the set — because `"quota"` in the message falls through to the
 *      keyword cascade. So the 403-in-set membership is not actually
 *      pinned by that test. A future "tighten to just 401, 403 is
 *      ambiguous in practice" refactor would delete 403 from the set
 *      without failing a single existing test, and every bare-403
 *      "forbidden" response (cleaned proxy, CDN edge block, OAuth scope
 *      mismatch) would silently slide into `"unclassified"` — the dead
 *      key cycles through retries with no quarantine. Pin: `statusCode=403,
 *      lowerMessage="service unavailable"` → `"key_dead"`.
 *
 *   3. **Case-sensitivity contract — `lowerMessage` parameter is trusted.**
 *      The implementation uses `String.prototype.includes` which is
 *      case-sensitive. The parameter name `lowerMessage` documents the
 *      precondition: callers MUST lowercase at the call site. Every
 *      existing pin passes already-lowercase input, so none catches a
 *      "defensive" refactor that adds an internal `.toLowerCase()`.
 *      That sounds harmless but breaks the *contract direction*: once
 *      the helper lowercases internally, a new caller that forgot the
 *      precondition still works, so the convention erodes, then a
 *      future reader passes a locale-sensitive string (Turkish `İ`
 *      → `i̇`) and the cascade misclassifies for the Turkish `"RATE
 *      LIMIT"` input that now normalizes differently. More immediately
 *      concerning: a caller that already pre-lowercases cannot be
 *      trusted to ALSO pre-trim or pre-normalize whitespace, so the
 *      helper implicitly accumulates responsibilities one defensive
 *      branch at a time. The pin freezes the case-sensitive contract
 *      so any internal `.toLowerCase()` addition fails a concrete
 *      assertion. Pin: `statusCode=0, lowerMessage="RATE LIMIT EXCEEDED"`
 *      → `"unclassified"` (uppercase input must not match the
 *      lower-case keyword set).
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
 * Return `true` when a single provider route is currently routable: its
 * provider has no active penalty AND its composite `provider/model-id`
 * route-health entry is expired or absent.
 *
 * This is the canonical "is this route healthy right now" predicate. Six
 * call sites in this file used to inline the same two-step check
 * (`isProviderHealthy` then `modelRouteHealthMap.get(composeRouteKey(...))`)
 * — `findFirstHealthyRouteInEntry`, `findFirstHealthyVisibleRoute`,
 * `summarizeVisibleRouteHealth`, the `isRouteHealthy` lambdas inside
 * `findPreferredHealthyRoute` and `buildRoleRecommendationRoutes`, and the
 * `bestRouteIsHealthy` lambda inside `recommendTaskModelRoute`. Every time
 * the predicate gained a new clause (M29 added route-level health, M31
 * added composite route keys, M61 centralized the per-entry walk), SOME
 * sites were updated and others silently drifted until a user hit the
 * gap.
 *
 * Centralizing the predicate here gives all six readers the same answer
 * by construction, not by convention. `findCuratedFallbackRoute`
 * deliberately does NOT use this helper — it adds an additional
 * `isFallbackBlocked` check because "is this route a valid FALLBACK" is a
 * strictly stronger question than "is this route routable" (a curated
 * entry whose primary is `longcat` is legitimately routable for agents
 * that explicitly want longcat, but must never be chosen as a silent
 * fallback from a different model). Keep that divergence explicit so the
 * two predicates can evolve independently.
 *
 * Args:
 *   providerRoute: The route to check. Only `provider` and `model` fields
 *     are read (the full `ProviderRoute` shape is accepted for caller
 *     convenience — no need to destructure at the call site).
 *   providerHealthMap: In-memory provider-keyed health map.
 *   modelRouteHealthMap: In-memory composite-route-keyed health map.
 *   now: Wall-clock timestamp in ms.
 *
 * Returns:
 *   `true` when both provider and route health checks pass, `false`
 *   otherwise.
 */
export function isRouteCurrentlyHealthy(
  providerRoute: { provider: string; model: string },
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): boolean {
  if (!isProviderHealthy(providerHealthMap, providerRoute.provider, now)) {
    return false;
  }
  const routeHealth = modelRouteHealthMap.get(composeRouteKey(providerRoute));
  return !routeHealth || routeHealth.until <= now;
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
 *
 * ## Drift surfaces (M119 PDD)
 *
 * The three load-bearing lines of the body — (1) the
 * `filterVisibleProviderRoutes(entry.provider_order)` gate, (2) the
 * exclusive `if / else` counter pair, (3) the per-route
 * `isRouteCurrentlyHealthy(...)` call — each sit on top of one
 * orthogonal production invariant, and all three are reachable from the
 * `selectBestModelForRoleAndTask` comparator that ranks every role/task
 * query in the plugin. The two pre-existing pins exercise mixed-state
 * route fixtures and assert exact `{healthy, unhealthy}` totals, but
 * their sabotage signatures are not orthogonal — a refactor that
 * touches any of the three lines flips the same pair of counts, which
 * means a failure message cannot tell an engineer WHICH invariant
 * broke. These three drift surfaces partition the failure modes:
 *
 *  1. **`filterVisibleProviderRoutes` gating.** The walk MUST iterate
 *     the FILTERED route set. Hidden routes (paid openrouter
 *     non-`:free`, `cloudflare-ai-gateway`, `togetherai`, `cerebras`,
 *     `xai`, `deepseek`, `github-copilot`, `minimax-cn*`, openrouter
 *     `auto` / `bodybuilder/*` / `openrouter/free` meta models) are
 *     filtered out at every OTHER visibility site in this plugin, so
 *     letting them leak into the ranking comparator via this helper
 *     would silently restore paid/deprecated routes to the routing
 *     decision even though every renderer, health-report, and fallback
 *     path treats them as non-existent. A refactor that drops
 *     `filterVisibleProviderRoutes` and iterates `entry.provider_order`
 *     directly inflates BOTH `healthy` and `unhealthy` with routes the
 *     operator pinned as hidden — and because the comparator sorts by
 *     `healthy` descending, an entry with two hidden paid routes would
 *     suddenly out-rank an entry with zero hidden routes on a tie that
 *     nothing in the agent-visible registry explains.
 *
 *  2. **Exclusive `if / else` counter pair.** Every visible route must
 *     increment exactly ONE of the two counters — no drops, no
 *     double-counts. A refactor that drops the `else` clause (e.g. a
 *     "simplification" that keeps only `if (isRouteCurrentlyHealthy)
 *     healthy++;`) silently pins every entry's `unhealthy` to zero,
 *     which breaks the M40-regression tiebreaker (a `1 healthy / 0
 *     dead` candidate should beat a `1 healthy / 1 dead` candidate —
 *     but with `unhealthy` wedged at zero, both tie on both keys and
 *     the dirty candidate wins on the billing-preference fallback). A
 *     refactor that replaces `else` with a second independent `if
 *     (!isRouteCurrentlyHealthy)` is equivalent in intent but at risk
 *     of being further "simplified" to `if (isProviderHealthy === false)`
 *     or similar, which collapses the counts asymmetrically.
 *
 *  3. **Per-route composite `isRouteCurrentlyHealthy` check.** The
 *     per-route health predicate must consult BOTH halves of the
 *     dual-map architecture: the provider-level `providerHealthMap`
 *     via `isProviderHealthy` AND the composite-route
 *     `modelRouteHealthMap` via `composeRouteKey(route)` lookup. A
 *     refactor that "simplifies" to `isProviderHealthy(providerHealthMap,
 *     route.provider, now)` drops the route-level half entirely, and
 *     routes with an active `model_not_found` or `timeout` penalty but
 *     a healthy provider are re-counted as healthy. The dead route
 *     re-enters the fallback cascade on the very next turn, hits the
 *     same composite-key penalty, and the loop continues until the 1h
 *     route-level backoff expires — a silent regression of the M42
 *     composite-key dual-map split.
 *
 * Each surface lives on one line of the seven-line body. The three
 * surfaces are orthogonal: a sabotage on line 1 cannot fire pins
 * designed for surfaces 2 or 3, and vice versa. The body is
 * bitwise-unchanged — documentation and pins only.
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
    if (isRouteCurrentlyHealthy(route, providerHealthMap, modelRouteHealthMap, now)) {
      healthy++;
    } else {
      unhealthy++;
    }
  }
  return { healthy, unhealthy };
}

/**
 * Drop a terminating session from all three per-session hang-detection
 * maps. Read-side and delete-side counterpart of `bindSessionHangState`
 * (which writes the same three maps) and `readAndClearSessionHangState`
 * (M78; which atomically consumes-and-clears during hang resolution).
 *
 * ## Drift surfaces (M118 PDD)
 *
 * The triplet looks trivial — three `.delete()` calls on three maps —
 * but each line is load-bearing for an orthogonal failure mode, and
 * dropping any one line fails **silently** in production. The single
 * pre-existing pin at `clearSessionHangState_whenSessionTerminates_
 * dropsFromAllThreeSessionMaps` asserts all three deletes happen in one
 * bundled test, which means every sabotage of any single delete fires
 * the same pin — symmetric, not asymmetric — so an engineer running a
 * focused regression cannot tell from the failure message which of the
 * three invariants actually broke. These three surfaces partition the
 * failure modes so a sabotage of exactly one delete fires exactly one
 * new pin uniquely, restoring the asymmetric-pin locality the M68/M75
 * durability-pair protocol requires.
 *
 *  1. **`sessionStartTimeMap.delete` — start-time entry leak.**
 *     `sessionStartTimeMap` is the only map the hang finalizer
 *     (`finalizeHungSessionState`) reads to compute the elapsed-ms
 *     delta against `Date.now()`. A dropped delete on this map leaks
 *     one entry per completed session for the lifetime of the plugin
 *     process, which is hours-to-days in long-running autopilot
 *     workers. Not an immediate correctness bug (the hang timer
 *     short-circuits on a missing start-time, and the next
 *     `bindSessionHangState` call for a reused sessionID will overwrite
 *     the leaked entry), but the unbounded-growth class that already
 *     shipped once before M65 and triggered a 6h autopilot OOM loop.
 *
 *  2. **`sessionActiveProviderMap.delete` — stale provider binding.**
 *     This map answers "which provider is this session currently
 *     running against" for the hang finalizer's penalty-recording
 *     path. A dropped delete leaves the OLD session's provider ID
 *     bound to a sessionID that has completed; when the next turn for
 *     a DIFFERENT session reuses the same sessionID slot and its own
 *     `bindSessionHangState` runs, the overwrite is benign — but
 *     between completion and the next bind, a hang timer firing on the
 *     completed session would record a `timeout` penalty against the
 *     stale provider, quarantining a provider that had nothing to do
 *     with the hang. Routes flap off and back on for no visible reason.
 *
 *  3. **`sessionActiveModelMap.delete` — stale model tuple binding.**
 *     Same failure mode as surface 2, one layer deeper: this map
 *     carries the `{id, providerID}` composite the finalizer uses to
 *     compose the route-level `composeRouteKey` for the penalty. A
 *     dropped delete produces a spurious route-level `timeout` penalty
 *     against a `provider/model` key that the completed session was
 *     NOT using — the hang-penalty record lands in the wrong slot of
 *     `modelRouteHealthMap`, `findCuratedFallbackRoute` then skips an
 *     innocent route on the next turn, and the fallback cascade drifts
 *     away from the curated priority order for the 15-minute timeout
 *     window.
 *
 * Each surface lives on one line. The three surfaces are independent,
 * orthogonal, and each failure is invisible under production logging
 * until the leaked/stale state cascades into its secondary effect
 * hours later. The helper body is bitwise-unchanged — documentation
 * and pins only.
 *
 * Args:
 *   sessionID: The terminating session's identifier.
 *   sessionStartTimeMap / sessionActiveProviderMap / sessionActiveModelMap:
 *     The three per-session hang-detection maps — all three mutated
 *     in-place.
 */
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
 * Populate all three per-session hang-detection maps for a starting turn.
 *
 * Write-side counterpart to `readAndClearSessionHangState` (M78) and
 * `clearSessionHangState`: the three helpers form a complete triplet
 * for every lifecycle operation on the session hang state, so no call
 * site needs to know which three maps are involved. Prior to this
 * helper the `chat.params` hook inlined three `Map.set` calls at its
 * top — a future edit that added a fourth map (e.g. per-session tool
 * budget, per-session fallback depth) or dropped one of the three
 * would silently desynchronise the triplet. The hang detector
 * short-circuits on missing `sessionStartTimeMap` entries, so dropping
 * just that write would disarm the hang timer without any visible
 * error. Dropping the provider or model write would leave the hang
 * timer to fire with `undefined` bindings, which
 * `finalizeHungSessionState` handles but which produces a silently
 * unrecorded timeout penalty.
 *
 * Encoding the triplet inside a single helper makes "three maps move
 * together" a property of the function body instead of a property
 * every call site must preserve by hand. The `chat.params` hook is
 * the only current writer, but any future caller (e.g. a session
 * restart hook) can route through this helper and inherit the
 * invariant for free.
 *
 * ## Drift surfaces (M120 PDD)
 *
 * The three `.set` lines look symmetrical but each one is load-bearing
 * for an orthogonal hang-detection failure mode, and the pre-existing
 * M79 symmetry pin `bindSessionHangState_whenCalled_populatesAllThree
 * MapsAtomically` asserts all three `.get` values in one bundled test
 * (self-described as a "symmetry pin"). That means every one-line
 * sabotage fires the SAME pin — an engineer running a focused
 * regression cannot tell from the failure message which specific
 * `.set` broke. These three surfaces partition the failure modes so a
 * sabotage of exactly one `.set` call fires exactly one new pin
 * uniquely, restoring asymmetric-pin locality:
 *
 *  1. **`sessionActiveProviderMap.set` — provider binding write.**
 *     The first `.set` in the triplet wires the per-session
 *     provider identifier that `readAndClearSessionHangState` snapshots
 *     before the terminal clear, and that the hang finalizer uses to
 *     compose the provider side of a `timeout` penalty's composite
 *     route key. A dropped write leaves `sessionActiveProviderMap.get
 *     (sessionID)` returning `undefined`, the downstream
 *     `composeRouteKey({provider: undefined, model: ...})` builds a
 *     pathological `"undefined/<model>"` composite that no
 *     `modelRouteHealthMap` entry matches, and the hang penalty lands
 *     under a key no reader ever queries — a silently-unrecorded
 *     timeout the agent cannot route around.
 *
 *  2. **`sessionActiveModelMap.set` — model tuple binding write.**
 *     The second `.set` wires the `{id, providerID}` model tuple,
 *     which the hang finalizer composes with the provider binding
 *     from surface 1 to build the composite route key. A dropped
 *     write symmetrically produces `"<provider>/undefined"` via
 *     `composeRouteKey` — same class of silently-unrecorded timeout
 *     penalty as surface 1, one field deeper in the composite.
 *
 *  3. **`sessionStartTimeMap.set` — start-time anchor write.** The
 *     third `.set` wires the wall-clock anchor that the hang timer's
 *     `setTimeout` callback reads to compute `elapsedMs =
 *     Date.now() - sessionStart`. A dropped write leaves the
 *     start-time map without an entry for this session — the hang
 *     finalizer's `sessionStartTimeMap.get(sessionID)` short-circuits
 *     to `undefined`, the `elapsedMs` computation yields `NaN`, and
 *     `shouldRecordImmediateTimeoutPenalty` / the hang-window check
 *     early-return without recording any penalty. The hang timer was
 *     armed but the penalty-recording branch it enables is DOA — a
 *     silent disarm class that looks like "no hang detected" to the
 *     rest of the plugin.
 *
 * Each surface lives on one line of the three-line body. A sabotage
 * that drops exactly one `.set` call fires exactly one new pin
 * uniquely, while the pre-existing bundled symmetry pin fires on all
 * three as additive coverage. The body is bitwise-unchanged —
 * documentation and pins only.
 *
 * Args:
 *   sessionID: The turn's session identifier.
 *   providerID: The provider id from `input.provider.info.id`.
 *   model: The `{id, providerID}` tuple from `input.model`.
 *   now: Current epoch millis for the start-time map — injected for
 *     deterministic testing instead of reading `Date.now()` inside
 *     the helper.
 *   sessionStartTimeMap / sessionActiveProviderMap / sessionActiveModelMap:
 *     The three per-session hang-detection maps — all three mutated
 *     in-place.
 */
export function bindSessionHangState(
  sessionID: string,
  providerID: string,
  model: { id: string; providerID: string },
  now: number,
  sessionStartTimeMap: Map<string, number>,
  sessionActiveProviderMap: Map<string, string>,
  sessionActiveModelMap: Map<string, { id: string; providerID: string }>,
): void {
  sessionActiveProviderMap.set(sessionID, providerID);
  sessionActiveModelMap.set(sessionID, model);
  sessionStartTimeMap.set(sessionID, now);
}

/**
 * Snapshot the per-session provider/model tuple AND clear all three
 * hang-detection maps in a single atomic step.
 *
 * Motivation — ordering drift: the `session.error` and
 * `assistant.message.completed` hooks both need to read the session's
 * provider/model binding BEFORE clearing the maps, otherwise the reads
 * come back `undefined` and the classification branch silently early-
 * returns with no health penalty recorded. Prior to this helper both
 * hooks inlined the same four-line `read → read → clear(4 args)` ritual,
 * and a future edit that accidentally swapped the order at one site
 * would produce no test failure and no runtime error — a quota-exhausted
 * provider would simply stop being quarantined.
 *
 * Encoding the invariant inside a single helper makes "read before
 * clear" a property of the function body instead of a property each
 * call site must preserve by hand. The `session.error` site still
 * overlays its own `(sessionError as any).model ?? mappedModel` fallback
 * externally — the helper stays minimal and returns the mapped tuple
 * verbatim so that asymmetric behaviour lives at the call site, not
 * inside shared code.
 *
 * Args:
 *   sessionID: The session identifier being finalised.
 *   sessionStartTimeMap / sessionActiveProviderMap / sessionActiveModelMap:
 *     The three per-session hang-detection maps — mutated in-place by
 *     the embedded `clearSessionHangState` call.
 *
 * Returns:
 *   `{ providerID, model }` read from the maps BEFORE they were cleared.
 *   Either field may be `undefined` if the session was never fully
 *   bound (e.g. the chat.params hook short-circuited before writing the
 *   model map).
 */
/**
 * Snapshot the per-session provider/model tuple AND clear all three
 * hang-detection maps in a single atomic step — the read side of the M78
 * "read-then-clear" pair used by every terminal session handler.
 *
 * ## Drift surfaces (M121 PDD)
 *
 * The body is four statements but each of the three load-bearing lines
 * carries one orthogonal production invariant, and the three pre-existing
 * M78 pins bundle ordering + map-membership + delegation checks in every
 * test — so any single-line sabotage fires MULTIPLE pre-existing pins at
 * once, leaving failure messages unable to localise which invariant broke.
 * M121 adds three asymmetric pins that each fire on exactly one surface:
 *
 *   (1) **`sessionActiveProviderMap.get(sessionID)` read.** This is the
 *       provider-half of the `{providerID, model}` tuple consumed by the
 *       two terminal event handlers (`session.error`,
 *       `assistant.message.completed`) to attribute timeout/classification
 *       penalties to the correct composite route key. A drift that drops
 *       the read (or reorders it AFTER the `clearSessionHangState` call —
 *       the M78 motivating regression) causes `.get` to return `undefined`
 *       from an already-cleared map, the returned tuple's `providerID`
 *       collapses to `undefined`, and every downstream classification
 *       branch early-returns with no penalty. The bug is silent: no
 *       runtime error, no type error (the return type already admits
 *       `undefined`), and the pre-existing bundled pins fire but do not
 *       distinguish this failure from a dropped delegation or a dropped
 *       model read.
 *
 *   (2) **`sessionActiveModelMap.get(sessionID)` read.** The model-half of
 *       the same tuple. Drives the `composeRouteKey` model side in the
 *       downstream route-level penalty recording (M42 dual-map split). A
 *       drift that drops the read — or reorders it after the clear —
 *       leaves route-level penalty recording degrading to provider-only
 *       attribution, letting a single bad `{provider, model}` pair drag
 *       down every other model hosted by the same provider at the health
 *       ranking layer. Orthogonal to surface (1) because a caller that
 *       populated only the model map (not the provider map) still expects
 *       the model half of the tuple to round-trip cleanly.
 *
 *   (3) **`clearSessionHangState(...)` delegation call.** Must be called
 *       AFTER both reads to drop all three map entries and prevent the
 *       session-state leak documented in `finalizeHungSessionState`. A
 *       drift that drops the delegation entirely (inlining only a subset
 *       of the three `.delete` lines, or "optimising" it away on the
 *       theory that the caller will clear the maps) silently leaks
 *       per-session tuples — tiny (~150 bytes each) but unbounded because
 *       the M78 single-call-site guarantee means this is the ONLY place
 *       the maps get cleared on the silent-death path. Orthogonal to
 *       surfaces (1) and (2) because the return tuple can still be
 *       bitwise-correct while the maps leak: the reads happened, the
 *       tuple was assembled, the clear never fired.
 *
 * ## Body contract
 *
 * Bitwise-identical to pre-M121. Four statements, three orthogonal
 * drift surfaces, asymmetric pins at `readAndClearSessionHangState_
 * whenOnlyProviderMapPopulated_returnsProviderAfterRead`,
 * `..._whenOnlyModelMapPopulated_returnsModelAfterRead`, and
 * `..._whenAllMapsPopulated_delegationClearsStartTimeMap`.
 *
 * Args:
 *   sessionID: The session id whose hang-detection state is being read
 *     and evicted. Unknown ids are total — the helper returns
 *     `{undefined, undefined}` and the delegation no-ops on absent keys.
 *   sessionStartTimeMap / sessionActiveProviderMap / sessionActiveModelMap:
 *     The three per-session hang-detection maps. All three are mutated
 *     in-place via the delegated `clearSessionHangState` call.
 *
 * Returns:
 *   `{providerID, model}` snapshotted BEFORE the clear call. Either
 *   field may be `undefined` when the caller populated only a subset of
 *   the three maps (silent-death path, double-fire, or short-circuited
 *   `chat.params` hook that bound provider before model).
 */
export function readAndClearSessionHangState(
  sessionID: string,
  sessionStartTimeMap: Map<string, number>,
  sessionActiveProviderMap: Map<string, string>,
  sessionActiveModelMap: Map<string, { id: string; providerID: string }>,
): {
  providerID: string | undefined;
  model: { id: string; providerID: string } | undefined;
} {
  const providerID = sessionActiveProviderMap.get(sessionID);
  const model = sessionActiveModelMap.get(sessionID);
  clearSessionHangState(
    sessionID,
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
  );
  return { providerID, model };
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
 * End-to-end hang-timer wrapper: evaluate whether the session hung,
 * clear its per-session state, and (if a penalty was produced) write it
 * through the M68 `recordRouteHealthPenalty` pair — as one atomic
 * operation.
 *
 * ## Drift shape this closes
 *
 * The `chat.params` hang-timer `setTimeout` callback inlined the
 * two-step ritual by hand:
 *
 *     const result = finalizeHungSessionState(...);
 *     if (!result) return;
 *     recordRouteHealthPenalty(
 *       modelRouteHealthMap, providerHealthMap,
 *       result.routeKey, result.health, persistProviderHealth,
 *     );
 *
 * Three steps, each with its own failure mode:
 *
 *   - Forgetting the `if (!result) return` guard → `recordRouteHealthPenalty`
 *     runs with null fields and throws inside the setTimeout closure,
 *     which is async-isolated and has no surrounding handler; the crash
 *     silently lost AND Node's default unhandledRejection behavior
 *     emits noise in prod logs.
 *   - Forgetting to call `recordRouteHealthPenalty` at all → the hang
 *     was detected, per-session state was cleared, but the penalty was
 *     never persisted. The next identical hang would re-accrue on the
 *     same route with no backoff — infinite retry on a dead
 *     long-reasoning endpoint. This is the worst failure mode because
 *     it silently degrades the backoff contract.
 *   - Mixing up the `finalizeHungSessionState` return shape with the
 *     arguments to `recordRouteHealthPenalty` (e.g. passing
 *     `result.health` as `routeKey`) → compile-time error if typed,
 *     runtime write-to-wrong-key bug if untyped. TypeScript catches it
 *     today, but the shape-pairing is another surface for future drift.
 *
 * The wrapper collapses all three steps into one call, guarantees the
 * null-check is never forgotten, and lets the test harness pin the
 * "finalize returned non-null → record MUST fire" contract with a spy.
 *
 * ## Why a wrapper, not a rewrite of `finalizeHungSessionState`
 *
 * `finalizeHungSessionState` is a pure function that returns the
 * computed penalty so its existing unit tests can pin the
 * computation-and-cleanup contract without coupling to the durability
 * layer. Rewriting it to perform the write internally would force
 * every test to pass a stub persister and a fresh `providerHealthMap`,
 * blurring the "compute vs persist" boundary. The wrapper sits on top
 * and adds the durability step, keeping the pure/impure split clean.
 *
 * Args:
 *   sessionID: Opaque session identifier.
 *   sessionStartTimeMap: Turn-start timestamp map.
 *   sessionActiveProviderMap: Provider-id-per-session map.
 *   sessionActiveModelMap: Active model-per-session map.
 *   modelRouteHealthMap: Route-level health map (mutated when penalty
 *     is recorded).
 *   providerHealthMap: Provider-level health map (threaded for the
 *     atomic-snapshot shape).
 *   timeoutMs: Hang-timeout threshold.
 *   now: Wall-clock timestamp in ms.
 *   persistFn: Injected persister (production passes
 *     `persistProviderHealth`; tests pass a spy).
 */
export function finalizeHungSessionStateAndRecordPenalty(
  sessionID: string,
  sessionStartTimeMap: Map<string, number>,
  sessionActiveProviderMap: Map<string, string>,
  sessionActiveModelMap: Map<string, { id: string; providerID: string }>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  providerHealthMap: Map<string, ProviderHealth>,
  timeoutMs: number,
  now: number,
  persistFn: PersistProviderHealthFn,
): void {
  const result = finalizeHungSessionState(
    sessionID,
    sessionStartTimeMap,
    sessionActiveProviderMap,
    sessionActiveModelMap,
    modelRouteHealthMap,
    timeoutMs,
    now,
  );
  if (result === null) return;
  recordRouteHealthPenalty(
    modelRouteHealthMap,
    providerHealthMap,
    result.routeKey,
    result.health,
    persistFn,
  );
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
    lookupRouteHealthByIdentifiers(modelRouteHealthMap, providerID, model.id),
    now,
  );
}

/**
 * Resolve the first curated-and-currently-routable fallback route for a
 * registry entry whose primary route has been knocked offline, used
 * exclusively by `buildProviderHealthSystemPrompt` to populate the
 * agent-visible "Curated fallbacks" bullet list in every provider-penalty
 * and route-penalty section of the system prompt.
 *
 * ## Three independent drift surfaces
 *
 * Beyond the two surfaces already pinned by the existing regression tests
 * (`_whenNextRouteIsHiddenPaidProvider_skipsToVisibleRoute` pins the
 * `filterVisibleProviderRoutes` integration for hidden paid providers;
 * `_whenRouteIsMarkedUnhealthyAtRouteLevel_skipsIt` pins the route-level
 * health predicate via `isRouteCurrentlyHealthy`), three further drift
 * surfaces live on this helper and have zero direct coverage:
 *
 *   1. **`blockedProviderID` early-filter.** The caller passes the ID of
 *      the provider whose blowup triggered the penalty section — e.g.
 *      `buildProviderHealthSystemPrompt` passes `providerID` when
 *      rendering a provider-level penalty section. The loop's first
 *      filter clause (`if (providerRoute.provider === blockedProviderID)
 *      return false;`) ensures that even if `isProviderHealthy` would
 *      return `true` for that provider (e.g. the penalty hasn't been
 *      recorded in `providerHealthMap` yet because the caller is mid-flow
 *      between detection and persistence, or because the caller
 *      deliberately wants to force-skip a specific provider without
 *      mutating the maps), the blocked provider's routes are still
 *      removed from candidacy. A refactor that drops this clause
 *      ("isProviderHealthy already handles this, the check is
 *      redundant") silently regresses the call sites that rely on the
 *      force-skip semantic: the "Curated fallback for X" line could
 *      recommend the same provider that just blew up, directly
 *      contradicting the penalty banner one line above it.
 *
 *   2. **`isFallbackBlocked` proprietary-brand blocklist.** The second
 *      filter clause excludes any route whose provider OR model matches
 *      the proprietary-brand blocklist (longcat, anthropic, openai, xai,
 *      github-copilot provider IDs plus `/longcat/i`, `/claude/i`,
 *      `/\bgpt-?\d/i`, `/\bchatgpt/i`, `/\bgrok-?\d/i` model patterns).
 *      These are brands the user's curation policy forbids from EVER
 *      being suggested as a silent fallback — the agent should be
 *      routed to an open-weights alternative, not silently upgraded to a
 *      proprietary model mid-session. Crucially, `filterVisibleProviderRoutes`
 *      alone does NOT close this gap: a route like
 *      `openrouter/anthropic/claude-3.5-sonnet:free` is both VISIBLE
 *      (ends in `:free`) and BLOCKED (matches `/claude/i`), so dropping
 *      the `isFallbackBlocked` clause silently lets the curated-fallback
 *      suggester recommend a proprietary claude route through the
 *      openrouter `:free` backdoor. A refactor that collapses the two
 *      filters into one ("they both mean 'skip this route'") erases the
 *      brand-policy layer entirely.
 *
 *   3. **`NO_FALLBACK_MODEL_CONFIGURED_MESSAGE` sentinel return.** When
 *      every visible route is disqualified (all providers unhealthy,
 *      all routes route-level-blocked, all fallback-blocked, or all
 *      blockedProviderID-matched), the helper returns the literal
 *      sentinel string `"no fallback configured"` rather than `null`,
 *      empty string, or `undefined`. This string is directly
 *      interpolated into the system-prompt bullet list as
 *      `- ${entry.id} → ${fallback}`, and the agent is trained to read
 *      `"no fallback configured"` as "do not retry, escalate to the
 *      user or wait for the backoff window." A refactor that changes
 *      the sentinel to `""` produces agent-visible lines like
 *      `- mimo-v2-pro → ` with a trailing space and no target, which
 *      the agent may interpret as a truncated render / system-prompt
 *      corruption and retry the blowing-up route anyway. A refactor
 *      that changes the sentinel to `null` crashes the template
 *      literal into `"null"`, which is even worse. The sentinel string
 *      is a contract with the agent's interpretation layer, not a
 *      free-floating error code.
 *
 * ## Why a thin docstring rather than three new helpers
 *
 * The helper body is already seven lines of dense policy and breaking
 * it into three sub-helpers (`isBlockedProvider` / `isBrandBlocked` /
 * `renderNoFallbackSentinel`) would atomize logic that only ever
 * appears together at this one call site. The three surfaces are
 * drift-prone because they are conventions of one `find` callback
 * and one early-return sentinel, not because they share code with any
 * other function in the plugin. Documenting them as properties of
 * this helper with dedicated regression pins is the minimal
 * intervention that closes the drift without adding plumbing.
 *
 * Args:
 *   modelRegistryEntry: The registry row whose primary route has been
 *     knocked offline; the helper scans this entry's `provider_order`
 *     in authored order for the first viable fallback.
 *   blockedProviderID: The provider ID to force-skip even if healthy.
 *     Pass `""` to disable the force-skip semantic (route-health checks
 *     remain active regardless).
 *   providerHealthMap: Live provider-keyed health map, consulted via
 *     `isRouteCurrentlyHealthy`.
 *   modelRouteHealthMap: Live composite-route-keyed health map, also
 *     consulted via `isRouteCurrentlyHealthy`.
 *   now: Wall-clock ms used for the health expiry comparison.
 *
 * Returns:
 *   The composite `provider/model-id` string of the first route that
 *   passes all three filters plus `isRouteCurrentlyHealthy`, or the
 *   literal sentinel `"no fallback configured"` when no route qualifies.
 *   The returned string is already in composite form (the helper reads
 *   it from `provider_order[].model` rather than re-composing it, per
 *   the body comment's double-prefix regression note at M31).
 */
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
  // M66: the provider-healthy + route-expired suffix is exactly
  // `isRouteCurrentlyHealthy`. The M64 dedupe-helper docstring
  // deliberately left this site inline because the two upfront
  // guards (`blockedProviderID`, `isFallbackBlocked`) are strictly
  // stronger than the canonical predicate. But those extras are
  // prefix filters — if they pass, the tail IS the canonical check
  // and should delegate so a future health-check refinement (e.g.
  // a new sentinel state or a sibling-aware check) propagates here
  // automatically. Existing pins
  // `findCuratedFallbackRoute_whenRouteIsMarkedUnhealthyAtRouteLevel_skipsIt`
  // and `findCuratedFallbackRoute_whenNextRouteIsHiddenPaidProvider_skipsToVisibleRoute`
  // catch drift in the tail.
  const allowedRoute = visibleRoutes.find(
    (providerRoute) => {
      if (providerRoute.provider === blockedProviderID) return false;
      if (isFallbackBlocked(providerRoute.provider, providerRoute.model)) return false;
      return isRouteCurrentlyHealthy(providerRoute, providerHealthMap, modelRouteHealthMap, now);
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
 * Return the first visible route of a registry entry that is currently
 * routable — neither provider-level nor route-level penalty active. Pure
 * so it can be unit-tested independently of the reader sites below.
 *
 * Exists because two different readers need the same "is this entry
 * routable via any of its visible routes" question answered with
 * identical semantics: `computeRegistryEntryHealthReport` (for the
 * agent-facing `list_curated_models` tool output) and, historically, the
 * per-entry loop inside `buildAvailableModelsSystemPrompt`. Keeping the
 * predicate in one named helper prevents the two sites from drifting on
 * edge cases like key_missing providers with healthy visible siblings,
 * or route-level penalties that block some routes but not all.
 *
 * Args:
 *   modelRegistryEntry: Registry row to scan.
 *   providerHealthMap: Live provider-keyed health map.
 *   modelRouteHealthMap: Live composite-route-keyed health map.
 *   now: Wall-clock ms.
 *
 * Returns:
 *   The first visible route whose provider is healthy and whose
 *   composite-route entry is not penalized, or `null` when every
 *   visible route is blocked (or when there are no visible routes at all).
 */
export function findFirstHealthyRouteInEntry(
  modelRegistryEntry: ModelRegistryEntry,
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): ProviderRoute | null {
  const visibleRoutes = filterVisibleProviderRoutes(modelRegistryEntry.provider_order);
  for (const route of visibleRoutes) {
    if (isRouteCurrentlyHealthy(route, providerHealthMap, modelRouteHealthMap, now)) {
      return route;
    }
  }
  return null;
}

/**
 * Build the `{primaryRoute, primaryHealthy, alternativeRoutes}` payload
 * returned by the agent-facing `recommend_model_for_role` tool.
 *
 * The contract is: "hand the agent ONE concrete route it can use right
 * now". Pre-M62, the tool returned `filterVisibleProviderRoutes(...)[0]`
 * as `primaryRoute` regardless of health, and only set `primaryHealthy`
 * to `true` when that specific slot happened to be routable. Post-M58
 * (9b125b5), `initializeProviderHealthState` started installing
 * `key_missing` entries at boot for every uncredentialed curated
 * provider. For any entry whose `provider_order[0]` lives on an
 * uncredentialed provider — which is exactly the shipping shape in
 * `config/models.jsonc` (e.g. `opencode/glm-5.1-free` primary with
 * `iflowcn/glm-5.1` sibling) — the tool reported
 * `primaryRoute: "opencode/glm-5.1-free"` with `primaryProviderHealthy:
 * false`, forcing agents to parse `alternativeRoutes` to find a usable
 * route. That defeated the whole purpose of a "single recommendation"
 * tool and introduced exactly the class of agent-confusion bugs M59/M60
 * fixed in the system-prompt builders.
 *
 * This helper flips the contract: `primaryRoute` is the first visible
 * route that is actually routable (provider healthy AND composite-route
 * entry not penalized), exactly as the router itself would pick via
 * `findFirstHealthyRouteInEntry`. When every visible route is blocked
 * — a state `selectBestModelForRoleAndTask` is supposed to prevent but
 * which we defensively handle — we fall back to the first visible route
 * with `primaryHealthy: false` so the caller still gets a shape it can
 * render and surface the block reason via `alternativeRoutes`.
 * `alternativeRoutes` excludes whichever route was selected as primary,
 * so the agent never sees the same route twice.
 *
 * Args:
 *   modelRegistryEntry: Registry row to build a recommendation from.
 *   providerHealthMap: Live provider-keyed health map.
 *   modelRouteHealthMap: Live composite-route-keyed health map.
 *   now: Wall-clock ms.
 *
 * Returns:
 *   A `{primaryRoute, primaryHealthy, alternativeRoutes}` record.
 *   `primaryRoute` is null only when the entry has no visible routes at
 *   all (curation has hidden every provider). `primaryHealthy` is true
 *   iff a healthy route was found. `alternativeRoutes` lists every
 *   visible route except the one chosen as primary, each annotated with
 *   its individual `healthy` flag.
 *
 * ## Drift surfaces (M125 PDD)
 *
 * The body is eight statements and three of them carry orthogonal
 * load-bearing invariants that the five pre-existing pins partition only
 * along bundled lines — pin 1 bundles visibility + length-zero + shape,
 * pin 5 bundles the healthyPrimary-null fallback with the alternatives
 * filter, and every happy-path pin asserts both `alternativeRoutes.length`
 * and some `primaryRoute.provider` equality. Single-line sabotages cascade
 * into correlated pin clusters rather than localizing to the drift
 * surface that actually broke. The three asymmetric unit pins below
 * restore per-surface localization so an engineer running a focused
 * regression can read "pin X fired alone" and know exactly which surface
 * regressed.
 *
 *  1. **`filterVisibleProviderRoutes(entry.provider_order)` wrap —
 *     alternatives-list visibility invariant.** The inner
 *     `findFirstHealthyRouteInEntry` call has its OWN visibility filter
 *     (it calls `filterVisibleProviderRoutes` internally at M123/M124
 *     sites), so dropping the wrap HERE does not corrupt the healthy
 *     primary path. It corrupts TWO downstream quantities: (a) the
 *     `firstVisibleRoute = visibleRoutes[0]` fallback used when
 *     `healthyPrimary === null`, and (b) the `alternativeRoutes` list
 *     materialized from `visibleRoutes.filter(...).map(...)`. A drift
 *     that replaces `filterVisibleProviderRoutes(entry.provider_order)`
 *     with raw `entry.provider_order` silently leaks hidden paid routes
 *     (togetherai, xai, cerebras, deepseek, github-copilot, non-`:free`
 *     openrouter) into the `alternativeRoutes` array that the agent-
 *     facing `recommend_model_for_role` tool output directly serializes.
 *     Agents then see proprietary `xai/grok-4` or paid
 *     `openrouter/xiaomi/mimo-v2-pro` routes in the "alternative routes"
 *     bullet list of the tool response, parse them as routable, and
 *     either prefer them over the open-weight primary or escalate to the
 *     user asking whether to use them. Both outcomes break the curated-
 *     fallback policy at the tool boundary.
 *
 *  2. **`healthyPrimary ?? firstVisibleRoute` degraded-primary
 *     fallback.** When every visible route is blocked (a state
 *     `selectBestModelForRoleAndTask` is supposed to prevent but
 *     defensively handled), `findFirstHealthyRouteInEntry` returns null
 *     and the helper falls back to `visibleRoutes[0]` so the tool output
 *     shape stays renderable with `primaryRoute: {provider, model}` +
 *     `primaryHealthy: false`. A drift that drops the `?? firstVisibleRoute`
 *     tail (a tempting "the null case is the no-visible-routes case, the
 *     early return handles it" mis-read) silently returns `primaryRoute:
 *     null` whenever every visible route is blocked but SOME visible
 *     route exists. Downstream readers that do `result.primaryRoute.provider`
 *     without a null guard (because the docstring says null only when
 *     visibleRoutes.length === 0, which the length check above
 *     supposedly rules out) crash the tool handler with a TypeError. The
 *     `?? firstVisibleRoute` fallback is the only thing keeping the
 *     shape contract intact for the "every route blocked" branch.
 *
 *  3. **`route !== primaryRoute` alternatives dedupe.** The
 *     `alternativeRoutes` mapper filters `visibleRoutes` to exclude
 *     whichever route was chosen as primary so the agent never sees the
 *     same route in both slots. Dropping the filter (a refactor that
 *     simplifies `.filter(...).map(...)` to `.map(...)` "because we
 *     already surfaced primary separately") causes the primary route to
 *     appear in BOTH `primaryRoute` and as the first entry of
 *     `alternativeRoutes`. The agent now sees the same `{provider,
 *     model}` tuple twice in one tool response, which agents interpret
 *     as "the curated fallback for this model IS itself" — a loop
 *     signal that can trigger defensive re-routing or user-facing
 *     warnings about circular fallback configuration even though the
 *     registry is fine. The dedupe filter is the one thing keeping the
 *     primary / alternatives slots mutually exclusive.
 *
 * Each surface is isolated by exactly one new asymmetric unit pin below
 * (`buildRoleRecommendationRoutes_whenVisibleSiblingAndHiddenSibling_
 * excludesHiddenFromAlternatives`, `_whenEveryVisibleRouteBlockedOnSingleRoute_
 * returnsNonNullFirstVisibleRoute`, `_whenSingleHealthyRouteEntry_
 * producesEmptyAlternatives`) so a sabotage on exactly one drift surface
 * fires exactly one new pin uniquely; pre-existing pins firing as
 * additive coverage is acceptable per the PDD protocol.
 */
export function buildRoleRecommendationRoutes(
  modelRegistryEntry: ModelRegistryEntry,
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): {
  primaryRoute: ProviderRoute | null;
  primaryHealthy: boolean;
  alternativeRoutes: Array<{ route: ProviderRoute; healthy: boolean }>;
} {
  const visibleRoutes = filterVisibleProviderRoutes(modelRegistryEntry.provider_order);
  if (visibleRoutes.length === 0) {
    return { primaryRoute: null, primaryHealthy: false, alternativeRoutes: [] };
  }
  const healthyPrimary = findFirstHealthyRouteInEntry(
    modelRegistryEntry,
    providerHealthMap,
    modelRouteHealthMap,
    now,
  );
  // `visibleRoutes[0]` is guaranteed defined above by the length check;
  // the non-null assertion narrows the type under
  // `noUncheckedIndexedAccess` for the `healthyPrimary ?? ...` fallback.
  const firstVisibleRoute: ProviderRoute = visibleRoutes[0]!;
  const primaryRoute: ProviderRoute = healthyPrimary ?? firstVisibleRoute;
  const primaryHealthy = healthyPrimary !== null;
  const alternativeRoutes = visibleRoutes
    .filter((route) => route !== primaryRoute)
    .map((route) => ({
      route,
      healthy: isRouteCurrentlyHealthy(route, providerHealthMap, modelRouteHealthMap, now),
    }));
  return { primaryRoute, primaryHealthy, alternativeRoutes };
}

/**
 * Compute a health report for a registry entry as seen by the
 * agent-facing `list_curated_models` tool.
 *
 * Semantic: report the entry as blocked ONLY when EVERY visible route is
 * blocked. If ANY visible route is currently routable, return `null` —
 * the entry is usable, because the router (via `findCuratedFallbackRoute`,
 * `findFirstHealthyVisibleRoute`, and the live-route selection in
 * `provider.models`) will transparently walk past a blocked primary to a
 * healthy sibling without the caller's knowledge.
 *
 * History:
 *   - M29: previously the tool read `provider_order[0]` raw and only
 *     consulted provider-level health, so a route with a dead model_id
 *     underneath a healthy provider reported "healthy" and the router
 *     kept re-picking it. Fix walked `filterVisibleProviderRoutes`
 *     and consulted `modelRouteHealthMap`.
 *   - M30: composite-key normalization (`composeRouteKey`) so longcat's
 *     unprefixed entries could be looked up.
 *   - M61: this rewrite. Pre-M61 the function reported the PRIMARY
 *     visible route's state in isolation, ignoring sibling visible
 *     routes. That was fine when every blocked state was transient and
 *     the agent wanted early warning of a degraded primary. It broke
 *     post-M58 (9b125b5), when `initializeProviderHealthState` started
 *     installing `key_missing` entries at boot for every uncredentialed
 *     curated provider. For any entry whose primary route happens to
 *     live on an uncredentialed provider (very common on a default
 *     install — `opencode/glm-5.1-free` primary with `iflowcn/glm-5.1`
 *     sibling is the shape in the shipping `config/models.jsonc`), the
 *     report became `{state: "key_missing", until: "never", scope:
 *     "provider"}` even though the router was happily serving traffic
 *     via the healthy sibling. Agents calling `list_curated_models` saw
 *     entire classes of routable models marked permanently blocked and
 *     avoided them, silently downgrading quality on every turn. The
 *     M59/M60 key_missing noise filter applies to the system-prompt
 *     builders but does NOT touch `list_curated_models`, which is a
 *     tool the agent explicitly calls and reads as authoritative.
 *
 *     The fix is to flip the question from "what's wrong with the
 *     primary route" to "is this entry routable at all" — using
 *     `findFirstHealthyRouteInEntry` to ask the same question the
 *     router would ask when selecting a route. When any route is live,
 *     return null (entry is fine). When every route is blocked, keep
 *     the legacy behavior and report the primary's state so the agent
 *     understands WHY the entry is unusable.
 *
 * Args:
 *   modelRegistryEntry: Registry row to report on.
 *   providerHealthMap: Live provider-keyed health map.
 *   modelRouteHealthMap: Live composite-route-keyed health map.
 *   now: Wall-clock ms.
 *
 * Returns:
 *   `null` when any visible route is routable. Otherwise a
 *   `{state, until, scope}` record describing why the primary visible
 *   route is blocked (provider-scope preferred, route-scope when the
 *   provider itself is fine but the route-level penalty is the only
 *   block).
 *
 * ## Drift surfaces (M123 PDD)
 *
 * The body is forty lines of routing-policy glue compressed into three
 * orthogonal load-bearing invariants. The six pre-existing pins give
 * good coverage along each invariant individually, but the asymmetry
 * the M123 triple locks down is distinct: the three surfaces below
 * must each fail ALONE under a single-line sabotage, without the
 * failure signatures correlating with each other. Pre-M61 the function
 * was an inline `provider_order[0]` + provider-health read, and every
 * one of the three drift surfaces below was a latent bug that landed
 * in production across the M29/M30/M61 sequence.
 *
 *   1. **Visibility-filtered primary extraction.** The first two lines
 *      of the body run `filterVisibleProviderRoutes(entry.provider_order)`
 *      and take `[0]` of the result. Those two lines encode a strict
 *      contract: "the primary route this report describes is the first
 *      route the router would actually use for this entry," which is
 *      DEFINITIONALLY the first VISIBLE route in priority order, not
 *      the first authored route. A refactor that drops the filter and
 *      uses `modelRegistryEntry.provider_order[0]` directly — an easy
 *      "simplification" pass since the two subsequent penalty lookups
 *      key off `primaryRoute.provider` / `.model` and would still
 *      typecheck — silently flips the report to describe a hidden
 *      paid route (e.g. `openrouter/xiaomi/mimo-v2-pro` primary with
 *      `opencode-go/mimo-v2-pro` visible sibling). When the hidden
 *      route has no health entry, the function returns `null` ("all
 *      good") even though the real visible primary is `key_missing`,
 *      lying to `list_curated_models` about which entries are
 *      agent-routable. Pre-existing pin P2
 *      (`whenPrimaryRouteIsHiddenPaid_walksToVisibleSibling`) fires on
 *      this drift in one direction (hidden has penalty, visible
 *      doesn't) but not in the mirror direction (visible has penalty,
 *      hidden doesn't) — the M123 pin A closes that mirror.
 *
 *   2. **"Any healthy route → null" short-circuit.** Line 4469 is
 *      `if (findFirstHealthyRouteInEntry(...)) return null`. This is
 *      the post-M58 fix: when the primary is `key_missing` but a
 *      sibling visible route is healthy, the entry is still routable
 *      (the router walks past the dead primary transparently) and the
 *      report must say null. Dropping the short-circuit reintroduces
 *      the M58 regression literally — every entry whose primary lives
 *      on an uncredentialed provider gets reported as blocked even
 *      though the router serves traffic through a healthy sibling.
 *      Since the default config ships with many such entries
 *      (`opencode/glm-5.1-free` primary with `iflowcn/glm-5.1`
 *      sibling), the agent sees entire classes of routable models
 *      flagged as permanently blocked and avoids them. P4/P6 cover
 *      this surface bundled with the primary-key_missing and
 *      primary-transient-quota entry shapes; the M123 pin B uses the
 *      narrowest possible fixture so it can partition cleanly against
 *      pins A and C.
 *
 *   3. **Provider-before-route penalty precedence.** Lines 4473–4497
 *      run `findLiveProviderPenalty` FIRST, `findLiveRoutePenalty`
 *      SECOND, returning the first one that fires. The ordering is
 *      load-bearing: when both maps carry a live entry for the primary,
 *      the provider-level state is STRICTLY WIDER (it blocks every
 *      route on that provider, not just the one composite route key)
 *      and must win in the `scope` field. A drift that flips the
 *      order — an innocuous-looking dedupe pass that hoists the route
 *      check first "since route-level is more specific" — inverts the
 *      invariant and reports `scope: "route"` for an entry whose
 *      ENTIRE provider is quota-backed-off, confusing agents reading
 *      the report into thinking only one model is affected when every
 *      model on that provider is. No pre-existing pin exercises the
 *      both-maps-populated case where the flip would be observable;
 *      the M123 pin C is the only route-precedence regression pin.
 *
 * Asymmetry invariant: each sabotage must fire exactly one of pins
 * {A, B, C}. Pin A uses hidden-primary+visible-sibling where only the
 * VISIBLE sibling has a key_missing entry — S1 drop leaves the hidden
 * primary with no health entry and the function returns null, A fires
 * alone. Pin B uses all-visible routes where the primary is blocked
 * but a later visible sibling is healthy — S2 drop skips the
 * short-circuit and returns the primary's provider-scope report, B
 * fires alone. Pin C uses a single-route entry where the same route
 * carries BOTH a live provider penalty and a live route penalty with
 * distinct states — S3 flip inverts `scope` from "provider" to "route",
 * C fires alone. The fixtures are deliberately narrow so pre-existing
 * pins P2 / P4 / P6 fire as additive coverage without correlating the
 * M123 pin signatures.
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

  // M61: if any visible route (including the primary) is currently
  // routable, the entry is healthy — the router will transparently use
  // it regardless of whether the primary has a key_missing, transient
  // quota, or route-level penalty. Only report a blocked state when no
  // route is routable. See the function docstring for the post-M58
  // bug this prevents.
  if (findFirstHealthyRouteInEntry(modelRegistryEntry, providerHealthMap, modelRouteHealthMap, now)) {
    return null;
  }

  const liveProviderPenalty = findLiveProviderPenalty(
    providerHealthMap,
    primaryRoute.provider,
    now,
  );
  if (liveProviderPenalty) {
    return {
      state: liveProviderPenalty.state,
      until: formatHealthExpiry(liveProviderPenalty.until),
      scope: "provider",
    };
  }
  const livePenalty = findLiveRoutePenalty(
    modelRouteHealthMap,
    primaryRoute.provider,
    primaryRoute.model,
    now,
  );
  if (livePenalty) {
    return {
      state: livePenalty.state,
      until: formatHealthExpiry(livePenalty.until),
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
  // M71: delegate to `findLiveProviderPenalty` so the boolean predicate
  // and the entry-returning readers share a single expiry boundary.
  // key_missing state never expires (until: Number.POSITIVE_INFINITY) so
  // the delegate keeps returning an entry and this predicate keeps
  // returning false — same semantics as the pre-M71 inline form.
  return findLiveProviderPenalty(providerHealthMap, providerID, now) === null;
}

/**
 * Decide whether a `ProviderHealthState` should be surfaced in the
 * agent-visible system prompt injected by
 * `experimental.chat.system.transform` → `buildProviderHealthSystemPrompt`.
 *
 * `key_missing` is structural plumbing state: the plugin installs it at
 * boot via `initializeProviderHealthState` for every curated provider
 * without an auth.json entry or env-var credential, and `isProviderHealthy`
 * internally consults it to skip those providers in the fallback scanner
 * and the preferred-model lookup. The agent never has the option to route
 * to a key_missing provider in the first place, so narrating "Provider X
 * [KEY MISSING] until never. Curated fallbacks: ..." for every uncredentialed
 * provider on every single turn is:
 *
 *  1. Semantically wrong: the label `PROVIDER_QUOTA_STATUS_HEADER`
 *     ("Provider health status") conflates transient backoff
 *     (quota/key_dead/no_credit/model_not_found/timeout — all finite
 *     windows the agent might plausibly retry through) with a permanent
 *     operator-action-required state. An agent reading "until never"
 *     has no sensible recourse.
 *  2. Massively noisy post-M58: before M58, the factory never installed
 *     any key_missing entries so the `new Date(Infinity).toISOString()`
 *     sites never fired — both bugs were dormant. After M58 the factory
 *     correctly installs key_missing for every uncredentialed curated
 *     provider, and a realistic install (a handful of credentials set,
 *     the rest unset) now dumps 15–25 key_missing sections into every
 *     agent turn's system prompt. Each section runs a per-entry
 *     `findCuratedFallbackRoute` loop over the registry, so the noise
 *     has a nontrivial CPU cost too.
 *  3. Not load-bearing for the agent: the only reason a system prompt
 *     would need to mention a penalty is if the agent might otherwise
 *     route to that provider and waste a call. key_missing is already
 *     filtered out upstream — the agent cannot and will not route there.
 *
 * Transient states (quota, key_dead, no_credit, model_not_found, timeout)
 * are a different story: they represent providers that WERE healthy at
 * startup and became unhealthy mid-session, which the agent does need
 * situational awareness of when interpreting a fallback it wasn't
 * expecting. Those continue to flow through the system prompt.
 *
 * Args:
 *   state: The state field of a `ProviderHealth` entry.
 *
 * Returns:
 *   `true` when the state represents a transient penalty worth surfacing
 *   to the agent, `false` when the state is permanent plumbing state.
 */
export function isAgentVisibleHealthState(state: ProviderHealthState): boolean {
  return state !== "key_missing";
}

/**
 * Return `true` iff at least one health map contains a non-expired entry
 * whose state is agent-visible (i.e. not `key_missing`).
 *
 * Exists because multiple agent-visible-prompt builders guard their work
 * with a `providerHealthMap.size === 0 && modelRouteHealthMap.size === 0`
 * early exit. That guard was written pre-M58, when the only way a
 * provider landed in the map was a live failure. Post-M58 (commit
 * `9b125b5`), `initializeProviderHealthState` installs a `key_missing`
 * entry with `until: Number.POSITIVE_INFINITY` for every uncredentialed
 * curated provider at boot — typically 15–25 entries on a default
 * install. `providerHealthMap.size === 0` is therefore effectively never
 * true in production, and the early exit is dead wiring.
 *
 * M59 partially patched this by filtering `key_missing` inside
 * `buildProviderHealthSystemPrompt`, so that builder returns `null` when
 * nothing is agent-visible. But its sibling `buildAvailableModelsSystemPrompt`
 * still trips through a full registry walk on every turn and emits an
 * "Alternative models by role" section into the system prompt — a block
 * whose entire purpose is "there's a problem, here's what you can try
 * instead." When the ONLY entries in the health maps are key_missing
 * (permanent plumbing, not a transient failure the agent can route
 * around), there IS no problem the agent needs alternatives for, and
 * the block is pure system-prompt noise: it fires on every turn of a
 * freshly-booted plugin with nothing actually wrong.
 *
 * The `experimental.chat.system.transform` hook has the same dead guard
 * at the hook-level early exit. Both sites should consult this helper
 * instead of the raw `.size` check so the "nothing worth surfacing"
 * short-circuit fires whenever every entry is permanent plumbing.
 *
 * Args:
 *   providerHealthMap: Live provider-keyed health map.
 *   modelRouteHealthMap: Live composite-route-keyed health map.
 *   now: Wall-clock ms — entries with `until <= now` are treated as
 *     already-expired and ignored.
 *
 * Returns:
 *   `true` if at least one entry in either map satisfies
 *   `health.until > now && isAgentVisibleHealthState(health.state)`,
 *   `false` otherwise. Empty maps return `false`. Maps that only contain
 *   `key_missing` entries return `false`. Maps that contain only expired
 *   entries return `false`. Any single live transient penalty anywhere
 *   returns `true`.
 *
 * ## Drift surfaces (M124 PDD)
 *
 * Seven body lines compress three orthogonal load-bearing invariants
 * that gate every agent-visible system-prompt injection and tool-output
 * penalty report downstream. Six pre-existing pins give each invariant
 * individual coverage, but several of them fire on MULTIPLE sabotages
 * at once — the mixed-penalty pin and the all-transient-expired pin
 * both bundle liveness, agent-visibility, and map-iteration into a
 * single fixture — so a single-line refactor that drops one invariant
 * can surface as multiple correlated pin failures whose messages do
 * not localize the drift to one surface. The M124 triple lays down
 * three deliberately narrow pins that each fire ALONE under one
 * surface's sabotage, so a drift's failure signature points at exactly
 * one surface without the existing pins' bundled coverage muddying the
 * diagnosis.
 *
 *   1. **Provider map scan loop.** The first `for (const health of
 *      providerHealthMap.values())` block is the only path that can
 *      detect a provider-level agent-visible live penalty. A refactor
 *      that drops this block entirely — e.g. a "simplification" pass
 *      that convinces itself the route map suffices because
 *      `recordRouteHealthByIdentifiers` always writes both — silently
 *      misses every provider-only penalty. That matters because
 *      `computeProviderHealthUpdate` writes provider-level penalties
 *      for quota/key_dead/no_credit without touching the route map
 *      when the offending call did not carry a model tuple (e.g.
 *      pre-flight credential checks, cold-start health restore, or
 *      provider-wide 402 responses). Those penalties would never
 *      surface to the agent, and every system-prompt builder
 *      consulting this helper would short-circuit to "nothing to
 *      report" even though a whole provider was backed off. The
 *      failure is silent: `buildProviderHealthSystemPrompt` returns
 *      null, the transform hook skips the section, the agent keeps
 *      routing to the dead provider, and retries cycle until the
 *      entry finally lands in the route map via a second failure.
 *
 *   2. **Route map scan loop.** The second `for (const health of
 *      modelRouteHealthMap.values())` block mirrors the provider
 *      loop on a different map with an identical failure mode. Same
 *      copy-paste drift hazard: a refactor that edits the provider
 *      loop (adds a filter clause, narrows the predicate, renames a
 *      local) and forgets the route loop leaves the two branches
 *      out of sync on opposite filter policies. Pre-existing pin
 *      `whenOnlyRouteLevelPenaltyLive_returnsTrue` covers the
 *      all-else-empty case but bundles it with a route-fixture that
 *      also exercises the gate on the same call. The M124 pin B
 *      uses the narrowest possible fixture so pin B's failure
 *      signature disambiguates "route loop gone" from "gate too
 *      strict on routes."
 *
 *   3. **`isAgentVisibleLivePenalty` key_missing filter.** Both
 *      loops pass every live entry through `isAgentVisibleLivePenalty`
 *      which composes `health.until > now` with
 *      `isAgentVisibleHealthState(health.state)`. The second clause
 *      is the post-M58 key_missing suppressor: without it, every
 *      uncredentialed curated provider installed at boot with
 *      `until: Infinity` matches `until > now` and the helper
 *      reports "agent-visible penalty present" on every turn of a
 *      freshly-booted plugin with nothing actually wrong. A
 *      "simplification" that drops the agent-visible clause and
 *      keeps raw liveness reintroduces the M59/M60 noise bug at the
 *      helper boundary, and since the helper is the single gate
 *      feeding `buildProviderHealthSystemPrompt`,
 *      `buildAvailableModelsSystemPrompt`, and the
 *      `experimental.chat.system.transform` hook, one drift here
 *      cascades into 15–25 spurious system-prompt sections per turn
 *      on a default install.
 *
 * Asymmetry invariant: each sabotage fires exactly one of {A, B, C}.
 * Pin A populates the provider map with one live quota entry and
 * leaves the route map empty — S1 (drop provider loop) flips the
 * answer from true to false; S2 is a no-op because the route loop
 * sees nothing; S3 (drop key_missing filter) still returns true
 * because the quota entry is also `until > now`. Pin B mirrors with
 * a live no_credit entry in the route map only — S2 flips, S1 and
 * S3 are no-ops. Pin C populates the provider map with a single
 * key_missing entry (until: Infinity) — S3 (gate → raw liveness)
 * flips the answer from false to true by treating the boot-time
 * plumbing entry as a live agent-visible penalty; S1 drops the loop
 * entirely and the function still returns false via the empty route
 * loop; S2 is a no-op because the route map is empty either way.
 */
export function hasAgentVisiblePenalty(
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): boolean {
  for (const health of providerHealthMap.values()) {
    if (isAgentVisibleLivePenalty(health, now)) {
      return true;
    }
  }
  for (const health of modelRouteHealthMap.values()) {
    if (isAgentVisibleLivePenalty(health, now)) {
      return true;
    }
  }
  return false;
}

/**
 * Return `true` when a health entry is both live (not expired) and one
 * the agent can act on (not a structural plumbing state).
 *
 * Canonical form of the predicate
 * `health.until > now && isAgentVisibleHealthState(health.state)` that
 * pre-M69 lived inlined across six sites:
 *   - `hasAgentVisiblePenalty` (provider loop)
 *   - `hasAgentVisiblePenalty` (route loop)
 *   - `buildAgentVisibleBackoffStatus` (provider loop)
 *   - `buildAgentVisibleBackoffStatus` (route loop)
 *   - `buildProviderHealthSystemPrompt` (provider filter)
 *   - `buildProviderHealthSystemPrompt` (route filter)
 *
 * All six sites answered the same question: "should this entry be
 * surfaced in the agent-visible view right now?" The conjunction is
 * load-bearing on BOTH halves — dropping `health.until > now` leaks
 * already-expired penalties (breaks M29 route-level expiration
 * semantics), and dropping `isAgentVisibleHealthState(health.state)`
 * floods every agent turn with `key_missing` structural plumbing
 * (the exact M59 bug that M63's `buildAgentVisibleBackoffStatus`
 * extraction closed at the tool boundary but left inline at the five
 * other sites).
 *
 * A future refinement — a new comparison operator (`>=` semantics for
 * boundary ticks), a new agent-visible state, an additional
 * `retryCount > 0` clause to hide soft-retries — has to land in one
 * named place now instead of six.
 *
 * Args:
 *   health: A `ProviderHealth` or `ModelRouteHealth` entry. The two
 *     types share the `{state, until}` shape this predicate reads, so
 *     one helper covers both maps without a discriminated union.
 *   now: Wall-clock ms.
 *
 * Returns:
 *   `true` when the entry's expiration is strictly in the future AND
 *   its state is one the agent can route around. `false` for expired
 *   entries, `key_missing` sentinels, or any future state added to the
 *   `isAgentVisibleHealthState` exclusion list.
 */
export function isAgentVisibleLivePenalty(
  health: { state: ProviderHealthState; until: number },
  now: number,
): boolean {
  return health.until > now && isAgentVisibleHealthState(health.state);
}

/**
 * Build the payload returned by the `get_quota_backoff_status`
 * agent-facing tool: one entry per *agent-visible* live penalty across
 * both the provider and route health maps.
 *
 * The tool's name and description both advertise it as a "quota backoff
 * status" — its contract is "return the providers and routes that are
 * currently penalized with a transient backoff state the agent might
 * plausibly retry through". Pre-M63 the handler iterated
 * `providerHealthMap.entries()` directly and emitted every entry whose
 * `until > now`. That was correct pre-M58 when the only way a
 * provider landed in `providerHealthMap` was via a live transient
 * failure event. M58 (commit `9b125b5`) changed the invariant:
 * `initializeProviderHealthState` now installs a `key_missing` entry
 * with `until: Number.POSITIVE_INFINITY` for every uncredentialed
 * curated provider at boot (typically 15–25 entries on a default
 * install). `until > now` is permanently true for those entries, so
 * every call to `get_quota_backoff_status` post-M58 dumped the entire
 * key_missing roster into the tool output labeled as "currently
 * penalized" providers — even on a freshly-booted plugin with nothing
 * actually wrong. Agents calling the tool to answer "what's broken
 * that I should avoid right now?" got handed a noisy permanent
 * plumbing report indistinguishable from a genuine outage, and had
 * no way to tell which entries represented real transient backoffs
 * versus structural "operator hasn't run oauth yet" state.
 *
 * Same bug class as M59 (`buildProviderHealthSystemPrompt`) and M60
 * (`buildAvailableModelsSystemPrompt` +
 * `experimental.chat.system.transform`) at the tool-output layer:
 * a narrow predicate (`until > now`) silently misbehaves under the
 * post-M58 map invariant, and the correct behavior is explicit
 * agent-visible-vs-plumbing filtering at the rendering boundary via
 * `isAgentVisibleHealthState`. This helper composes with
 * `hasAgentVisiblePenalty` / `isAgentVisibleHealthState` so the
 * "agent-visible" semantic lives in a single named place and every
 * agent-facing output channel goes through the same filter.
 *
 * Expired entries are skipped but NOT deleted from the maps — the
 * pre-M63 handler did inline `.delete()` calls while iterating, which
 * is safe in JS Map semantics but mixed presentation and
 * bookkeeping in a single pass. Map cleanup is the job of
 * `expireHealthMaps`; the caller should invoke that separately if it
 * wants the maps trimmed. Keeping this helper pure means it has no
 * side effects on the maps and is trivially testable.
 *
 * Args:
 *   providerHealthMap: Live provider-keyed health map.
 *   modelRouteHealthMap: Live composite-route-keyed health map.
 *   now: Wall-clock ms.
 *
 * Returns:
 *   A `Record<string, {state, until, type, retryCount}>` with one
 *   entry per agent-visible live penalty. Keys are provider IDs for
 *   `type: "provider"` entries and composite route keys for
 *   `type: "model_route"` entries. Returns an empty object when no
 *   agent-visible penalties are live in either map (including the
 *   post-M58 fresh-boot case where the provider map contains only
 *   `key_missing` entries).
 */
export function buildAgentVisibleBackoffStatus(
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): Record<string, { state: string; until: string; type: string; retryCount: number }> {
  const status: Record<
    string,
    { state: string; until: string; type: string; retryCount: number }
  > = {};

  for (const [providerID, health] of providerHealthMap.entries()) {
    if (!isAgentVisibleLivePenalty(health, now)) continue;
    status[providerID] = {
      state: health.state,
      until: formatHealthExpiry(health.until),
      type: "provider",
      retryCount: health.retryCount,
    };
  }

  for (const [routeKey, health] of modelRouteHealthMap.entries()) {
    if (!isAgentVisibleLivePenalty(health, now)) continue;
    status[routeKey] = {
      state: health.state,
      until: formatHealthExpiry(health.until),
      type: "model_route",
      retryCount: health.retryCount,
    };
  }

  return status;
}

/**
 * Render `providerHealthMap` as a `{state, until}` tool-output dict with
 * NO filter — every entry passes through, including `key_missing` plumbing.
 *
 * ## Drift shape
 *
 * The `recommend_model_for_role` tool handler's no-recommendation branch
 * previously inlined a five-line `Object.fromEntries(Array.from(
 * providerHealthMap.entries()).map(([id, h]) => [id, { state: h.state,
 * until: formatHealthExpiry(h.until) }]))` expression at the call site.
 * Three independent drift surfaces lived on that fragment:
 *
 *   1. The `state: h.state` field is the entire "what's broken" signal
 *      the agent reads when the tool reports no recommendation. A
 *      refactor that renames the key or drops the field silently
 *      produces a summary where every entry is `{ until: "..." }` with
 *      no indication of WHY each provider is penalized — the agent
 *      then has no basis for deciding which alternative to try next.
 *
 *   2. The `formatHealthExpiry(h.until)` call is load-bearing: the
 *      helper converts the raw epoch-ms `number` into either the
 *      ISO-8601 string `"2026-04-11T18:24:00.000Z"` or the sentinel
 *      `"never"` for `Number.POSITIVE_INFINITY` (the `key_missing`
 *      permanent-plumbing marker). A refactor that passes `h.until`
 *      directly to `JSON.stringify` silently emits raw unix epoch
 *      numbers for transient penalties and the machine-incompatible
 *      float `Infinity` for permanent ones, which JSON encodes as
 *      `null` — the agent then sees `"until": null` for every
 *      key_missing entry and cannot distinguish "permanently dead"
 *      from "unknown expiry".
 *
 *   3. The summary is an UNFILTERED pass-through — unlike
 *      `buildAgentVisibleBackoffStatus` (which filters through
 *      `isAgentVisibleLivePenalty`), this one is a diagnostic "here is
 *      everything in the map" dump intended to let the agent debug
 *      why no candidate model scored. A refactor that accidentally
 *      adds a filter — perhaps copying from `buildAgentVisibleBackoffStatus`
 *      — silently drops `key_missing` entries, which are EXACTLY the
 *      entries the agent most needs to see in the no-recommendation
 *      case (they explain "no credentials configured for this
 *      provider" far better than "backoff lifted, try again" would).
 *
 * ## Why a thin pure helper
 *
 * Extracted as a pure input-output helper so the three drift surfaces
 * — the state field, the formatter call, the no-filter policy — are
 * each pinnable by one regression unit test rather than by reading
 * the tool handler's full JSON.stringify body. The helper is
 * deliberately NOT collapsed with `buildAgentVisibleBackoffStatus`:
 * that helper is for the `get_quota_backoff_status` tool (agent
 * wants "what is LIVE right now?") and this helper is for the
 * `recommend_model_for_role` no-recommendation branch (agent wants
 * "what does the plugin currently know about every provider?"). The
 * two have opposite filter semantics and collapsing them would
 * require a boolean parameter, which would itself be a new drift
 * surface.
 *
 * Args:
 *   providerHealthMap: The plugin's live provider health map. Every
 *     entry (agent-visible or not) is rendered.
 *
 * Returns:
 *   A plain object keyed by provider ID with `{state, until}` where
 *   `until` is the formatted ISO-8601 string or `"never"`. Returns
 *   `{}` when the map is empty.
 */
export function buildProviderHealthSummaryForTool(
  providerHealthMap: Map<string, ProviderHealth>,
): Record<string, { state: ProviderHealthState; until: string }> {
  const summary: Record<string, { state: ProviderHealthState; until: string }> = {};
  for (const [providerID, health] of providerHealthMap.entries()) {
    summary[providerID] = {
      state: health.state,
      until: formatHealthExpiry(health.until),
    };
  }
  return summary;
}

/**
 * Map an internal `ProviderHealthState` to the human-readable,
 * agent-friendly label the plugin uses in every penalty-facing
 * rendering surface (`formatPenaltySectionPrefix`,
 * `buildAgentVisibleBackoffStatus`, the provider health system
 * prompt, and tool-visible summaries).
 *
 * The label scheme is not cosmetic: the agent's "try another model"
 * prompts match against these exact labels as matchable tokens, and
 * opencode's downstream log scrapers grep for them too. A label
 * convention drift at ANY one case silently desynchronizes one state
 * from the rest and breaks agent-level recognition of that state
 * without crashing anything. This helper is the sole source of truth
 * for three independent label-convention surfaces:
 *
 *  1. **"QUOTA BACKOFF" (quota only — the suffix convention).** The
 *     `quota` state is the only transient-recoverable state that
 *     carries a SUFFIX word (`"BACKOFF"`) beyond the bare state name.
 *     This is deliberate: quota is the only state where the agent's
 *     recovery action is to wait the window out (as opposed to
 *     key_dead where the action is "get a new key", no_credit where
 *     the action is "top up", etc.), and the suffix is the signal.
 *     A refactor that drops `"BACKOFF"` (the "keep it short" drift
 *     class) leaves `"QUOTA"` — which the agent's recovery prompts do
 *     not match as a "wait it out" state.
 *
 *  2. **Underscore → space substitution (multi-word states).** Four
 *     states use snake_case internal names (`key_dead`, `no_credit`,
 *     `key_missing`, `model_not_found`) but EVERY label uses ASCII
 *     SPACE as the word separator (`"KEY DEAD"`, `"NO CREDIT"`,
 *     `"KEY MISSING"`, `"MODEL NOT FOUND"`). A refactor that "just
 *     uppercases the state" and leaves the underscore (the
 *     "mechanical mapping" drift class) produces `"KEY_DEAD"` which
 *     the agent's single-token-word recognizers (`\bKEY DEAD\b`) do
 *     not match, silently breaking every multi-word state at once.
 *
 *  3. **Three-word expansion for `model_not_found`.** The longest
 *     label is `"MODEL NOT FOUND"` — three words, enforcing that the
 *     helper must actually split ALL underscores, not just the first
 *     one. A refactor that replaces only the FIRST `_` (`.replace("_",
 *     " ")` instead of `.replace(/_/g, " ")` or the hand-written
 *     switch) silently produces `"MODEL NOT_FOUND"` and breaks only
 *     the three-word state while leaving all two-word states
 *     (`key_dead`, `no_credit`, `key_missing`) still rendering
 *     correctly — a particularly insidious drift because a casual
 *     spot-check on key_dead would never catch it.
 *
 * Args:
 *   state: One of the six `ProviderHealthState` enum values.
 *
 * Returns:
 *   The agent-facing uppercase label.
 */
export function healthStateLabel(state: ProviderHealthState): string {
  switch (state) {
    case "quota": return "QUOTA BACKOFF";
    case "key_dead": return "KEY DEAD";
    case "no_credit": return "NO CREDIT";
    case "key_missing": return "KEY MISSING";
    case "model_not_found": return "MODEL NOT FOUND";
    case "timeout": return "TIMEOUT";
  }
}

/**
 * Filter both the provider health map and the route health map through
 * `isAgentVisibleLivePenalty` and return both entry lists as a tuple, or
 * `null` when BOTH sides are empty (the system-prompt early-return
 * sentinel).
 *
 * ## Drift shape
 *
 * `buildProviderHealthSystemPrompt` previously opened its body with two
 * structurally-identical `Array.from(map.entries()).filter(([, health])
 * => isAgentVisibleLivePenalty(health, now))` expressions — one for the
 * provider map, one for the route map — followed by a third inline
 * guard `if (activeProviderPenalties.length === 0 &&
 * activeRoutePenalties.length === 0) return null;`. Three independent
 * drift surfaces lived on that fragment:
 *
 *   1. The PROVIDER-side filter gates the entire provider section of
 *      the system prompt. A refactor that drops the filter expression
 *      (or leaves `Array.from(providerHealthMap.entries())` without
 *      the `.filter(...)` call — easy to miss during a
 *      "simplification" pass) silently dumps every `key_missing`
 *      entry into the system prompt. Post-M58 every cold start
 *      installs `key_missing` for every uncredentialed curated
 *      provider (typically 15–25 entries), so the agent would see
 *      a 15-section wall of `Provider X [KEY MISSING] until never`
 *      on every single message — exactly the noise pre-M58 intentionally
 *      hid. Already-expired entries would also leak in because the
 *      filter drops them via `until > now`.
 *
 *   2. The ROUTE-side filter is a mirror of surface 1, on a different
 *      map, with an identical failure mode (dump expired/permanent
 *      route-level penalties into the system prompt). The mirror
 *      shape makes this surface the classic "copy-paste drift target":
 *      a refactor touches the provider filter and forgets the route
 *      filter (or vice versa), leaving the two branches out of sync
 *      with opposite filter policies — an asymmetric drift the
 *      mirror-test structure is designed to catch.
 *
 *   3. The `both empty → null` early-return gate is load-bearing. The
 *      outer `experimental.chat.system.transform` hook depends on
 *      `buildProviderHealthSystemPrompt` returning `null` when there
 *      is nothing to report (via `assembleHealthAwareSystemPrompts`'s
 *      null filter). A refactor that drops the gate and always
 *      returns a non-null string (e.g. an empty header) would cause
 *      the transform hook to push an empty provider-health prompt
 *      into `output.system` on every message with no penalties,
 *      adding a useless header section and wasting the agent's
 *      attention on a "nothing is broken right now" preamble.
 *
 * ## Why a single helper
 *
 * Collapsing the two filters + the early-return gate into one exported
 * helper makes the three drift surfaces properties of one function
 * rather than conventions spread across four lines of inline code in
 * two structurally-parallel branches. The helper returns the two
 * filtered entry lists as a tagged `{providers, routes}` object so the
 * call site can destructure with the original variable names and keep
 * the rest of the function body byte-identical.
 *
 * Args:
 *   providerHealthMap: The plugin's live provider health map.
 *   modelRouteHealthMap: The plugin's live route health map.
 *   now: Current wall-clock ms — used by `isAgentVisibleLivePenalty`
 *     to drop already-expired entries. Passed at the helper boundary
 *     so the single `Date.now()` call at the hook entry point is
 *     consistent across both filters.
 *
 * Returns:
 *   `null` when both maps have no agent-visible live entries. Otherwise
 *   `{providers, routes}` where each array is the filtered `[key, health]`
 *   tuple list in map-iteration order.
 */
export function collectAgentVisibleLivePenalties(
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): {
  providers: Array<[string, ProviderHealth]>;
  routes: Array<[string, ModelRouteHealth]>;
} | null {
  const providers = Array.from(providerHealthMap.entries()).filter(
    ([, health]) => isAgentVisibleLivePenalty(health, now),
  );
  const routes = Array.from(modelRouteHealthMap.entries()).filter(
    ([, health]) => isAgentVisibleLivePenalty(health, now),
  );
  if (providers.length === 0 && routes.length === 0) {
    return null;
  }
  return { providers, routes };
}

/**
 * Render the shared two-line header prefix for one penalty section
 * — the `## Provider health status` banner followed by the
 * `"${entityLabel} [${stateLabel}] until ${untilString}."` synopsis.
 *
 * ## Drift shape
 *
 * `buildProviderHealthSystemPrompt` previously built this two-line
 * header twice — once in the provider-penalty loop and once in the
 * route-penalty loop — with structurally-identical code:
 *
 *     const label = healthStateLabel(health.state);
 *     const until = formatHealthExpiry(health.until);
 *     sections.push([
 *       PROVIDER_QUOTA_STATUS_HEADER,
 *       `Provider ${providerID} [${label}] until ${until}.`,
 *       // ...tail differs...
 *     ].join("\n"));
 *
 * and the route loop had the identical `const label = ...; const
 * until = ...;` preprocess followed by
 *
 *     const header = [
 *       PROVIDER_QUOTA_STATUS_HEADER,
 *       `Route ${routeKey} [${label}] until ${until}.`,
 *     ];
 *
 * Three independent drift surfaces lived on that mirror pair:
 *
 *   1. The `PROVIDER_QUOTA_STATUS_HEADER` constant (`"## Provider
 *      health status"`) is the section marker the agent uses to
 *      locate the penalty block in the system prompt. A refactor
 *      that drops or renames the constant in one branch but not
 *      the other silently produces an asymmetric prompt where
 *      provider penalties are under one header and route penalties
 *      under another (or none) — the agent sees two banners and
 *      may treat them as unrelated alerts.
 *
 *   2. The `healthStateLabel(health.state)` call is load-bearing:
 *      it maps `"quota"` → `"QUOTA BACKOFF"`, `"key_dead"` →
 *      `"KEY DEAD"`, etc. — a human-readable form the agent can
 *      match against its "try another model" prompts. A refactor
 *      that drops the call and interpolates raw `health.state`
 *      silently produces lowercase snake_case labels
 *      (`[quota]`) the agent does not recognize as "the thing that
 *      tells me to back off," so the agent keeps retrying the
 *      penalized route until it hits the backoff expiry by brute
 *      force. Worse still: a refactor that drops the call in ONE
 *      loop but not the other produces asymmetric labels for
 *      provider vs route penalties — a classic copy-paste drift
 *      where the two sections disagree about the same state.
 *
 *   3. The `formatHealthExpiry(health.until)` call is load-bearing
 *      in the same way: it maps raw epoch ms into ISO-8601 strings
 *      or the `"never"` sentinel for `Number.POSITIVE_INFINITY`. A
 *      refactor that drops the call silently emits `"until
 *      1700000000000"` or `"until Infinity"` — neither is human- or
 *      agent-friendly, and the `Infinity` case is the most painful
 *      (`JSON.stringify(Infinity) === "null"` is a separate bug
 *      class; here the template literal renders it as the string
 *      `"Infinity"` which the agent almost certainly parses as
 *      "invalid date").
 *
 * ## Why a shared helper
 *
 * Collapsing the header construction into one exported helper
 * makes the three drift surfaces properties of one function
 * rather than conventions spread across two structurally-parallel
 * loops with identical `const label = ...; const until = ...;`
 * preprocess. The helper returns a `string[]` (not a
 * newline-joined string) so the caller can extend it with
 * section-specific body lines before the final `join("\n")` —
 * this keeps the provider loop's "fallback list" tail and the
 * route loop's "owning entry fallback" tail at the call sites
 * where they belong, rather than forcing them into a more
 * invasive helper signature.
 *
 * Args:
 *   entityLabel: The `Provider <id>` or `Route <key>` prefix that
 *     identifies which map the penalty is from. The caller is
 *     responsible for choosing the right prefix — the helper does
 *     not infer it from the health shape because
 *     `ProviderHealth` and `ModelRouteHealth` are structurally
 *     identical and indistinguishable at the type level.
 *   health: The health entry for the penalty. Either a
 *     `ProviderHealth` or a `ModelRouteHealth` — both have the
 *     same three fields (`state`, `until`, `retryCount`) and the
 *     helper only reads `state` and `until`.
 *
 * Returns:
 *   A two-element string array ready for the caller to extend
 *   with section-specific body lines. The first element is always
 *   `PROVIDER_QUOTA_STATUS_HEADER`; the second is the formatted
 *   synopsis.
 */
export function formatPenaltySectionPrefix(
  entityLabel: string,
  health: ProviderHealth | ModelRouteHealth,
): string[] {
  return [
    PROVIDER_QUOTA_STATUS_HEADER,
    `${entityLabel} [${healthStateLabel(health.state)}] until ${formatHealthExpiry(health.until)}.`,
  ];
}

/**
 * Assemble the agent-facing "Provider health status" system-prompt block
 * from the live provider and route penalty maps.
 *
 * This is the SOLE renderer of the health-status section injected into
 * every chat turn via `experimental.chat.system.transform`. It has four
 * pre-existing pins (route-only section, no-penalties null, key_missing
 * null, quota+key_missing mixed filter) that cover the collector
 * integration and the key_missing filter but leave three independent
 * drift surfaces uncovered:
 *
 * 1. **Provider-section "Curated fallbacks (longcat/claude/gpt/grok
 *    excluded):" label literal.** Every provider-penalty section pushes
 *    this exact line before the per-entry fallback bullets. The
 *    parenthetical exclusion note is NOT decoration — it is an agent-
 *    legibility contract telling the LLM *why* proprietary models (the
 *    ones banned by `isFallbackBlocked`) are absent from the bullet
 *    list below it. Without the note, an agent seeing e.g. a 2h
 *    openrouter `key_dead` with a curated-fallback list that doesn't
 *    include `openrouter/anthropic/claude-3.5-sonnet:free` has no
 *    signal that the absence is deliberate; it may try to invoke the
 *    brand-blocked route anyway, trigger a hard fail, and burn a turn.
 *    A refactor that "simplifies" the label to just
 *    `"Curated fallbacks:"` silently strips that contract. The label
 *    appears ONLY on provider-penalty sections — route-penalty sections
 *    use the different singular `"Curated fallback for ${id}:"` shape,
 *    so the label is asymmetric across section types by design.
 *
 * 2. **`if (owningEntry)` guard on route-penalty sections.** The
 *    `activeRoutePenalties` iteration searches `modelRegistryEntries`
 *    for the entry owning each penalized composite route key. When no
 *    current registry entry matches (legacy persisted key from a
 *    removed model, a race between a registry hot-reload and a
 *    still-firing penalty, or a route whose owning entry was disabled
 *    after the penalty was recorded), `owningEntry` is `undefined` and
 *    the section MUST emit header-only — no `findCuratedFallbackRoute`
 *    call, no `Curated fallback for` bullet. The guard is load-bearing:
 *    `findCuratedFallbackRoute` dereferences `entry.provider_order` on
 *    the first line of its body, so dropping the `if` produces a
 *    `TypeError: cannot read properties of undefined (reading
 *    'provider_order')` that crashes the entire
 *    `experimental.chat.system.transform` hook and — because hook
 *    failures are swallowed by `logPluginHookFailure` — the plugin
 *    silently stops injecting system prompts for the rest of the
 *    session. None of the pre-existing pins exercises an unknown-
 *    owning-entry route penalty; the NEW pin does.
 *
 * 3. **`\n\n` cross-section separator when both provider and route
 *    penalties exist.** The final `sections.join("\n\n")` uses a blank
 *    line between sections; every section is itself joined with
 *    single-`\n`. The double-newline separator is what lets downstream
 *    markdown renderers (and the agent's own parsing) identify each
 *    section as a distinct block. A refactor that changes the join to
 *    `"\n"` silently merges adjacent sections into one opaque
 *    paragraph and the agent reads e.g. a provider quota block's
 *    fallback bullet as if it were part of the route block's header.
 *    The pre-existing pins only assert against single-section outputs
 *    (route-only in pin 1328, provider-only in pin 1451), so the
 *    cross-section separator is silently load-bearing but untested.
 *
 * Args:
 *   modelRegistryEntries: Curated registry rows. Used to find the
 *     affected entries per penalized provider AND the owning entry per
 *     penalized route.
 *   providerHealthMap: Live provider-level health table.
 *   modelRouteHealthMap: Live composite-route-keyed health table.
 *   now: Wall-clock ms for expiry comparisons inside
 *     `collectAgentVisibleLivePenalties` and `findCuratedFallbackRoute`.
 *
 * Returns:
 *   The assembled system-prompt block, or `null` when there are no
 *   agent-visible penalties at all (delegated to
 *   `collectAgentVisibleLivePenalties`'s null sentinel).
 */
export function buildProviderHealthSystemPrompt(
  modelRegistryEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): string | null {
  // M90: `collectAgentVisibleLivePenalties` replaces the two inline
  // `Array.from(map.entries()).filter(...)` expressions and the
  // `both empty → null` early-return gate. See the helper docstring
  // for the three drift surfaces it closes (provider filter, route
  // filter, and both-empty null sentinel).
  const penalties = collectAgentVisibleLivePenalties(
    providerHealthMap,
    modelRouteHealthMap,
    now,
  );
  if (penalties === null) {
    return null;
  }
  const { providers: activeProviderPenalties, routes: activeRoutePenalties } = penalties;

  const sections: string[] = [];

  for (const [providerID, health] of activeProviderPenalties) {
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

    // M91: `formatPenaltySectionPrefix` replaces the inline
    // `const label = ...; const until = ...;` preprocess and the
    // two-element header construction. See the helper docstring
    // for the three drift surfaces it closes (header constant,
    // state label derivation, until formatter).
    sections.push([
      ...formatPenaltySectionPrefix(`Provider ${providerID}`, health),
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
    const owningEntry = modelRegistryEntries.find(
      (entry) =>
        entry.enabled &&
        entry.provider_order.some((route) => composeRouteKey(route) === routeKey),
    );

    // M91: see `formatPenaltySectionPrefix` docstring.
    const header = formatPenaltySectionPrefix(`Route ${routeKey}`, health);

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
 * Render the body of the "Available models by role/task" system-prompt
 * section from an already-filtered role-to-models map.
 *
 * This helper owns three drift-prone surfaces that the caller must never
 * re-inline, because each has bitten us before at parallel call sites:
 *
 *  1. **Role-row cap.** The number of role rows we render is bounded by
 *     `MAX_AVAILABLE_MODELS_ROLES_RENDERED`. The raw literal `8` used to
 *     live inline at the call site; every time we added a new role we
 *     risked exceeding the cap silently, or if the cap was tweaked by
 *     one call site but not a sibling the two sections drifted.
 *  2. **Row format.** Every row is `- ${role}: ${models.join(", ")}`.
 *     Any drift (bullet char, separator, colon spacing) is invisible
 *     to the caller but visible to the agent, and a drifted format
 *     becomes an unparsable instruction the agent silently ignores.
 *  3. **Empty-input null sentinel.** An empty map means "nothing to
 *     say" — the caller relies on `null` (not an empty string) so the
 *     section-assembler can `.filter(Boolean)` it out cleanly. Returning
 *     `""` instead of `null` used to cause a stray section header with
 *     a blank body to leak into the final prompt.
 *
 * Note on call-site empty-check: the outer
 * `buildAvailableModelsSystemPrompt` still uses
 * `hasAgentVisiblePenalty(...)` as a fast-path null gate before walking
 * the registry. The empty-map check here is the *post-walk* gate — it
 * fires when all registered entries were filtered out for route health
 * and no role rows survived, which is a different condition from the
 * pre-walk penalty gate.
 *
 * Args:
 *   roleToModels: Map from canonical role name to an ordered list of
 *     already-formatted `"${id} (${billing_mode})"` strings. The caller
 *     is responsible for applying per-role model caps before calling
 *     this helper; this helper only caps *which roles* are rendered.
 *
 * Returns:
 *   The fully assembled section string (header + rows), or `null` when
 *   the input map is empty.
 */
export function renderAvailableModelsSystemPromptBody(
  roleToModels: Map<string, string[]>,
): string | null {
  if (roleToModels.size === 0) {
    return null;
  }
  const lines = Array.from(roleToModels.entries())
    .slice(0, MAX_AVAILABLE_MODELS_ROLES_RENDERED)
    .map(([role, models]) => `- ${role}: ${models.join(", ")}`);
  return [AVAILABLE_MODELS_HEADER, ...lines].join("\n");
}

/**
 * Build a role+task filtered view of currently healthy models for the system prompt.
 * Only injected when at least one provider has a health penalty.
 *
 * ## Drift surfaces (M126 PDD)
 *
 * This assembler has three structurally independent drift surfaces. Each
 * one is a historically regressed invariant — the guards below look like
 * "obvious" one-liners, but every one of them was broken at least once
 * in the plugin's lifetime. Per-surface regression pins partition these
 * so a single-line drift fires exactly ONE new pin.
 *
 * ### Surface 1 — `hasAgentVisiblePenalty` fast-path null gate
 *
 * Pre-M58 the gate was `providerHealthMap.size === 0 && modelRouteHealthMap.size === 0`.
 * M58 then changed `initializeProviderHealthState` to install a
 * `key_missing` entry at boot for every uncredentialed curated provider
 * (typically 15–25 on a default install), so `providerHealthMap.size` is
 * effectively never zero and the pre-M58 gate became dead wiring. Every
 * agent turn fell through to a full registry walk and injected an
 * "Alternative models by role" section into the system prompt even when
 * nothing was actually broken. Drift here re-leaks that section on every
 * turn regardless of whether the agent has anything to route around.
 * Pin A anchors "empty maps → early null": the gate must return before
 * the walk when there is no penalty at all, not just when the maps are
 * literally empty.
 *
 * ### Surface 2 — `findFirstHealthyRouteInEntry` delegation (not inlined)
 *
 * This was the 7th inline copy of the "walk visible routes and check
 * provider-AND-route health" loop caught in the M65 dedupe sweep. Prior
 * sites drifted to `entry.provider_order[0]` with provider-only checks,
 * and that drift class (M23/M24) kept reappearing because the logic is
 * short enough to look trivial when you're reading a diff. Dropping the
 * delegation here resurrects the same shape: an entry whose priority-1
 * route is a hidden paid sibling (e.g. togetherai/* or xai/grok-*) gets
 * listed based on a route the rest of the plugin actively blocks, and
 * an entry whose only visible route is route-level-unhealthy
 * (`model_not_found`, route quota) gets listed as available despite
 * being provably dead. Pin B anchors the "route-level unhealthy sole
 * visible route" variant specifically, so the regression fires when the
 * delegation is stripped even if provider-level health happens to align.
 *
 * ### Surface 3 — per-role `existing.length < 2` cap
 *
 * The cap bounds each role row to at most 2 alternatives. It exists
 * because the point of this section is "here are a couple of other
 * models you can try" — not a full dump of every entry default-assigned
 * to the role. On a populated registry, popular roles (implementation,
 * review, reader) can have 6–10 entries, and without the cap the
 * section balloons into a screen of output on every turn the gate
 * fires, pushing actual agent instructions off-screen in constrained
 * terminals and inflating per-turn tokens. Drift here (cap dropped or
 * the constant miscomputed) cannot be caught by Surface 1 or 2 pins
 * because it only manifests when >2 entries share a role AND the gate
 * is already open AND all routes are healthy. Pin C pins this:
 * 3 entries sharing one role, gate opened by an unrelated live
 * penalty, all routes healthy — the rendered output must show exactly
 * 2 models for the role, and specifically must NOT contain the third
 * entry's id.
 *
 * ### Why asymmetric
 *
 * Each surface is independently regression-prone and independently
 * catastrophic: S1 leaks the whole block on every turn, S2 resurrects
 * the M23/M24/M65 drift class and lists dead or hidden routes as
 * available, S3 bloats the prompt. Pre-existing pins at
 * `buildAvailableModelsSystemPrompt_whenOnlyKeyMissingPenaltiesExist_returnsNull`
 * and `_whenOnlyVisibleRouteIsUnhealthyAtRouteLevel_skipsEntry` fire
 * additively on S1/S2 but none of them exercise the cap at Surface 3,
 * so a cap drift ships silently today. The new asymmetric trio below
 * closes that gap and makes each surface separately observable.
 */
export function buildAvailableModelsSystemPrompt(
  modelRegistryEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): string | null {
  // Fire only when at least one AGENT-VISIBLE penalty exists. Pre-M58
  // the narrow `size === 0` check was sufficient because the only way
  // an entry reached either map was through a live failure, but post-M58
  // `providerHealthMap` always contains a `key_missing` entry for every
  // uncredentialed curated provider (typically 15–25 on a default
  // install). `size === 0` is effectively never true, so every single
  // agent turn used to fall through to a full registry walk and push an
  // "Alternative models by role" section into the system prompt even
  // when nothing was actually wrong — the block's entire purpose is
  // "here's what to try when something breaks" and key_missing isn't
  // something the agent can route around. See `hasAgentVisiblePenalty`
  // docstring for the full rationale.
  if (!hasAgentVisiblePenalty(providerHealthMap, modelRouteHealthMap, now)) {
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

    // M65: delegate to `findFirstHealthyRouteInEntry` (which itself
    // delegates to `isRouteCurrentlyHealthy`) instead of inlining the
    // predicate. This was a stray 7th inline copy missed in the M64
    // dedupe sweep — same bug class, same "(provider healthy) AND
    // (route health expired or absent)" shape. See M64 Completion
    // Notes + `isRouteCurrentlyHealthy` docstring for the drift
    // history that motivates the single-source-of-truth boundary.
    const firstHealthyVisibleRoute = findFirstHealthyRouteInEntry(
      entry,
      providerHealthMap,
      modelRouteHealthMap,
      now,
    );
    if (!firstHealthyVisibleRoute) continue;

    for (const role of entry.default_roles) {
      const existing = roleToModels.get(role) ?? [];
      if (existing.length < 2) {
        existing.push(`${entry.id} (${entry.billing_mode})`);
        roleToModels.set(role, existing);
      }
    }
  }

  return renderAvailableModelsSystemPromptBody(roleToModels);
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
 * Keyword stems for `small` complexity — trivial, bounded, mechanical
 * tasks where spending strong/frontier-tier capacity is overkill. Word-
 * boundary rule is the same as the other tiers.
 *
 * Historically `inferTaskComplexity` never returned `"small"`: the
 * function only tested LARGE then MEDIUM regexes, then defaulted to
 * medium. The `TaskComplexity` type and the `tierMap` both declared a
 * `"small"` row (mapping to `["tiny", "fast", "standard"]`) but the
 * inference path could not produce it, so every trivial prompt —
 * "fix typo in README", "rename foo to bar", "remove trailing
 * whitespace" — got routed into the medium tier's standard+strong
 * candidate set. The `small` row was dead code reachable only via
 * explicit `task.complexity = "small"` or agent frontmatter
 * `routing_complexity: small`, and the inference-path callers
 * (`recommendTaskModelRoute` with neither override) could not reach
 * it at all. Effect: trivial ops burned frontier/strong-tier capacity
 * unnecessarily, and the tiny+fast tier rows in `models.jsonc` were
 * never selected by any inferred-complexity session.
 *
 * Conservative stems: keep the vocabulary narrow so we don't flip a
 * legitimate medium/large task into the tiny/fast tier. Stems chosen:
 *   - `typo`: "fix typo", "typos in docs"
 *   - `rename`: "rename foo to bar", "renames the field"
 *   - `trivial`: explicit operator signal
 *   - `minor`: "minor version bump", "minor doc tweak"
 *   - `whitespace`: formatting-only changes
 *
 * Deliberately omitted: `simple`, `small`, `quick`, `easy` — too
 * subjective and routinely used in prompts that are actually medium
 * work ("simple implementation of the payments flow"). `comment` /
 * `docstring` — collides with "implement comment parser" etc. The
 * stems above are concrete mechanical operations, not adjectives.
 */
const SMALL_COMPLEXITY_KEYWORD_STEMS = [
  "typo", "rename", "trivial", "minor", "whitespace",
] as const;

/**
 * Keyword stems for `medium` complexity. Same word-boundary rule: previously
 * `"add"`, `"fix"`, `"test"` matched "address", "prefix", "latest" as
 * substrings.
 */
const MEDIUM_COMPLEXITY_KEYWORD_STEMS = [
  "implement", "add", "update", "fix", "debug", "test", "verify",
  "improve", "enhance", "optimize", "integrate", "connect",
] as const;

/**
 * Compile a leading-word-boundary alternation regex from a list of keyword
 * stems — the single source of truth for the three complexity-classification
 * regexes (`LARGE_COMPLEXITY_REGEX`, `SMALL_COMPLEXITY_REGEX`,
 * `MEDIUM_COMPLEXITY_REGEX`).
 *
 * Three independent drift surfaces live inside this builder. Each has a
 * concrete failure history behind it, so the helper body must preserve
 * every one of them in lockstep:
 *
 *  1. **Leading word boundary only.** The pattern is `\b(?:<alt>)` — a
 *     leading `\b` with NO trailing boundary. This is deliberate: stems
 *     like `"refactor"` must match inflections `"refactoring"` /
 *     `"refactored"` / `"refactors"`, stems like `"update"` must match
 *     `"updates"` / `"updated"`, and stems like `"system"` must match
 *     `"systems"` / `"systemic"`. A refactor that adds a trailing `\b`
 *     produces exact-word matches that silently drop every inflection —
 *     the complexity classifier then under-tiers a "refactoring the
 *     architecture" prompt to `medium` because `refactor` no longer
 *     matches `refactoring`, and the agent gets a standard-tier model
 *     on a frontier-tier task.
 *  2. **Regex metacharacter escape.** The stem list is user-data from
 *     the module-level constants, which may legitimately contain `.` /
 *     `+` / `(` / `)` / `?` / etc. (e.g. a future stem like `"c++"` or
 *     `"node.js"`). The `.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` step
 *     escapes every regex metachar in each stem before joining them
 *     with `|`, so the stem is matched literally. A refactor that drops
 *     the escape silently turns `.` into "any character" and matches
 *     nonsense — a stem `"node.js"` would match `"nodeXjs"` or
 *     `"node js"`, and the classifier would fire on prompts that
 *     contain a completely unrelated substring.
 *  3. **Case-insensitive flag.** The `"i"` flag on `new RegExp(...)` is
 *     what lets the classifier match `"REFACTOR THIS"` against a lower-
 *     case stem `"refactor"`. A refactor that drops the flag produces a
 *     case-sensitive regex that misses every capitalized prompt — the
 *     classifier silently under-tiers any prompt the user types in
 *     mixed case, and the bug is especially pernicious because the
 *     unit tests (which all use lowercase) still pass while production
 *     traffic (human-typed prompts with leading caps) silently mis-routes.
 *
 * Args:
 *   stems: Keyword stems to alternate. Each stem is escaped for regex
 *     metachars and joined with `|` inside a non-capturing group.
 *
 * Returns:
 *   A compiled `RegExp` with the leading boundary + case-insensitive
 *   flag; feed it `prompt.toLowerCase()` (or rely on the `i` flag for
 *   mixed-case input).
 *
 * ## Drift surfaces (M129 PDD)
 *
 * The three pre-existing pins (`_whenStemIsRefactor_matchesInflection
 * Refactoring`, `_whenStemContainsDot_escapesDotAsLiteral`,
 * `_whenStemIsLowerCaseButPromptIsUpperCase_matches`) each exercise the
 * happy-path for one of the prose surfaces above. They collectively
 * check that inflection-matching works, one metachar escapes correctly,
 * and the case flag is set. They DO NOT catch three orthogonal
 * regressions that sit on the REJECTION half of the contract — the
 * boundary that prevents a false match, the structural join that
 * preserves multi-stem alternation, and the metachar coverage beyond
 * the single `.` character:
 *
 * 1. **Leading `\b` REJECTS mid-word matches.** The pattern opens with
 *    `\b` so a stem like `"fix"` matches `"fixing this"` at the start
 *    but NOT `"postfix issue"` mid-word. The classifier relies on this
 *    to avoid false-positives where a prompt happens to contain a
 *    complexity keyword as a suffix of an unrelated word — e.g.
 *    `"postfix notation"` should not tier-match on `"fix"` and
 *    mis-classify as `medium`. Pin 1 (`refactor`/`refactoring`) only
 *    exercises the NO-trailing-boundary axis (the stem matches a word
 *    with characters AFTER it); it passes identically whether `\b` is
 *    present at the start or not, because the test input
 *    `"refactoring the architecture"` starts at a word boundary
 *    regardless. A refactor that drops the leading `\b` (the
 *    "boundaries are symmetric, if trailing is absent leading is
 *    redundant too" drift class) would silently widen every complexity
 *    regex to substring matching — a prompt like `"just a postfix
 *    note"` would now match `fix` and tier up to `medium` even though
 *    the intent is trivial. New pin: stem `"fix"`, input
 *    `"postfix note"`, asserts `.test() === false`.
 *
 * 2. **Multi-stem alternation preserved across `|` join.** The
 *    builder's only non-trivial structural step is
 *    `.map(escape).join("|")` — it threads every stem through the
 *    escape step and joins them with the regex alternation operator.
 *    The three pre-existing pins all pass a SINGLE stem, so the
 *    join step is a no-op on every one of them and any drift that
 *    collapses multi-stem inputs silently passes all three pins. A
 *    refactor that swaps `.join("|")` → `.join("")` (concatenation
 *    instead of alternation, plausible typo or "simplification" from
 *    a developer who doesn't recognize the regex-alternation role)
 *    would produce a regex `\b(?:alphabeta)` from `["alpha","beta"]`
 *    — neither stem matches anything resembling itself. Every live
 *    call site feeds multi-element stem lists
 *    (`LARGE_COMPLEXITY_KEYWORD_STEMS`, `MEDIUM_COMPLEXITY_KEYWORD_STEMS`,
 *    `SMALL_COMPLEXITY_KEYWORD_STEMS`), so the production classifier
 *    would silently degrade to "first-stem-concatenated-with-everything"
 *    and miss every legitimate keyword match, defaulting the whole
 *    complexity classification path to `medium` on every prompt. New
 *    pin: `stems = ["alpha", "beta"]`, assert both `"alpha-stage"`
 *    and `"beta-stage"` match.
 *
 * 3. **Metachar escape covers `+`, not just `.`.** The escape regex
 *    `/[.*+?^${}()|[\]\\]/g` covers eleven metacharacters. Pin 2 only
 *    asserts the `.` character is escaped. Each other metachar has an
 *    independent drift surface: a "cleanup" refactor that drops one
 *    metachar from the character class would silently unescape that
 *    char on every stem. `+` is the canonical example of a metachar
 *    with SEMANTIC side-effects under drift — an unescaped `+` means
 *    "one or more of the previous char", so a stem `"a+b"` would
 *    become the regex `\b(?:a+b)` ("one or more `a` followed by `b`"),
 *    which DOES NOT match the literal input `"a+b"` (because the `+`
 *    literal is not matched by the pattern that now expects `b` right
 *    after the `a`-run). A drift that drops `+` from the character
 *    class therefore produces a function that silently refuses to
 *    match ANY input containing the literal stem, on every call site
 *    using a `+` in its stem list. No current stem uses `+`, but the
 *    escape invariant is part of the contract and future stem authors
 *    (think `"c++"`, `"go+generics"`) must be able to rely on it. New
 *    pin: `stems = ["a+b"]`, input `"use a+b here"`, asserts
 *    `.test() === true`. Under the sabotage the regex becomes
 *    `\b(?:a+b)` which fails to match the literal `a+b` substring,
 *    and the pin fires.
 */
export function buildLeadingBoundaryRegex(stems: readonly string[]): RegExp {
  const alternation = stems.map((stem) => stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`\\b(?:${alternation})`, "i");
}

const LARGE_COMPLEXITY_REGEX = buildLeadingBoundaryRegex(LARGE_COMPLEXITY_KEYWORD_STEMS);
const SMALL_COMPLEXITY_REGEX = buildLeadingBoundaryRegex(SMALL_COMPLEXITY_KEYWORD_STEMS);
const MEDIUM_COMPLEXITY_REGEX = buildLeadingBoundaryRegex(MEDIUM_COMPLEXITY_KEYWORD_STEMS);

function inferTaskComplexity(prompt: string, _explicitComplexity: TaskComplexity | null): TaskComplexity {
  const lowerPrompt = prompt.toLowerCase();

  // Large wins over small: a prompt like "refactor and rename foo across
  // modules" contains both signals but the refactor scope dominates the
  // rename mechanic. Medium-vs-small is the interesting tie: "fix typo"
  // matches both medium ("fix") and small ("typo"); small must win so
  // trivial mechanical ops don't get routed to the standard+strong tier.
  if (
    LARGE_COMPLEXITY_REGEX.test(lowerPrompt) ||
    LARGE_COMPLEXITY_LITERAL_PHRASES.some((phrase) => lowerPrompt.includes(phrase))
  ) {
    return "large";
  }

  if (SMALL_COMPLEXITY_REGEX.test(lowerPrompt)) {
    return "small";
  }

  if (MEDIUM_COMPLEXITY_REGEX.test(lowerPrompt)) {
    return "medium";
  }

  // Default to medium for unspecified tasks
  return "medium";
}

/**
 * Strip a single layer of matching leading/trailing YAML quote characters
 * from a scalar value. Idempotent on unquoted input; only strips quotes
 * when BOTH ends carry the SAME quote character so asymmetric inputs
 * (`"foo` or `foo'`) are preserved verbatim rather than corrupted.
 *
 * History: the old `readAgentMetadata` frontmatter parser read scalar
 * values (`model:`, `routing_role:`, `routing_complexity:`) with a bare
 * `line.slice(colonIndex + 1).trim()` and assigned the trimmed string
 * directly. An agent that authored its model preference as a quoted YAML
 * scalar — perfectly valid YAML, and arguably required when the model id
 * contains colons like `openrouter/stepfun/step-3.5-flash:free` — would
 * end up with `metadata.model === '"openrouter/stepfun/step-3.5-flash:free"'`
 * (literal quote chars baked into the string). The preferred-models
 * lookup in `recommendTaskModelRoute` then does strict `route.model ===
 * preferredModel` comparison against unquoted registry routes and silently
 * misses every match, dropping the explicit agent preference and falling
 * back to `selectBestModelForRoleAndTask`. The inline models-block parser
 * (`metadata.models`) already stripped quotes from list items via
 * `.replace(/^["']|["']$/g, "")`, so the scalar path was the only site
 * still vulnerable — and the inconsistency itself was a smell.
 *
 * The matched-pair rule is stricter than the old models-block helper
 * (which accepted mismatched quote chars at either end), because the
 * scalar case has no inner-quote semantics to defend and a stricter rule
 * catches accidental copy-paste errors upstream.
 *
 * ## Drift surfaces (M131 PDD)
 *
 * The five existing pins cover unquoted passthrough, double-quoted
 * strip, single-quoted strip, the three asymmetric variants, and the
 * length-<-2 edge cases — good breadth on the happy paths and the
 * explicit rejection branches, but three orthogonal invariants sit
 * below that coverage and each has a plausible refactor that breaks
 * it:
 *
 *  A. **Single-layer strip, not recursive.** The function strips
 *     EXACTLY ONE matching pair of leading+trailing quotes and stops.
 *     An input like `""foo""` (double-double-quoted, legitimate when
 *     an agent author encodes a quoted value inside a quoted scalar
 *     for escaping) must yield `"foo"` — the inner pair is preserved
 *     as literal content. A "helpful" refactor that recurses while
 *     quotes still match would descend into `"foo"` → `foo`, silently
 *     eating the author-intended inner quotes. None of the existing
 *     pins exercises a doubly-quoted input; they all use single-layer
 *     values, so a recursive rewrite ships green.
 *
 *  B. **Length-2 matched pair strips to the empty string.** The
 *     guard is `length < 2` (strict), so a length-2 input like `""`
 *     or `''` — a matched pair with an empty interior — falls
 *     through to the slice branch and returns `""`. A "simplify the
 *     boundary" refactor to `length <= 2 return rawValue` leaves `""`
 *     and `''` unchanged, and every frontmatter scalar that was
 *     authored as an explicitly-empty quoted value ships as a
 *     literal two-character string (`'""'`) instead of the empty
 *     string the YAML spec requires. Existing pin E only tests
 *     length 0 and length 1 (empty and a single `"`), both of which
 *     remain unchanged under the `<=` variant, so the regression is
 *     invisible to it.
 *
 *  C. **Only `"` and `'` are recognized quote characters — backtick
 *     is not.** YAML does not assign any quoting semantics to `` ` ``,
 *     so `` `foo` `` is a literal 5-character string and must pass
 *     through unchanged. A "let's also support Markdown-style
 *     backtick quoting" refactor that widens the recognized set to
 *     `['"', "'", '`']` would silently strip the backticks off any
 *     agent scalar that contains a backticked literal (e.g. a model
 *     id quoted in a rationale comment that got copy-pasted into a
 *     scalar), corrupting the value. No existing pin feeds a
 *     backticked input — they all use either unquoted, `"`-quoted,
 *     or `'`-quoted values.
 *
 * Asymmetric sabotage model: pin A fires on any recursion (S1), pin
 * B fires on any `< → <=` length-guard loosening (S2), pin C fires
 * on any quote-char-set widening to include backtick (S3). The three
 * sabotages are orthogonal — none of them touches the other two's
 * invariant surfaces, and none touches the five existing pins'
 * single-layer / asymmetric / length-0-or-1 surfaces — so each new
 * pin fires alone in its partition.
 *
 * Args:
 *   rawValue: The already-trimmed scalar from one frontmatter line.
 *
 * Returns:
 *   The value with one layer of matching quotes removed, or the original
 *   string unchanged when it is not quoted or when the quote characters
 *   do not match.
 */
export function stripYamlScalarQuotes(rawValue: string): string {
  if (rawValue.length < 2) return rawValue;
  const firstChar = rawValue[0];
  const lastChar = rawValue[rawValue.length - 1];
  if ((firstChar === '"' || firstChar === "'") && firstChar === lastChar) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}

/**
 * Parse an agent file's YAML-frontmatter block into typed metadata.
 *
 * Split out of `readAgentMetadata` so the parsing contract — including
 * quote stripping, block-list collection, and invalid-complexity
 * rejection — can be exercised directly without touching the filesystem.
 *
 * Args:
 *   frontmatterText: The text between the opening `---` and closing
 *     `---` fences (NOT including the fences themselves).
 *
 * Returns:
 *   An `AgentMetadata` object populated from recognized keys. Keys the
 *   parser does not recognize are silently ignored. Returns a metadata
 *   object with no populated fields (rather than `null`) when every line
 *   is ignored — the `readAgentMetadata` caller is responsible for
 *   deciding whether an empty metadata object is useful.
 *
 * ## Drift surfaces (M117 PDD)
 *
 * Pre-M117 the seven existing pins cover quote stripping across model /
 * models / routing_role / routing_complexity scalar paths (M53), the
 * block-list and inline flow-style item variants, and the invalid-
 * complexity rejection — good breadth, but three line-discipline and
 * key-matching invariants have zero direct coverage and each has a
 * plausible regression:
 *
 * 1. **Block-list peek loop preserves the terminator line for the next
 *    outer-loop iteration.** The current shape is `if (!blockMatch)
 *    break;` BEFORE `lineIndex += 1;`, so the line that ends the block
 *    list (typically the next `key:` pair) is re-read by the outer
 *    `while (lineIndex < ...)` and processed normally. A refactor that
 *    "cleans up" the increment by moving `lineIndex += 1` to the top of
 *    the peek loop (or any position before the break) silently consumes
 *    the terminator: after parsing `models:\n  - a\n  - b\nrouting_role:
 *    X`, the `routing_role: X` line is eaten by the peek-increment and
 *    the outer loop resumes at the line AFTER it, so `metadata
 *    .routing_role` is silently dropped. Every agent file that declares
 *    a `models:` block immediately followed by `routing_role:` /
 *    `routing_complexity:` — which is most of them — would lose its
 *    explicit role/complexity hints on the next plugin load, and
 *    `recommendTaskModelRoute` would fall back to inference. No existing
 *    pin exercises the block-list → scalar-key sequence because the M53
 *    block-list pin ends the frontmatter with the last list item.
 *
 * 2. **Key matching is strict `===` equality, not `.startsWith`.** The
 *    `if (key === "model")` / `"models"` / `"routing_role"` /
 *    `"routing_complexity"` chain uses exact comparison, so a sibling
 *    key like `model_preference`, `model_override`, or `models_hint`
 *    lands in none of the branches and is silently ignored. A plausible
 *    "let future variants flow through" refactor to `key.startsWith(
 *    "model")` would have `model_preference: bar` match the `model`
 *    branch first and clobber the real `model: openrouter/foo` value —
 *    whichever assignment comes later wins. Worse, `models:` (plural)
 *    would also match the `model` branch via the prefix test, so
 *    existing agents' `models:` block lists would silently populate
 *    `metadata.model` with an empty string instead of `metadata.models`
 *    with the block items, breaking every multi-model preference file.
 *    No existing pin exercises a sibling key that SHARES the `model`
 *    prefix.
 *
 * 3. **Block-list regex requires leading whitespace (`\s+`, not
 *    `\s*`).** YAML permits block lists only when the items are
 *    indented inside their parent key. Column-0 `- a` at the same
 *    indentation as `models:` is not a nested list item — it is a
 *    standalone sequence node that cannot be attached to the preceding
 *    mapping. The regex `/^\s+-\s+(.*)$/` enforces this: column-0
 *    dashes do not match, the peek loop breaks, and `metadata.models`
 *    stays empty. A "simplification" to `/^\s*-\s+(.*)$/` (one
 *    character dropped) accepts column-0 dashes as list items, which
 *    silently pulls in whatever sequence nodes happen to follow the
 *    `models:` line in the same frontmatter — and since frontmatter is
 *    usually hand-authored, a dangling dash-prefixed line from a
 *    comment or a broken list would populate `metadata.models` with
 *    garbage. No existing pin exercises a column-0 dash as a negative
 *    case.
 */
export function parseAgentFrontmatter(frontmatterText: string): AgentMetadata {
  const metadata: AgentMetadata = {};

  // Line-oriented parser that also understands YAML block lists:
  //   models:
  //     - provider/model-a
  //     - provider/model-b
  // When a `key:` has an empty scalar value, peek the next lines and
  // collect indented `- item` entries until we hit a non-list line.
  const frontmatterLines = frontmatterText.split("\n");
  let lineIndex = 0;
  while (lineIndex < frontmatterLines.length) {
    const line = frontmatterLines[lineIndex] ?? "";
    lineIndex += 1;

    const colonIndex = line.indexOf(":");
    if (colonIndex < 1) continue;

    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    const value = stripYamlScalarQuotes(rawValue);

    if (key === "model") {
      metadata.model = value;
    } else if (key === "models") {
      const inlineItems = rawValue.length > 0
        ? rawValue
            .replace(/^\[|\]$/g, "") // strip flow-style brackets if present
            .split(/\s*,\s*/)
            .map((item) => stripYamlScalarQuotes(item.trim()))
            .filter((item) => item.length > 0)
        : [];

      const blockItems: string[] = [];
      while (lineIndex < frontmatterLines.length) {
        const peekLine = frontmatterLines[lineIndex] ?? "";
        const blockMatch = peekLine.match(/^\s+-\s+(.*)$/);
        if (!blockMatch) break;
        const item = stripYamlScalarQuotes((blockMatch[1] ?? "").trim());
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
    if (!frontmatter) {
      return null;
    }

    return parseAgentFrontmatter(frontmatter);
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

/**
 * Return the ordered list of environment variable names that, when set,
 * should be treated as a valid credential for `providerID` in lieu of
 * (or in addition to) an `auth.json` entry.
 *
 * This helper is the sole source of truth for three independent drift
 * surfaces the key-missing / env-var-fallback logic relies on. Each
 * surface has a concrete failure mode:
 *
 *  1. **Override table consultation.** `PROVIDER_ENV_VAR_OVERRIDES`
 *     pins providers whose env var name does NOT follow the
 *     conventional `<PROVIDER>_API_KEY` pattern, OR whose credential
 *     can come from one of several names. Google is the canonical
 *     multi-name case: `["GEMINI_API_KEY", "GOOGLE_API_KEY"]`. A
 *     refactor that drops the `if (overrides) return overrides;`
 *     early-return (the "always compute the conventional form" drift
 *     class) silently collapses the override list down to whatever the
 *     conventional form happens to produce — for google that is
 *     `["GOOGLE_API_KEY"]` alone, so anyone configured solely via
 *     `GEMINI_API_KEY` is false-flagged `key_missing` and the entire
 *     google provider is suppressed from routing at plugin init even
 *     though the credential is present and opencode itself honours it.
 *     The override table is also the only way to add MULTIPLE env var
 *     candidates for one provider (togetherai: both `TOGETHER_API_KEY`
 *     and `TOGETHERAI_API_KEY`), so dropping the early return also
 *     collapses multi-name providers to the conventional form only.
 *
 *  2. **Dash-to-underscore normalization.** Provider IDs use kebab
 *     case (`ollama-cloud`, `kimi-for-coding`, `github-copilot`), but
 *     POSIX shell env var names must match `[A-Za-z_][A-Za-z0-9_]*` —
 *     a literal `-` is not a legal env var character. The
 *     `.replace(/-/g, "_")` step is what lets the conventional form
 *     produce a valid name from a dashed provider ID. A refactor that
 *     drops the replacement (the "providers are plain words" drift
 *     class) silently produces syntactically-invalid names like
 *     `OLLAMA-CLOUD_API_KEY` that no shell will ever set, so every
 *     dashed provider without an explicit override entry is
 *     permanently false-flagged `key_missing` at the env var fallback
 *     layer.
 *
 *  3. **Uppercase + `_API_KEY` suffix composition.** The conventional
 *     form is `<UPPERCASE_PROVIDER>_API_KEY`. A refactor that drops
 *     the `.toUpperCase()` step (the "env vars are case-insensitive"
 *     drift class) produces lowercase names that fail the POSIX shell
 *     convention and are not honoured by any real env; a refactor that
 *     drops the `_API_KEY` suffix produces bare provider names that
 *     collide with other variables and obviously never match opencode's
 *     env var scheme. Both drifts silently disable the env var
 *     fallback for every non-overridden provider.
 *
 * Args:
 *   providerID: The opencode provider id (kebab-case, e.g.
 *     `"openrouter"`, `"ollama-cloud"`, `"kimi-for-coding"`).
 *
 * Returns:
 *   An ordered list of env var names to consult. Overridden providers
 *   return the pinned override list verbatim; non-overridden providers
 *   return a single-element list containing the conventional form.
 */
export function providerEnvVarCandidates(providerID: string): readonly string[] {
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
 *
 * Accepts the real opencode schemas, the legacy `{ apiKey }` shape (to keep
 * older fixtures working), and bare string values (used in some legacy tests).
 *
 * OAuth semantics: opencode persists oauth credentials as
 * `{ type: "oauth", access: "...", refresh: "..." }`. When an access token
 * expires or is explicitly cleared, opencode leaves `access` empty and
 * uses the `refresh` token to mint a new access token on the next
 * provider request — entirely transparent to the caller. From the
 * plugin's perspective, the entry is still a USABLE credential: the
 * provider WILL be callable the moment anything tries to use it. The
 * pre-M55 predicate only inspected `access`, so a `{ access: "",
 * refresh: "<valid>" }` entry would flag the provider as `key_missing`
 * at plugin init, cascading into a 2h `key_missing` health penalty that
 * suppressed the provider from every routing decision — a plugin-level
 * outage that opencode itself would have resolved transparently on the
 * first request. Honor the refresh token as an independent usability
 * signal so the plugin's view of provider availability matches
 * opencode's.
 *
 * Args:
 *   entry: A parsed JSON value from auth.json.
 *
 * Returns:
 *   true iff the entry carries at least one non-empty credential field
 *   under any of the recognized schemas.
 */
export function hasUsableCredential(entry: unknown): boolean {
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
    const accessToken = typeof record.access === "string" ? record.access : "";
    const refreshToken = typeof record.refresh === "string" ? record.refresh : "";
    return accessToken.length > 0 || refreshToken.length > 0;
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
 * Find the first healthy route for an agent's explicit preferred-model list.
 *
 * Iterates `preferredModels` in author order, then `candidateEntries` for
 * each preference, and returns the first healthy route in one of four
 * shapes: exact preferred route, exact provider/different route in the
 * same registry entry (same model family, different provider fallback),
 * or `null` if nothing healthy is found for any preference.
 *
 * Why the caller must pass `candidateEntries` that are NOT tier-filtered:
 * an agent that declares `model: minimax/MiniMax-M2.5` (frontier tier)
 * with no explicit `routing_complexity:` used to have its preference
 * silently dropped whenever `inferTaskComplexity` returned `"small"` or
 * `"medium"` for a particular prompt. The caller built `roleMatchedEntries`
 * by applying BOTH the role filter AND the complexity-tier filter, then
 * scanned that narrowed set for the preferred model. If the preferred
 * model's tier was outside the inferred-complexity allowed tiers, the
 * entry was not in `roleMatchedEntries` at all — the preferred-models
 * loop found no match, silently fell through to
 * `selectBestModelForRoleAndTask`, and routed the task to some tiny/fast
 * model the agent never asked for. An explicit agent preference is a
 * stronger signal than an inferred complexity: when the author writes
 * down a specific model, they know what they want, and the router must
 * NOT override that with a keyword-based inference. The role filter is
 * still honored because an agent's declared role is also an explicit
 * author signal; only the complexity-tier filter is dropped for this
 * lookup. Extracted as a pure helper so the contract can be pinned with
 * unit tests without constructing the whole plugin.
 *
 * Args:
 *   preferredModels: Author-ordered list of composite `provider/model-id`
 *     routes from agent frontmatter (`model:` or `models:`). Empty list
 *     returns `null` immediately.
 *   candidateEntries: Registry entries filtered by role (if any) but NOT
 *     by capability tier. The caller is responsible for not leaking a
 *     complexity-tier filter into this list.
 *   providerHealthMap: Provider-level health map for the "is this route
 *     callable right now?" check.
 *   modelRouteHealthMap: Route-level health map for the same check.
 *   now: Wall-clock timestamp in ms.
 *
 * Returns:
 *   A decision object when a healthy preferred route is found, or `null`
 *   when no preference matches any healthy route in the candidate set.
 */
/**
 * Filter registry entries down to those that are (a) enabled AND (b) match
 * an optional role — the two-predicate intersection that three call sites
 * in the routing path all need as their first-stage narrowing pass.
 *
 * This helper exists because three sites (`recommendTaskModelRoute`'s
 * `roleMatchedEntries`, `recommendTaskModelRoute`'s `rolePreferredEntries`,
 * and `selectBestModelForRoleAndTask`'s candidate filter) each inlined the
 * same two-predicate open-coded pattern before layering on their own
 * site-specific extra filters (capability tier for the first, nothing for
 * the second, task/capability tier for the third). Three drift surfaces
 * lived as conventions across those inlined copies rather than as
 * single-site properties of one helper:
 *
 *  1. **Enabled-gate semantics.** Every routing decision must exclude
 *     `entry.enabled === false` entries — a globally-disabled model must
 *     never be handed to the router as a candidate, even if its role and
 *     tier match. A refactor that drops the `!entry.enabled` short-circuit
 *     in ONE site silently resurrects disabled models at that site while
 *     the other sites still filter them out, producing an inconsistent
 *     decision surface where a model is "available" to one path and
 *     "unavailable" to another.
 *  2. **Null-role passthrough.** When the caller passes `role === null`
 *     (agent metadata declared no `routing_role`), the filter MUST allow
 *     every role through — the short-circuit `if (role && ...)` is the
 *     idiom every site used, but a refactor that flips it to
 *     `if (!entry.default_roles.includes(role))` (dropping the null guard)
 *     turns `Array.prototype.includes(null)` into a universal false and
 *     silently empties the candidate set for every null-role caller. The
 *     failure mode is "every null-role task throws 'no healthy route',"
 *     which looks like an outage even though HEAD is healthy.
 *  3. **Role-membership exactness.** When the caller passes a concrete
 *     role, only entries whose `default_roles` array contains that exact
 *     string survive. A refactor that weakens the check (substring match,
 *     case-insensitive, `.some(r => r.startsWith(role))`) silently lets
 *     tangentially-related entries into the candidate set — an entry
 *     tagged `["architect_reviewer"]` would slip through a `role === "architect"`
 *     filter under substring matching.
 *
 * The helper returns a shallow copy (via `.filter`) so callers can safely
 * chain `.sort()` / `.filter()` without mutating the input array.
 *
 * Args:
 *   modelRegistryEntries: All registry entries. Walked once, no mutation.
 *   role: Canonical role name or `null`. When `null`, the role predicate
 *     is skipped entirely (every enabled entry survives the role stage).
 *
 * Returns:
 *   A new array of entries satisfying both predicates, in input order.
 *
 * ## Drift surfaces (M128 PDD)
 *
 * Three pre-existing M95 pins cover the three filter-predicate surfaces
 * (enabled gate, null-role passthrough, exact role-membership). Every
 * one of those pins asserts *which entries survive* the filter and
 * none of them asserts anything about the SHAPE of the return value —
 * its identity, its ordering, or its non-mutation of the input. Three
 * orthogonal return-shape invariants live here that a plausible
 * optimization refactor could erode silently beneath the existing
 * coverage:
 *
 *   1. **Return value is a fresh array, not the input reference.** The
 *      docstring above promises: "callers can safely chain `.sort()` /
 *      `.filter()` without mutating the input array." A "fast-path"
 *      refactor (`if (every entry is enabled && role is null) return
 *      modelRegistryEntries;`) would silently return the input reference
 *      when nothing needs filtering — the three existing pins all force
 *      something to be dropped so they never exercise the identity-
 *      preservation path. A downstream caller that then does
 *      `result.sort((a, b) => ...)` sorts the registry entries array in
 *      place, and every other consumer of the shared registry then sees
 *      a reordered `provider_order`-bearing array — capability-tier
 *      selection, role-recommendation rendering, and the registry-entry
 *      health report all use entry order as a stable author-intent
 *      hint. The pin exercises the "all entries pass, role is null"
 *      fast-path and asserts strict identity inequality, so any such
 *      short-circuit fires this pin alone.
 *
 *   2. **Input order is preserved across survivors.** The docstring
 *      promises "in input order", because every downstream ranking
 *      (preferred-models, recommendation routes, capability-tier
 *      walks) treats position in `registry.models` as the canonical
 *      author-intent tiebreaker. A refactor that slips a `.sort()`
 *      step in (even one as innocuous as "sort by id so the test
 *      snapshot stabilizes") silently reorders the survivors and the
 *      downstream ranking follows the sort key instead of the author
 *      key. The three existing pins use at most one or two entries or
 *      use .has()-style assertions that don't pin order, so a
 *      post-filter sort ships green. The pin uses three entries
 *      authored as `[Z, A, M]` (letters chosen to be sort-unstable
 *      relative to both input order and alphabetical order) and
 *      asserts the result's .id array equals `["Z", "A", "M"]`.
 *      Asymmetric wrt pin 1: the sort still creates a fresh array so
 *      pin 1 (identity) passes; asymmetric wrt pin 3: the sort does
 *      not mutate the input so pin 3 (input non-mutation) passes.
 *
 *   3. **Input array is not mutated in place.** A refactor that
 *      "reuses" the input storage (`modelRegistryEntries.length = ...`
 *      or an in-place `.splice()` loop that rewrites the array to
 *      contain only survivors) breaks every other consumer of the
 *      same registry reference, and the M95 filter pins can't detect
 *      this at all because they only check the RETURN value. The pin
 *      holds a reference to the input array, the `.length` before
 *      the call, and a snapshot of the input's ids; after the call
 *      the pin asserts the input length is unchanged and the input
 *      id sequence is unchanged — isolating any in-place mutation
 *      strategy. Asymmetric wrt pin 1: an in-place mutation
 *      implementation could still return a fresh array (e.g. `const
 *      out = [...survivors]; input.length = 0; input.push(...out);
 *      return out;`) and pin 1 would pass while pin 3 fires.
 *      Asymmetric wrt pin 2: the input-mutation path could still
 *      keep survivor order in the returned array, so pin 2 passes
 *      while pin 3 fires.
 */
export function filterEnabledEntriesByOptionalRole(
  modelRegistryEntries: ModelRegistryEntry[],
  role: string | null,
): ModelRegistryEntry[] {
  return modelRegistryEntries.filter((entry) => {
    if (!entry.enabled) return false;
    if (role && !entry.default_roles.includes(role)) return false;
    return true;
  });
}

/**
 * Resolve an agent's declared preferred-model list into the single route
 * the router should dispatch to, honoring author order and allowing
 * sibling-route degradation WITHIN THE SAME REGISTRY ENTRY but never
 * across entries.
 *
 * The function has three independently drift-prone surfaces that this
 * helper's six pre-existing pins only partially cover. They are each
 * called out here so a future refactor cannot silently collapse them:
 *
 * 1. **Exact-match precedence over first-healthy-visible** — within a
 *    matched entry, the helper MUST prefer the route whose model ID
 *    literally equals `preferredModel` over the ascending-priority
 *    first-healthy route. The pre-existing "exact route is healthy"
 *    pin only exercises the case where the preferred route is already
 *    the priority-1 visible sibling, so dropping the explicit exact
 *    lookup would still pass that pin (priority-1 is what the
 *    fallback-find path returns anyway). The NEW pin targets the
 *    priority-2 case: preferred is a LATER sibling, both are healthy,
 *    and the helper must still return the explicit preference. This
 *    preserves the semantic that an agent's declared preference is a
 *    hard requirement, not a priority-order hint.
 *
 * 2. **`filterVisibleProviderRoutes` integration rejects hidden paid
 *    routes** — `provider_order` may contain routes whose providers
 *    are hidden by the visibility filter (xai, deepseek, github-copilot,
 *    cloudflare-ai-gateway, togetherai, cerebras, minimax-cn*, and
 *    openrouter paid routes). The helper runs the filter on every
 *    entry, so an agent that preferred `xai/grok-4` gets null — the
 *    route is invisible and the filter must not be bypassed. A future
 *    refactor that replaced the `filterVisibleProviderRoutes(entry.provider_order)`
 *    call with raw `entry.provider_order` would silently resurrect
 *    hidden-paid dispatch paths. None of the existing pins exercise a
 *    hidden-provider preference; the NEW pin does.
 *
 * 3. **`entryContainsPreferred` gate prevents cross-entry fallback
 *    leak** — the inner loop's gate short-circuits any entry that does
 *    not contain the preferred model among its visible routes. Without
 *    the gate, the fallback-find branch would happily return the first
 *    healthy visible route of a completely UNRELATED entry — pollution
 *    across the registry boundary. The existing pins 4, 5, and 6
 *    incidentally cover this under sabotage (multiple pins fire when
 *    the gate is dropped because the semantic is load-bearing), but
 *    none of them construct the most explicit shape: entry A holds
 *    the preferred model on an unhealthy provider AND entry B holds a
 *    DIFFERENT model on a healthy provider. With the gate, the helper
 *    returns null because entry B is skipped. Without the gate, the
 *    helper returns entry B's healthy "other" route — dangerous
 *    cross-entry bleed. The NEW pin nails this shape explicitly.
 *
 * Author-order semantics, empty-preferences early return, tier
 * contract, and same-entry sibling degradation are already covered by
 * the six pre-existing pins and are NOT re-tested here.
 *
 * Args:
 *   preferredModels: Ordered list of model IDs declared by the agent's
 *     metadata. Earlier entries win on ties.
 *   candidateEntries: Registry entries the caller considers eligible.
 *     Must be pre-filtered by enabled+role but NOT by complexity tier
 *     (see pin 6's contract note).
 *   providerHealthMap: In-memory provider-level health table.
 *   modelRouteHealthMap: In-memory composite-route health table.
 *   now: Current epoch ms for `until`-based health expiry.
 *
 * Returns:
 *   `{ selectedModelRoute, reasoning }` when a preferred (or same-entry
 *   sibling) route is healthy and visible. `null` when no preference
 *   matches a visible route or every candidate is unhealthy.
 */
export function findPreferredHealthyRoute(
  preferredModels: string[],
  candidateEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): { selectedModelRoute: string; reasoning: string } | null {
  if (preferredModels.length === 0) return null;

  for (const preferredModel of preferredModels) {
    for (const entry of candidateEntries) {
      const visibleRoutes = filterVisibleProviderRoutes(entry.provider_order);
      const entryContainsPreferred = visibleRoutes.some(
        (route) => route.model === preferredModel,
      );
      if (!entryContainsPreferred) continue;

      const exactRoute = visibleRoutes.find(
        (route) =>
          route.model === preferredModel
          && isRouteCurrentlyHealthy(route, providerHealthMap, modelRouteHealthMap, now),
      );
      if (exactRoute) {
        return {
          selectedModelRoute: exactRoute.model,
          reasoning: `Preferred model from agent metadata, healthy provider`,
        };
      }

      const fallbackRoute = visibleRoutes.find(
        (route) =>
          isRouteCurrentlyHealthy(route, providerHealthMap, modelRouteHealthMap, now),
      );
      if (fallbackRoute) {
        return {
          selectedModelRoute: fallbackRoute.model,
          reasoning: `Preferred model from agent metadata, healthy fallback provider`,
        };
      }
    }
  }

  return null;
}

/**
 * Scan candidate entries for the first visible route whose provider AND
 * composite route-health entry are both healthy.
 *
 * Pure helper extracted so the caller can make a tier-wide vs tier-agnostic
 * decision on which candidate set to pass — previously the last-resort scan
 * was an inline loop that only walked the complexity-tier-filtered
 * `roleMatchedEntries`. When every entry within the requested tier had all
 * routes unhealthy, `recommendTaskModelRoute` threw "No healthy model
 * route found" even when a perfectly healthy route existed in a SIBLING
 * tier matching the same role. A large-complexity request during a
 * frontier+strong outage died entirely instead of gracefully degrading
 * to a standard-tier route — the agent saw a hard failure when a working
 * alternative was one tier removed. Accepting a lower-tier route on the
 * last-resort path is strictly better than terminating the request.
 *
 * The helper returns the route itself (no reasoning) so the caller can
 * attach a reasoning string that reflects whether the lookup was the
 * tier-filtered first pass or the tier-agnostic second pass.
 *
 * Args:
 *   candidateEntries: Already-filtered entries (e.g. enabled+role, or the
 *     tier-widened variant for the last-resort pass). Walked in array order.
 *   providerHealthMap: In-memory provider-level health table.
 *   modelRouteHealthMap: In-memory composite-route health table.
 *   now: Wall-clock timestamp in ms.
 *
 * Returns:
 *   The first `{ provider, model }` whose provider and route are both
 *   healthy, or `null` when no candidate has a live visible route.
 */
export function findFirstHealthyVisibleRoute(
  candidateEntries: ModelRegistryEntry[],
  providerHealthMap: Map<string, ProviderHealth>,
  modelRouteHealthMap: Map<string, ModelRouteHealth>,
  now: number,
): { provider: string; model: string } | null {
  // M72: delegate the inner per-entry scan to `findFirstHealthyRouteInEntry`
  // (M61) instead of inlining `filterVisibleProviderRoutes` + the
  // `isRouteCurrentlyHealthy` loop. M65 already did this at the
  // `buildAvailableModelsSystemPrompt` site but missed this one — the
  // dedupe sweep stopped one caller short. The two functions differ only
  // in outer-loop arity (single entry vs list of entries); the inner
  // "find the first healthy visible route in this one entry" question has
  // a single canonical answer, and it's `findFirstHealthyRouteInEntry`.
  // Keeping them in lockstep means any future refinement of the per-entry
  // predicate (e.g. a provider-preference tiebreak, a composite-key
  // normalization step) lands at one site and propagates here for free.
  for (const entry of candidateEntries) {
    const firstHealthyRoute = findFirstHealthyRouteInEntry(
      entry,
      providerHealthMap,
      modelRouteHealthMap,
      now,
    );
    if (firstHealthyRoute) {
      return { provider: firstHealthyRoute.provider, model: firstHealthyRoute.model };
    }
  }
  return null;
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

  // M93: delegate the enabled + optional-role two-predicate pass to
  // `filterEnabledEntriesByOptionalRole` so this site and
  // `rolePreferredEntries` below share one source of truth for the first
  // two stages; the capability-tier layer stays here because it's unique
  // to this call site.
  const roleMatchedEntries = filterEnabledEntriesByOptionalRole(
    modelRegistryEntries,
    role,
  ).filter((entry) => allowedTiers.includes(entry.capability_tier));

  // When complexity allows multiple tiers, sort to prefer higher tiers first
  if (allowedTiers.length > 1) {
    const tierOrder = ["frontier", "strong", "standard", "fast", "tiny"] as const;
    roleMatchedEntries.sort((a, b) => {
      const aTierIdx = tierOrder.indexOf(a.capability_tier as typeof tierOrder[number]);
      const bTierIdx = tierOrder.indexOf(b.capability_tier as typeof tierOrder[number]);
      return aTierIdx - bTierIdx;
    });
  }

  // If agent has preferred models, try those first. Explicit preference
  // outranks inferred complexity: the lookup uses `rolePreferredEntries`
  // (role filter only, no capability-tier filter) so an agent declaring
  // `model: minimax/MiniMax-M2.5` on a "fix typo" prompt still gets its
  // MiniMax-M2.5 route instead of being silently dropped by the small-
  // complexity allowedTiers filter. See `findPreferredHealthyRoute`
  // docstring for the full reachability analysis.
  // M93: same two-predicate pass as `roleMatchedEntries` above but
  // without the capability-tier layer — both sites share one source of
  // truth via `filterEnabledEntriesByOptionalRole`.
  const rolePreferredEntries = filterEnabledEntriesByOptionalRole(
    modelRegistryEntries,
    role,
  );

  const preferredDecision = findPreferredHealthyRoute(
    preferredModels,
    rolePreferredEntries,
    providerHealthMap,
    modelRouteHealthMap,
    now,
  );
  if (preferredDecision) return preferredDecision;

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
    const primaryRoute = visibleRoutes.find((route) =>
      isRouteCurrentlyHealthy(route, providerHealthMap, modelRouteHealthMap, now),
    );
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
  //
  // Two-pass structure: first scan stays inside the complexity-tier set so a
  // large-complexity request continues to prefer strong/frontier routes
  // whenever any are live. The second pass widens to `rolePreferredEntries`
  // (role filter only, no tier filter) so a large-complexity request during
  // a full frontier+strong outage degrades gracefully to a standard-tier
  // route instead of throwing "No healthy model route found" — a strictly
  // better outcome than terminating the request when a working alternative
  // exists one tier removed. See `findFirstHealthyVisibleRoute` docstring.
  const tierFilteredRoute = findFirstHealthyVisibleRoute(
    roleMatchedEntries,
    providerHealthMap,
    modelRouteHealthMap,
    now,
  );
  if (tierFilteredRoute) {
    return {
      selectedModelRoute: tierFilteredRoute.model,
      reasoning: `Fallback to first healthy visible route within complexity tier`,
    };
  }

  const tierAgnosticRoute = findFirstHealthyVisibleRoute(
    rolePreferredEntries,
    providerHealthMap,
    modelRouteHealthMap,
    now,
  );
  if (tierAgnosticRoute) {
    return {
      selectedModelRoute: tierAgnosticRoute.model,
      reasoning: `Fallback to first healthy visible route outside complexity tier`,
    };
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

/**
 * Bootstrap runtime provider/route health for the live plugin factory.
 *
 * This is the production entry point that wires `initializeProviderHealthState`
 * into the plugin startup path. It exists because the `ModelRegistryPlugin`
 * factory previously called `loadPersistedProviderHealth()` directly and
 * never invoked `initializeProviderHealthState` — which meant `loadAuthKeys`,
 * env-var credential checks, and the `key_missing` reconciliation loop were
 * dead code at runtime, even though every unit test that calls
 * `initializeProviderHealthState` directly passed. The real-world impact was
 * that a fresh install (or a reload after rotating credentials) never
 * installed `key_missing` entries for uncredentialed providers, so the
 * fallback scanner would happily route traffic through a provider whose
 * key was missing and burn retries on 401/403 responses before the runtime
 * feedback path could penalize the route. Extracted as a pure helper so the
 * wire-up has its own regression pin — the previous silent failure happened
 * because nothing tested the factory's bootstrap sequence, only the pieces
 * it was supposed to call.
 *
 * When the registry fails to load (disk corruption, schema drift, missing
 * file), fall back to `initializeProviderHealthState([])` — an empty
 * registry means no providers are "known" and nothing is marked key_missing,
 * but previously-persisted entries from `loadPersistedProviderHealth` are
 * still retained. Swallowing the error here is intentional: the plugin must
 * still come up so the user sees opencode at all, and the individual tool
 * handlers re-load the registry and surface load failures with the same
 * `logRegistryLoadError` hook.
 *
 * Args:
 *   loadRegistry: Async loader for the curated model registry. Injected so
 *     tests can supply a fixed registry or a throwing loader without
 *     constructing a disk fixture.
 *   logError: Error logger invoked when the registry loader throws. Defaults
 *     to `logRegistryLoadError` which writes to `console.error`.
 *
 * Returns:
 *   The same `{ providerHealthMap, modelRouteHealthMap }` shape returned by
 *   `initializeProviderHealthState`, ready for use inside the plugin closure.
 */
export async function initializeRuntimeProviderState(
  loadRegistry: () => Promise<ModelRegistry>,
  logError: (error: unknown) => void = logRegistryLoadError,
): Promise<{
  providerHealthMap: Map<string, ProviderHealth>;
  modelRouteHealthMap: Map<string, ModelRouteHealth>;
}> {
  try {
    const modelRegistry = await loadRegistry();
    return await initializeProviderHealthState(modelRegistry.models);
  } catch (error) {
    logError(error);
    return await initializeProviderHealthState([]);
  }
}

// Exported functions for testing and external use
export { inferTaskComplexity, recommendTaskModelRoute, initializeProviderHealthState };

export const ModelRegistryPlugin: Plugin = async () => {
  const { providerHealthMap, modelRouteHealthMap } = await initializeRuntimeProviderState(
    () => loadModelRegistry(CONTROL_PLANE_ROOT_DIRECTORY),
  );
  const sessionActiveProviderMap = new Map<string, string>();
  const sessionActiveModelMap = new Map<string, { id: string; providerID: string }>();
  const sessionStartTimeMap = new Map<string, number>();

  // Re-exposed from module scope so the plugin-closure code paths keep
  // their existing references. Pure helpers outside the closure
  // (e.g. `evaluateSessionHangForTimeoutPenalty`) reference the
  // module-scope constants directly.
  const QUOTA_BACKOFF_DURATION_MS = ROUTE_QUOTA_BACKOFF_DURATION_MS;

  function recordProviderHealth(
    providerID: string,
    state: ProviderHealthState,
    durationMs: number,
  ): void {
    // M73: delegate the durability boundary (set + persist) to
    // `recordProviderHealthPenalty` so the provider-layer writer shares
    // the same set+persist pairing helper that M68's
    // `recordRouteHealthPenalty` enforces at the route layer. The M43
    // preserve-longer merge still happens HERE via
    // `computeProviderHealthUpdate` so the module-scope helper stays
    // pure and durability-only, mirroring M68's
    // `buildRouteHealthEntry` / `recordRouteHealthPenalty` split.
    const existing = providerHealthMap.get(providerID);
    const newUntil = Date.now() + durationMs;
    recordProviderHealthPenalty(
      providerHealthMap,
      modelRouteHealthMap,
      providerID,
      computeProviderHealthUpdate(existing, state, newUntil),
      persistProviderHealth,
    );
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
            // M89: `buildProviderHealthSummaryForTool` replaces the
            // five-line inline `Object.fromEntries` expression. See the
            // helper docstring for the three drift surfaces it closes
            // (state field, formatter call, no-filter policy).
            return JSON.stringify({
              recommendation: null,
              reason: "No model found matching role/task/tier filters",
              providerHealthSummary: buildProviderHealthSummaryForTool(providerHealthMap),
            }, null, 2);
          }

          // M62: hand the agent the first HEALTHY visible route as
          // primary (not `provider_order[0]`). Pre-M62 this tool returned
          // `filterVisibleProviderRoutes(best.provider_order)[0]` whether
          // or not it was routable, so on the shipping models.jsonc shape
          // (opencode/*-free primary + iflowcn sibling) it reported a
          // permanently key_missing route as primary and forced the
          // agent to parse `alternativeRoutes` to find something usable.
          // See `buildRoleRecommendationRoutes` for the full rationale.
          const recommendationRoutes = buildRoleRecommendationRoutes(
            best,
            providerHealthMap,
            modelRouteHealthMap,
            now,
          );

          return JSON.stringify({
            recommendation: {
              modelID: best.id,
              // route.model fields in provider_order are already the
              // composite "provider/model-id" form per registry convention.
              primaryRoute: recommendationRoutes.primaryRoute
                ? recommendationRoutes.primaryRoute.model
                : null,
              capabilityTier: best.capability_tier,
              billingMode: best.billing_mode,
              roles: best.default_roles,
              bestFor: best.best_for,
              primaryProviderHealthy: recommendationRoutes.primaryHealthy,
            },
            alternativeRoutes: recommendationRoutes.alternativeRoutes.map((entry) => ({
              route: entry.route.model,
              healthy: entry.healthy,
            })),
          }, null, 2);
        },
      }),

      get_quota_backoff_status: tool({
        description: "Return all LLM providers currently penalized (quota backoff, dead key, no credit) and when they expire.",
        args: {},
        async execute() {
          const now = Date.now();
          // M63: expire stale entries via the dedicated helper (keeps
          // map cleanup in one place and out of the rendering path),
          // then filter out `key_missing` permanent plumbing state via
          // `buildAgentVisibleBackoffStatus`. Pre-M63 this handler
          // iterated the maps inline without filtering, so post-M58 it
          // dumped the entire boot-time key_missing roster (15–25
          // entries on a default install) into the tool output labeled
          // as "currently penalized" providers on every single call,
          // making the tool useless for answering "what's broken right
          // now?" — which is the ONE question the tool is named for.
          // See `buildAgentVisibleBackoffStatus` for the full rationale.
          expireHealthMaps(providerHealthMap, modelRouteHealthMap, now);
          const status = buildAgentVisibleBackoffStatus(
            providerHealthMap,
            modelRouteHealthMap,
            now,
          );
          return JSON.stringify(status, null, 2);
        },
      }),
    },

    provider: {
      id: OPENROUTER_PROVIDER_ID,
      async models(provider) {
        try {
          const now = Date.now();
          if (findLiveProviderPenalty(providerHealthMap, OPENROUTER_PROVIDER_ID, now)) {
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
        // M88: `extractSessionErrorApiErrorContext` replaces the five
        // inline narrowing gates (`!sessionError?.error`, `name !==
        // "APIError"`, `?? 0`, `?? ""`, `!sessionID`) with one
        // runtime-narrowed helper. See the helper docstring for the
        // four drift surfaces it closes (error-type gate, status
        // code default, message default + case-fold, sessionID gate
        // ordering).
        const apiErrorContext = extractSessionErrorApiErrorContext(sessionError);
        if (apiErrorContext === undefined) return;
        const { sessionID, statusCode, lowerMessage: message } = apiErrorContext;

        // M78: `readAndClearSessionHangState` encodes the read-before-clear
        // ordering invariant — inlining the two `Map.get` calls and the
        // `clearSessionHangState` call separately was a drift surface
        // because swapping the order silently turned both reads into
        // `undefined` and short-circuited every classification branch.
        // session.error still overlays its own `sessionError.model`
        // fallback externally so the helper stays minimal.
        const { providerID, model: mappedModel } = readAndClearSessionHangState(
          sessionID,
          sessionStartTimeMap,
          sessionActiveProviderMap,
          sessionActiveModelMap,
        );
        // M84: `extractSessionErrorExplicitModel` replaces the former
        // `(sessionError as any).model` cast with explicit runtime
        // narrowing. The `?? mappedModel` fallback stays visible at the
        // call site — that policy is intentional and the helper is
        // deliberately minimal so the explicit-vs-mapped decision lives
        // here, not inside shared code. See the helper docstring for
        // the drift shape it closes.
        const model = extractSessionErrorExplicitModel(sessionError) ?? mappedModel;
        if (!providerID) return;
        const modelID = model?.id;

        // "Model not found" message → model_not_found backoff (6h,
        // `ROUTE_MODEL_NOT_FOUND_DURATION_MS`). Structurally longer than
        // the 1h quota backoff because a missing model is a property of
        // the upstream, not a refill clock — retrying hourly produces
        // guaranteed 404s and pollutes health telemetry. Gated on
        // `shouldClassifyAsModelNotFound`: authoritative status codes
        // 401/402/403/429 suppress the keyword match so a dead key or
        // quota-throttled provider isn't misclassified as a per-route
        // missing-model problem. Accepted statuses: 0 (no status), 404
        // (direct providers), 500 (openrouter router synthesis).
        const isModelNotFound =
          modelID !== undefined && shouldClassifyAsModelNotFound(statusCode, message);
        if (isModelNotFound && modelID) {
          recordModelNotFoundRouteHealthByIdentifiers(
            modelRouteHealthMap,
            providerHealthMap,
            providerID,
            modelID,
            Date.now(),
            persistProviderHealth,
          );
          return;
        }

        // Authoritative-priority classification: status codes win over
        // keyword heuristics. See `classifyProviderApiError` docstring for
        // the bugs the previous `||` cascade produced (402+rate-limit and
        // 401+rate-limit both misclassified as quota, dead keys retried
        // every hour forever).
        const errorClass = classifyProviderApiError(statusCode, message);
        if (errorClass !== "unclassified") {
          recordProviderHealth(
            providerID,
            errorClass,
            PROVIDER_PENALTY_CLASS_TO_BACKOFF_DURATION_MS[errorClass],
          );
        }
        // "unclassified" → no penalty. Transient upstream errors must not
        // quarantine healthy providers.
        return;
      }

      // M85: `extractAssistantMessageCompletedPayload` replaces the
      // stacked `(event as any).type` / `(event as any).properties as
      // any` casts with explicit runtime narrowing. See the helper
      // docstring for the drift shape it closes — mirror-drift of
      // M84's `extractSessionErrorExplicitModel` on `session.error`.
      const completedPayload = extractAssistantMessageCompletedPayload(event);
      if (completedPayload !== undefined) {
        const { sessionID, tokens } = completedPayload;

        // Deliberate: do NOT classify based on wall-clock duration here.
        // A completed turn is by definition not hung — deep reasoning turns
        // (kimi-k2-thinking, minimax-m2.7, cogito-2.1 with 200+ tool calls)
        // routinely exceed any ambient timeout but succeed normally. The
        // setTimeout-based hang detector in chat.params is the only valid
        // "still running after N seconds" signal; once completion fires we
        // clear that session's start-time so the late-firing setTimeout
        // becomes a no-op.
        // M78: see `readAndClearSessionHangState` — the helper pins the
        // read-before-clear ordering so the zero-token quota branch below
        // always sees the live provider/model tuple even after a future
        // edit to the surrounding hook.
        const { providerID, model } = readAndClearSessionHangState(
          sessionID,
          sessionStartTimeMap,
          sessionActiveProviderMap,
          sessionActiveModelMap,
        );

        // Zero tokens across every counter indicates silent quota exhaustion.
        // See `isZeroTokenQuotaSignal` docstring for why the narrow
        // `input===0 && output===0` predicate was wrong: it ignored side-
        // channel counters (`reasoning` for deep-thinking models, nested
        // `cache.read`/`cache.write`), so a successful deep-reasoning turn
        // could be silently penalized as quota-exhausted the moment any
        // future opencode release started populating those fields.
        if (isZeroTokenQuotaSignal(tokens)) {
          if (!providerID || !model) return;

          recordRouteHealthByIdentifiers(
            modelRouteHealthMap,
            providerHealthMap,
            providerID,
            model.id,
            "quota",
            QUOTA_BACKOFF_DURATION_MS,
            Date.now(),
            persistProviderHealth,
          );
        }
        return;
      }
    },

    async "chat.params"(input, output) {
      try {
        // M79: bindSessionHangState pins the three-map write triplet as
        // the write-side sibling of readAndClearSessionHangState (M78).
        // A future edit that drops any of the three writes would
        // silently desynchronise the hang detector — dropping the
        // start-time write would disarm it entirely (the finalizer
        // short-circuits on missing start-time), dropping the model or
        // provider write would leave the detector firing with undefined
        // bindings and silently losing the timeout penalty.
        bindSessionHangState(
          input.sessionID,
          input.provider.info.id,
          { id: input.model.id, providerID: input.model.providerID },
          Date.now(),
          sessionStartTimeMap,
          sessionActiveProviderMap,
          sessionActiveModelMap,
        );

        // M82: `loadRegistryAndLookupEntryForInputModel` SSoTs the two-step
        // load+narrow+lookup ritual that was previously inlined at both
        // this site and the `experimental.chat.system.transform` site. See
        // the helper docstring for the drift shape it closes.
        const { entry: modelRegistryEntry } =
          await loadRegistryAndLookupEntryForInputModel(
            CONTROL_PLANE_ROOT_DIRECTORY,
            input.model,
          );

        if (modelRegistryEntry) {
          output.temperature =
            CAPABILITY_TIER_TO_TEMPERATURE[modelRegistryEntry.capability_tier];
        }

        // Schedule a timeout check that runs after the timeout period.
        // See `parseHangTimeoutMs` docstring for the NaN / negative /
        // trailing-garbage edge cases the helper defends against.
        const timeoutMs = parseHangTimeoutMs(process.env.AICODER_ROUTE_HANG_TIMEOUT_MS);

        // M86: `shouldRecordImmediateTimeoutPenalty` + `HANG_TIMEOUT_IMMEDIATE_THRESHOLD_MS`
        // replace the inline `timeoutMs < 1000` literal and the nested
        // `if (providerID && model)` guard. See the helper docstring
        // for the three drift surfaces it closes (magic literal,
        // implicit `<` boundary, and triple-nested gate). The
        // identifier narrowing still lives at the call site so the
        // `recordRouteHealthByIdentifiers` arguments stay visible.
        const immediateProviderID = input.provider.info.id;
        const immediateModel = input.model;
        if (
          shouldRecordImmediateTimeoutPenalty(
            timeoutMs,
            Boolean(immediateProviderID),
            Boolean(immediateModel),
          )
        ) {
          recordRouteHealthByIdentifiers(
            modelRouteHealthMap,
            providerHealthMap,
            immediateProviderID,
            immediateModel.id,
            "timeout",
            QUOTA_BACKOFF_DURATION_MS,
            Date.now(),
            persistProviderHealth,
          );
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
            // `finalizeHungSessionStateAndRecordPenalty` (M77) collapses
            // the three-step `finalize → null-guard → record` ritual
            // into one call. The wrapper also guarantees the null-check
            // is never forgotten — forgetting it used to be a viable
            // drift target where a future maintainer accidentally called
            // recordRouteHealthPenalty with null fields and crashed the
            // async-isolated setTimeout closure. Silent-death sessions
            // (network drop, client kill, parent crash) never fire
            // session.error or assistant.message.completed, so this
            // hang-timer firing is the ONLY cleanup opportunity for
            // their session tuples.
            finalizeHungSessionStateAndRecordPenalty(
              capturedSessionID,
              sessionStartTimeMap,
              sessionActiveProviderMap,
              sessionActiveModelMap,
              modelRouteHealthMap,
              providerHealthMap,
              capturedTimeoutMs,
              Date.now(),
              persistProviderHealth,
            );
          }, timeoutMs + 100); // Check slightly after the timeout threshold
          // Do not keep the Node event loop alive waiting on a hang timer —
          // the timer is best-effort health telemetry, not critical work.
          hangTimer.unref?.();
        }
      } catch (error) {
        // M80: silent-swallow drift — prior to this log call the hook
        // swallowed every throw with `catch {}`, hiding registry load
        // failures and hook-internal bugs from operators. The swallow
        // is still required (a plugin cannot crash the host), but the
        // failure is now surfaced through `logPluginHookFailure`.
        logPluginHookFailure("chat.params", error);
        return;
      }
    },

    async "experimental.chat.system.transform"(input, output) {
      try {
        const now = Date.now();
        // M82: see `loadRegistryAndLookupEntryForInputModel` docstring.
        // This site still needs `modelRegistry` for the prompt builders
        // below, so the helper returns both the registry and the
        // pre-looked-up entry.
        const { registry: modelRegistry, entry: modelRegistryEntry } =
          await loadRegistryAndLookupEntryForInputModel(
            CONTROL_PLANE_ROOT_DIRECTORY,
            input.model,
          );

        // Expire stale health entries in BOTH maps. The transform hook
        // runs on every message, so this keeps memory and the persisted
        // providerHealth.json file bounded. Previously only the provider
        // map was expired; route-health entries accumulated forever.
        expireHealthMaps(providerHealthMap, modelRouteHealthMap, now);

        if (modelRegistryEntry) {
          output.system.push(buildRoutingContextSystemPrompt(modelRegistryEntry));
        }

        // Only inject health/available-models sections when there are
        // AGENT-VISIBLE active penalties. Route-level penalties count too —
        // the original pre-M27 guard was `providerHealthMap.size === 0`
        // which silently hid route-level failures, and the pre-M60 guard
        // `size === 0 && size === 0` became dead wiring post-M58 when
        // `key_missing` entries started permanently populating
        // providerHealthMap for every uncredentialed curated provider
        // (typically 15–25 on a default install). Using
        // `hasAgentVisiblePenalty` restores the original intent: skip the
        // entire block whenever nothing the agent can act on is active.
        if (!hasAgentVisiblePenalty(providerHealthMap, modelRouteHealthMap, now)) {
          return;
        }

        // M87: `assembleHealthAwareSystemPrompts` replaces the two
        // inline `build*Prompt` + null-filter + push blocks with one
        // ordering-and-null-filter helper. See the helper docstring
        // for the four drift surfaces it closes (order, dual null
        // filter, and asymmetric guard loss between the two blocks).
        // The two builder invocations stay at the call site so the
        // shared 4-arg registry+maps signature remains visible and
        // type-checked here.
        output.system.push(
          ...assembleHealthAwareSystemPrompts(
            buildProviderHealthSystemPrompt(
              modelRegistry.models,
              providerHealthMap,
              modelRouteHealthMap,
              now,
            ),
            buildAvailableModelsSystemPrompt(
              modelRegistry.models,
              providerHealthMap,
              modelRouteHealthMap,
              now,
            ),
          ),
        );
      } catch (error) {
        // M80: see `logPluginHookFailure`. The transform hook was the
        // second silent-swallow site — registry parse errors, prompt
        // builder throws, and expire-map bugs all disappeared here.
        logPluginHookFailure("experimental.chat.system.transform", error);
        return;
      }
    },
  };
};
