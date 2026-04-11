# aicoder-opencode Control Plane Roadmap

## Status Legend

- `⬜ PENDING` — not started
- `🔨 IN PROGRESS` — actively being worked
- `✅ COMPLETED` — done and verified
- `⏸️ PARKED` — blocked, waiting on external dependency
- `🚫 SKIPPED` — analyzed and decided not to pursue

---

## Baseline (verified 2026-04-11)

Control plane is functional with passing build and tests:

- `npx tsc -p tsconfig.json --noEmit` — clean
- `node --import tsx --test 'src/**/*.test.ts'` — 118/118 pass
- Three targets configured: `aicoder-opencode`, `dr-repo`, `letta-workspace`
- Model registry plugin operational
- OpenCode database maintenance module operational (829MB production DB)

---

## Scope guard

This is a **control plane**, not a product repo. Every backlog item must describe a real observed gap in shared maintenance (build, plugin, launcher, agent routing, target-aware tooling, DB maintenance). **Never** invent product features or speculative UX work — that belongs in the target repos (`dr-repo`, `letta-workspace`), not here.

## Baseline completions (migrated 2026-04-11)

### BL1: Build system — bun → npm fallback `✅ SHIPPED`

- Changed `package.json` check script: `bun run build && bun run test` → `npm run build && npm run test`.
- Added `.specify/`, `spec-kit/`, `Product-Manager-Skills/`, `apps/` to `.gitignore` (external subrepos were polluting `git status`).
- **Why:** `make check` was broken on machines without bun installed.
- **Verification:** `make check` — 14/14 tests pass. Commit `6ac63ce`.

### BL2: Agent routing commit `✅ SHIPPED`

- Committed 26 files of accumulated model-routing updates against `config/models.jsonc` registry.
- Providers: `iflowcn/qwen3-coder-plus` (readers/reviewers), `xiaomi-token-plan-ams/mimo-v2-pro` (leads/workers), `ollama-cloud/minimax-m2.7` (long-context), `kimi-for-coding/kimi-k2-thinking` (dr-repo fallback).
- Makefile bun→npm fallback. Maintenance timeout 300s→1200s. `implementation_lead.md` got persist-findings close-out.
- **Verification:** `make check` pass; all models exist in `config/models.jsonc`. Commits `a264158`, `d687142`, `e6d6d48`.
- **Follow-ups:** 16 unpushed commits on `main` — parked pending explicit user confirmation (visible external action).

### BL3: Purpose-gate (PDD) + scope correction `✅ SHIPPED`

- Added the `Purpose gate (PDD)` section to all 3 `implementation_lead.md` files (aicoder-opencode, dr-repo, letta-workspace): tiered trivial/non-trivial/structural slice framing, gate checklist as reference not narration.
- Initial version tried to force `MAINTENANCE_LOG.md` only; partner/combatant review (2026-04-11) flagged that as overcorrection — autopilot already produces a legitimate ROADMAP with real maintenance backlog (this file). Reverted to `ROADMAP.md` + scope guard.
- **Verification:** rules load in all 3 leads; next-cycle slices tested for PURPOSE-block emission. Commit `b5f4e84` (+ softening commit that follows this migration).

## Maintenance Backlog

### M1: Target-aware database maintenance CLI `✅ COMPLETED`

Completion Notes (2026-04-11):
- Added `--target <name>` flag to `opencode-database-maintenance` CLI command
- Added `deriveTargetDatabasePath()` and `TARGET_OPENCODE_DATABASE_RELATIVE_PATH` to `opencode-database-maintenance.ts`
- Added 2 unit tests for `deriveTargetDatabasePath`
- Both `--target dr-repo checkpoint` and default `checkpoint` verified end-to-end
- Files changed: `src/opencode-database-maintenance.ts`, `src/cli.ts`, `src/opencode-database-maintenance.test.ts`

### M2: ROADMAP.md and maintenance state tracking `✅ COMPLETED`

Completion Notes (2026-04-11):
- Created ROADMAP.md with maintenance backlog and status tracking
- Established maintenance iteration workflow for future cycles

### M3: CLI unit tests for `cli.ts` main() `✅ COMPLETED`

Completion Notes (2026-04-11):
- Extracted pure argument parsing from cli.ts into `src/cli/arg-parser.ts` (10 exported functions)
- Created `src/cli.test.ts` with 51 tests: 38 unit tests (argument parsing, shell quoting, threshold validation, DB maintenance arg parsing, command routing) + 13 integration tests (spawning CLI as child process)
- Removed duplicate `quoteShellArgument` and `renderShellCommand` from cli.ts; now imports from `cli/arg-parser.ts`
- Type check clean, all 110 tests pass (51 new + 59 existing)
- Key test coverage: argument parsing edge cases, missing target names, invalid thresholds, --target flag handling, error exit codes, all 3 target validations, DB maintenance with/without --target

### M4: Batch database maintenance across all targets `✅ COMPLETED`

Completion Notes (2026-04-11):
- Added `--all-targets` flag to `opencode-database-maintenance` CLI command
- Updated `parseDatabaseMaintenanceArgs()` in `src/cli/arg-parser.ts` to handle `--all-targets`
- Added batch handler in `src/cli.ts` that iterates all repo targets sequentially
- Skips monorepo targets (no per-target DB) and targets without existing DB files
- Output: JSON with `targets` array (per-target success/error) and `summary` (total/succeeded/failed)
- Exit code 1 if any target fails, 0 if all succeed
- Updated usage text: `--target <name>|--all-targets`
- Added 5 tests: 3 unit tests for arg parsing + 2 integration tests for batch execution
- All 118 tests pass

### M5: Database path auto-discovery `🚫 SKIPPED`

Analysis (2026-04-11):
- Current behavior is correct: no `--target` → control plane's own DB at `~/.local/share/opencode/opencode.db`
- `--target <name>` → that target's derived DB path
- `--all-targets` → all repo targets (M4)
- Auto-discovery would introduce ambiguity ("which DB?") and the "wrong DB in multi-install" risk outweighs convenience
- No implementation needed — the three explicit modes cover all real use cases

### M6: Backup directory target-awareness `✅ COMPLETED`

Completion Notes (2026-04-11):
- Added `TARGET_OPENCODE_BACKUP_RELATIVE_PATH` constant pointing to `.opencode/xdg-data/opencode/backups`
- Added `deriveTargetBackupDirectory(targetRoot)` function parallel to `deriveTargetDatabasePath`
- Updated CLI handler to pass `backupDirectory` derived from target root in both single-target and all-targets paths
- Backward compatible: no `--target` = global backup dir, `--target <name>` = co-located target backup dir
- Added 2 unit tests for `deriveTargetBackupDirectory`
- Type check clean, all tests pass
- Files changed: `src/opencode-database-maintenance.ts`, `src/cli.ts`, `src/opencode-database-maintenance.test.ts`

### M8: Letta-workspace overlay — make agent files durable `✅ COMPLETED`

Completion Notes (2026-04-11):
- Created `targets/letta-workspace/overlay/.opencode/agents/` and seeded with all 15 live agent files from `letta-workspace/.opencode/agents/` — byte-identical `diff -q` verified pre-swap.
- Atomic swap on letta side: `mv agents agents.bak && ln -s <absolute overlay path> agents`, re-verified identical content through the symlink, removed `.bak`.
- `letta-workspace/.opencode/agents` → `/home/mhugo/code/aicoder-opencode/targets/letta-workspace/overlay/.opencode/agents` (absolute symlink, matching dr-repo layout).
- PDD-softened `implementation_lead.md` (6-line Purpose block + CONFIDENCE slot + subagent-output guard) is now version-controlled via this overlay.
- **Closes letta LW1** (cross-reference in `/home/mhugo/code/letta-workspace/roadmap.md`).
- Still ephemeral in letta: `.opencode/bin/`, `.opencode/commands/`, `.opencode/plugins/` — deferred to M10 for principled propagation rather than repeat manual copy.

### M9: Enforce partner/combatant review discipline `✅ COMPLETED`

Completion Notes (2026-04-11):
- Added PAR Gate (Pre-Action Review Gate) to all 3 implementation_lead.md prompts (aicoder-opencode, dr-repo overlay, letta-workspace overlay)
- Three auditable declarations: Review Complete (named agents + synthesis), Trivial Exemption (4 strict criteria), Review Skipped (explicit reason + recording)
- Tightened non-trivial slice definition: ANY of multi-file, behavior-changing, contract-touching, trust-boundary, >3 files read, or CONFIDENCE < 0.9
- Added Partner/Combatant specialist mapping table to all 3 leads + AGENT_ROLES.md
- Updated gate checklist to include PAR Gate step
- Design: prompt-layer enforcement (not plugin-layer) — oracle adversarial review rejected plugin-layer approach as "maximal overreach" that breaks trivial slices and creates doom-loops
- Verified: type check clean, 118/118 tests pass, PAR GATE present in all 3 files
- Files changed: `.opencode/agents/implementation_lead.md`, `targets/dr-repo/overlay/.opencode/agents/implementation_lead.md`, `targets/letta-workspace/overlay/.opencode/agents/implementation_lead.md`, `docs/AGENT_ROLES.md`

### M10: `aicoder-opencode install <target>` command — propagate agent rules + plugins to target overlays `⬜ PENDING`

- Current state: `dr-repo/.opencode/agents` is a symlink into `aicoder-opencode/targets/dr-repo/overlay/.opencode/agents`, so editing the overlay in aicoder-opencode automatically reaches dr-repo. `letta-workspace/.opencode/` is gitignored with no overlay (see M8) — my edits there are ephemeral.
- Desired: `aicoder-opencode` is the single source of truth for agent rules, plugins, and commands across all targets. An `install <target>` command should:
  1. Verify the target's overlay directory exists under `targets/<target>/overlay/` in this repo
  2. Seed it from the source directories (`.opencode/agents/`, `.opencode/plugins/`, `.opencode/commands/`) with any target-specific patches applied
  3. Create or refresh symlinks in the target repo pointing into the overlay
  4. Never edit target repos in-place for shared rules — only for target-specific overrides
- Prereq: M8 (create letta-workspace overlay).
- Also think about: a `--check` mode that verifies symlinks haven't been tampered with, and a CI check that flags drift between the live file and the overlay.

### M7: Shared plugin propagation verification `⬜ PENDING`

- Verify that overlay shims in `targets/*/overlay/.opencode/plugins/` are in sync with `src/plugins/`
- Add a CI check or validation command

### M13: Env-var credential fallback in `loadAuthKeys` `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Gap**: opencode sources provider credentials from `auth.json` **and** env vars (e.g. `OPENROUTER_API_KEY`, `MINIMAX_API_KEY`, `KIMI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`). A user with only the env var set had a working provider but the plugin flagged it `key_missing` and pruned the route.
- **Fix**:
  - Added `PROVIDER_ENV_VAR_OVERRIDES` for non-conventional names (`kimi-for-coding` → `KIMI_API_KEY`, `google` → `GEMINI_API_KEY`, etc.)
  - `providerEnvVarCandidates(id)` falls back to the convention `<ID>_API_KEY` (dashes → underscores, upper-cased) when no override exists
  - `providerHasEnvVarCredential(id)` checks `process.env` for any candidate
  - `initializeProviderHealthState` now skips the `key_missing` flag when either auth.json **or** env var says the provider is configured
- **Test**: `initializeProviderHealthState_whenCredentialOnlyInEnvVar_doesNotFlagProvider` covers convention-based (`openrouter`) + override (`kimi-for-coding`) + truly missing (`nonexistent-provider`).
- **Verification**: typecheck clean, 120/120 tests pass (added 1). Dist rebuilt.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.keyless.test.ts`.

### M12: `loadAuthKeys` reads the real opencode auth.json schema `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `loadAuthKeys()` + `initializeProviderHealthState()` in `src/plugins/model-registry.ts` checked `authKeys.get(providerID).apiKey !== undefined`, but real opencode `auth.json` entries use `{ type: "api", key: "..." }` for API keys and `{ type: "oauth", access: "...", refresh: "..." }` for OAuth — **no entry ever has an `apiKey` field**. Every real provider was silently flagged `key_missing` on first startup.
- **Existing tests didn't catch it** because they wrote fixture auth entries in the wrong (matching-bug) shape — `{apiKey: "token-value"}` or bare strings — so plugin + tests were internally consistent but both wrong relative to reality.
- **Fix**:
  - Introduced `hasUsableCredential(entry)` that handles all three shapes: real API-key (`type:"api", key:"..."`), real OAuth (`type:"oauth", access:"..."`), and legacy fixture shapes (`apiKey`, bare string) as fallbacks so existing tests still lock in their original behavior.
  - `loadAuthKeys()` now returns `Map<string, { hasCredential: boolean }>` instead of the raw parsed entry; the consumer check becomes `authKeys.get(id)?.hasCredential === true`.
  - Added `initializeProviderHealthState_whenAuthJsonUsesRealOpencodeSchema_recognizesCredentials` test — writes three entries (API/oauth/empty-key) and asserts the empty-key one is the only one flagged `key_missing`.
- **Verification**: `npx tsc -p tsconfig.json --noEmit` clean, `node --import tsx --test 'src/**/*.test.ts'` 119/119 pass (118 existing + 1 new).
- **Files**: `src/plugins/model-registry.ts` (loadAuthKeys + hasUsableCredential + initializeProviderHealthState check), `src/plugins/model-registry.keyless.test.ts` (new real-schema test).
- **Rebuilt `dist/plugins/model-registry.js`** so dr-repo and letta-workspace overlay shims pick up the fix on next service start.

### M24: `findCuratedFallbackRoute` skipped `filterVisibleProviderRoutes` and `modelRouteHealthMap` — system-prompt "Curated fallbacks" could suggest paid/dead routes `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `buildProviderHealthSystemPrompt` injects a "Curated fallbacks" block into the agent system prompt whenever a provider is backed-off, built by calling `findCuratedFallbackRoute` for every affected registry entry. That function walked `modelRegistryEntry.provider_order` directly and only checked `isFallbackBlocked` (provider-id blocklist: anthropic/openai/xai/github-copilot/longcat/longcat-openai + model-name substrings longcat/claude/gpt/grok) plus provider-level `isProviderHealthy`. It did NOT apply `filterVisibleProviderRoutes` (which hides togetherai/xai/cerebras/cloudflare-ai-gateway/deepseek/github-copilot/minimax-cn* AND non-`:free` openrouter routes), and it did NOT consult `modelRouteHealthMap` at all.
- **Reachability**: `config/models.jsonc` currently has exactly one non-`:free` openrouter route — `openrouter/xiaomi/mimo-v2-pro` — inside the `mimo-v2-pro` entry (priority 3, after xiaomi-token-plan-ams and minimax). If the xiaomi-token-plan-ams provider gets quota-backed-off and minimax is also unavailable (either penalized or just at a lower priority when its own provider is blocked), `findCuratedFallbackRoute` would happily return `openrouter/xiaomi/mimo-v2-pro` as the "curated fallback" — a paid route the rest of the plugin hides everywhere (best-branch, last-resort walker, recommend-model-for-role, listCuratedModels, provider.models hook). Same bug class as M23, different call site.
- **Route-level health leak**: separately, route-level failures (model_not_found, route-level quota) that mark `modelRouteHealthMap` but leave the provider overall healthy would still be returned as curated fallbacks, sending the agent to a route the plugin just proved dead.
- **Fix**: in `findCuratedFallbackRoute`, walk `filterVisibleProviderRoutes(entry.provider_order)` instead of the raw list, and add a route-level health check that skips any route whose `modelRouteHealthMap` entry has `until > now`. Thread `modelRouteHealthMap` through `buildProviderHealthSystemPrompt` → its only call site in `experimental.chat.system.transform`.
- **Export for test**: `findCuratedFallbackRoute` was file-private; exported it so the regression test can unit-test it directly instead of via the full transform hook.
- **Tests**: (a) `findCuratedFallbackRoute_whenNextRouteIsHiddenPaidProvider_skipsToVisibleRoute` — mirrors the real `mimo-v2-pro` entry shape from `config/models.jsonc` (xiaomi-token-plan-ams primary, minimax, openrouter/xiaomi/mimo-v2-pro, opencode-go), marks xiaomi+minimax as quota, asserts the fallback is `opencode-go/mimo-v2-pro` and explicitly NOT `openrouter/xiaomi/mimo-v2-pro`. (b) `findCuratedFallbackRoute_whenRouteIsMarkedUnhealthyAtRouteLevel_skipsIt` — pins the route-health leak fix. Both verified to fail on the old behavior (temporarily reverted the function body in place to preserve the export, ran tests, confirmed 2 failures, restored).
- **Verification**: 130/130 tests pass (128 + 2 new), `tsc -p tsconfig.json` clean.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.test.ts`.

### M23: `best` branch of recommendTaskModelRoute used `provider_order[0]` unconditionally — returned hidden paid routes and unhealthy routes as "best" `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: after `const best = selectBestModelForRoleAndTask(...)` returned an entry, the caller did `const primaryRoute = best.provider_order[0]` and returned it unconditionally. This skipped both (a) `filterVisibleProviderRoutes`, so hidden/paid routes (togetherai, xai, cerebras, cloudflare-ai-gateway) could be returned despite being deliberately blocked by curation, and (b) any provider/route health check, so a model with a quota-backed-off provider or a timed-out route would be returned as the "best" route, guaranteeing an immediate inference failure at the caller.
- **Why the last-resort fallback masked it**: for registry entries where the first provider happened to be visible+healthy, the code worked by accident. For the common-in-production scenario of a curated entry whose primary is a hidden route (retained in the registry for dr-repo/letta-workspace diagnostic reads but filtered on the live fleet), the hook returned the wrong thing on every call.
- **Why no test caught it**: the earlier M19 test `BestRegistryPathIsHit` was named as if it exercised the `best` branch but actually fell through to last-resort, because `selectBestModelForRoleAndTask`'s filter is `best_for.some(bf => bf.includes(task))` not the reverse — passing `task: "coding task"` against `best_for: ["coding"]` returned no candidates, so best was null and last-resort handled it. Fleet-wide the `best` branch was barely exercised by tests at all.
- **Fix**: after `best` is returned, walk `filterVisibleProviderRoutes(best.provider_order)` and pick the first route that is both provider-healthy (`isProviderHealthy`) and route-healthy (`modelRouteHealthMap.get(route.model)` missing or expired). If none are healthy, fall through to the last-resort healthy-route scan instead of returning a dead route.
- **Test**: new `recommendTaskModelRoute_whenBestEntryPrimaryRouteIsHiddenOrUnhealthy_fallsThroughToLastResort` uses `prompt: "coding"` + `best_for: ["coding tasks"]` so the substring filter actually matches and the `best` branch is truly live. It constructs a single entry with three routes (togetherai=hidden, iflowcn=unhealthy, opencode-go=healthy) and asserts the chosen route is opencode-go. Verified to fail on HEAD with `togetherai/qwen3-coder-plus` when the fix is stashed.
- **Verification**: 128/128 tests pass (127 + 1 new), `tsc -p tsconfig.json` clean, dist rebuilt.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.test.ts`.

### M22: `provider.models` openrouter filter never matched — every curated openrouter model silently hidden from opencode `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `buildEnabledProviderModelSet` collects `provider_order[].model` values into a Set and the `provider.models` hook uses `Set.has(modelID)` to filter `Object.entries(provider.models)`. But `provider_order[].model` in `config/models.jsonc` is the COMPOSITE form (`"openrouter/xiaomi/mimo-v2-pro"`) while opencode's `provider.models` is keyed by the provider-relative RAW id (`"xiaomi/mimo-v2-pro"`). Same root cause as M21, different dead-code site. The Set never matched any key → filter returned `{}` → the openrouter provider ended up with zero visible models every time the hook ran.
- **Consequence**: every curated openrouter model (xiaomi/mimo-v2-pro, bytedance-seed/*, meituan/longcat, xai/grok-4-fast, etc.) was silently invisible to opencode's model picker when this hook was active. The fallback `return provider.models` only fired on load-error — not on empty-filter.
- **Why no tests caught it**: no test exercised the `provider.models` hook against a fake ProviderV2 shape at all. The hook's type signature treats `provider.models` as opaque, masking the key-shape assumption.
- **Fix**: strip the `${providerID}/` prefix when building the Set so entries are stored in the same raw-id form that opencode uses as the filter key. Defensive: if the registry entry isn't prefixed (unusual but not schema-forbidden), store as-is.
- **Test**: new `provider_models_whenOpenrouterEntryHasCompositePrefix_filterRetainsRawModelIDKeys` calls the real plugin's `provider.models` hook with a fake ProviderV2 whose `models` record has both a curated key (`"xiaomi/mimo-v2-pro"`) and a non-curated key (`"not-in-registry/model"`), then asserts the curated key survives and the non-curated key is filtered out. Verified to FAIL on HEAD without the fix (`git stash` confirmed).
- **Verification**: 127/127 tests pass (126 + 1 new), `tsc -p tsconfig.json` clean, dist rebuilt.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.keyless.test.ts`.

### M21: `findRegistryEntryByModel` never matched — capability-tier temperature override AND routing-context system prompt silently dead `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `findRegistryEntryByModel` compared `providerRoute.model === model.id`. But `providerRoute.model` in `config/models.jsonc` is the COMPOSITE form (`"ollama-cloud/glm-4.7"`) while opencode's runtime `Model.id` is the RAW form (`"glm-4.7"`). The two never matched. The function's OR had two clauses both reducing to the same equality check — dead code. Verified against the live on-disk state `.opencode/state/plugin/provider-health.json` which stores routes as `"ollama-cloud/glm-4.7"`, confirming opencode emits the raw id separately and the composite is constructed by the plugin.
- **Consequences** (both features silently dead in production):
  1. `chat.params` hook's `output.temperature = CAPABILITY_TIER_TO_TEMPERATURE[tier]` — never fired. Every session ran at opencode's default temperature instead of the curated per-tier value (frontier 0.7, strong 0.6, standard 0.5, fast/tiny 0.3).
  2. `experimental.chat.system.transform` hook's `## Active model routing context` system-prompt section — never injected. Agents never saw their own curated role/best_for/not_for/concurrency context.
- **Why no tests caught it**: existing chat.params tests only assert route-level health side effects, never the `output.temperature` value. The second caller's effect is only visible in live system prompts.
- **Fix**: compose `composite = \`${model.providerID}/${model.id}\`` and compare `providerRoute.model === composite`. Keep a defensive secondary check for registry entries where `.model` is not prefixed with `.provider` (unusual but not schema-forbidden).
- **Test**: new `chat_params_whenModelIsInRegistry_setsCapabilityTierTemperature` invokes the real plugin against the real `config/models.jsonc`, sets `AICODER_ROUTE_HANG_TIMEOUT_MS=900000` so chat.params takes the production branch, and asserts `output.temperature === 0.6` (glm-4.7 is `strong` tier). Before the fix this test fails with `temperature undefined`.
- **Verification**: 126/126 tests pass (125 + 1 new), `tsc --noEmit` clean, dist rebuilt.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.keyless.test.ts`.

### M20: Route-level health lost on every plugin restart (provider+route keys merged in one flat map) `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `persistProviderHealth` serializes both provider entries (`"iflowcn"`) and route entries (`"iflowcn/qwen3-coder-plus"`) into a single flat JSON object. `loadPersistedProviderHealth` then dumped every key into a single `providerHealthMap`, while `modelRouteHealthMap` was re-initialized empty at every call site (`initializeProviderHealthState` line 585, `ModelRegistryPlugin` plugin entrypoint line 886). Result: route-level backoffs silently evaporated on every plugin restart. Simultaneously, route keys loaded into `providerHealthMap` accumulated as zombies — the next write persisted them back under their route-shaped names as if they were provider IDs, and they never got cleaned up.
- **Why it matters**: aicoder-opencode, dr-repo, and letta-workspace all share this plugin and restart repeatedly (autopilot cycles, session cleanup). Every restart dropped the route-specific timeout/quota backoffs M14–M18 rely on. A model route that was just 15-min-timeout'd got immediately retried, repeat-poisoning the same route until the next restart.
- **Fix**: `loadPersistedProviderHealth` now returns `{ providerHealthMap, modelRouteHealthMap }` and splits keys on `/` during load — route keys go to `modelRouteHealthMap`, provider keys to `providerHealthMap`. Both call sites updated to destructure. `initializeProviderHealthState` now passes both maps to `persistProviderHealth` when it updates, so restored route health survives subsequent writes instead of dropping out.
- **Test**: new `initializeProviderHealthState_whenPersistedFileContainsRouteKeys_loadsThemIntoModelRouteHealthMap` seeds a mixed provider+route persisted file and asserts (a) `"iflowcn"` lands in providerHealthMap, (b) `"iflowcn/qwen3-coder-plus"` lands in modelRouteHealthMap, (c) the route key does NOT also appear in providerHealthMap.
- **Verification**: 125/125 tests pass (124 + 1 new), `tsc --noEmit` clean, dist rebuilt.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.keyless.test.ts`.

### M19: Composite route double-prefix bug — `${provider}/${route.model}` produced `ollama-cloud/ollama-cloud/glm-5.1` `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `provider_order[].model` in `config/models.jsonc` is already the composite `"provider/model-id"` form per registry convention (e.g. `"ollama-cloud/glm-5.1"`). Four call sites in `src/plugins/model-registry.ts` re-interpolated the provider prefix: `${route.provider}/${route.model}` — producing corrupt double-prefixed keys like `"ollama-cloud/ollama-cloud/glm-5.1"`.
- **Affected sites**:
  1. `findCuratedFallbackRoute` (L238) — used by `buildProviderHealthSystemPrompt`. Every time a provider flipped unhealthy, the agent-visible "Curated fallbacks" section in the system prompt listed garbled routes, misleading the model about what routes exist.
  2. `recommendTaskModelRoute` `best` branch (L729) — the last-resort-before-raw-fallback path returned a corrupt composite as `selectedModelRoute`. Downstream code that uses this as a routing key would miss every time. Path is rarely reached (requires no agent metadata AND a prompt whose keywords match the entry's `best_for`), but was silently wrong when it did fire.
  3. `get_model_recommendation` tool output `recommendation.primaryRoute` (L985) — user/agent-visible tool response contained a corrupt route string.
  4. `get_model_recommendation` tool output `alternativeRoutes[].route` (L994) — same, for the alternative-routes list.
- **Fix**: all four sites now read `route.model` directly (it's already composite). Added explanatory comments pointing back to the registry convention at the two canonical sites (L238, L729) so future edits don't regress.
- **Test**: new `recommendTaskModelRoute_whenBestRegistryPathIsHit_returnsSinglePrefixedRoute` constructs a registry entry with `best_for: ["coding"]` and a prompt `"coding task"` to force the `best` branch live (bypassing preferred-list and last-resort). Asserts the returned route is `"iflowcn/qwen3-coder-plus"` AND does not match `/^[^/]+\/[^/]+\//` (guards against any future double-prefix regression across the contract).
- **Verification**: 124/124 tests pass (123 + 1 new), `tsc --noEmit` clean, dist rebuilt.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.test.ts`.

### M18: Preferred-model fallback stranded on declared provider (agent family preference ignored when declared provider unhealthy) `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `recommendTaskModelRoute` preferred-list walk matched agent-declared routes like `ollama-cloud/glm-5.1` by exact composite `route.model === preferredModel`. When `ollama-cloud` was unhealthy, the walk rejected the exact route and never tried other providers for the same model family — even though the registry entry for `glm-5.1` also contained a healthy `opencode-go/glm-5.1` route. The path fell through to `selectBestModelForRoleAndTask` or the last-resort loop, which sometimes returned the right answer by registry-order luck (e.g. `whenAgentModelsIncludeHealthyFallback_usesNextHealthyRoute` passed via last-resort, not via the preferred path the test name implied).
- **Why it mattered**: every fleet agent that declared a composite route and hit provider quota would silently switch *model families* instead of *providers*, bypassing the agent author's intent. On a heavy ollama-cloud quota day, a `glm-5.1`-preferring agent could end up on `glm-4.7` or worse — indistinguishable from "we chose the model registry's default" — even though a healthy `opencode-go/glm-5.1` route existed.
- **Fix**: rewrite the preferred-list walk. For each preferred composite route, find the registry entry that *contains* that route, then try (a) the exact route if healthy, (b) any healthy visible route in the same entry as a same-family fallback. New reasoning tag `"Preferred model from agent metadata, healthy fallback provider"` distinguishes the fallback path from the exact-match path.
- **Test**: strengthen `recommendTaskModelRoute_whenAgentModelsIncludeHealthyFallback_usesNextHealthyRoute` to assert `decision.reasoning` matches `/Preferred model from agent metadata/` — locks in that the resolution goes through the preferred-list fallback and prevents silent regression back to last-resort-order luck.
- **Verification**: 123/123 tests pass (unchanged count, strengthened assertion), `tsc --noEmit` clean, dist rebuilt.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.test.ts`.

### M17: Agent frontmatter `models:` block-list silently dropped (per-agent preferences ignored fleet-wide) `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `readAgentMetadata()` in `src/plugins/model-registry.ts` parsed agent frontmatter line-by-line and only understood `key: value` entries. YAML block-list syntax (the standard way to write multi-item `models:` preferences) —
  ```yaml
  models:
    - iflowcn/qwen3-coder-plus
    - opencode-go/glm-4.7
  ```
  — silently produced `metadata.models = []` because the list rows have no `:` and were skipped. Every agent in the fleet using this format had its preferred-model ordering completely ignored. `recommendTaskModelRoute` fell through to `selectBestModelForRoleAndTask` or its last-resort loop, masking the bug.
- **Why tests didn't catch it**: fixtures used the same block-list syntax, but the test assertions happened to match what the fallback path returned, so the surface-level behavior looked correct. The preferredModels-path was never actually exercised.
- **Fix**: rewrite the parser as an indexed walk instead of a `for…of` so that when we see `models:` with an empty scalar value we can peek ahead and collect subsequent indented `- item` lines until we hit a non-list row. Also strip surrounding quotes (`"..."` / `'...'`), support flow-style `models: [a, b]`, and keep the existing inline comma form for backward-compat.
- **Test**: `recommendTaskModelRoute_whenAgentFrontmatterUsesBlockStyleModelsList_parsesAllItems` — agent declares `models: [iflowcn/qwen3-coder-plus, opencode-go/glm-4.7]` as a block list; iflowcn is unhealthy; asserts the second preferred entry (`opencode-go/glm-4.7`) is selected AND the reasoning string mentions the preferred-model path (proving it wasn't the fallback path).
- **Verification**: 123/123 tests pass (122 + 1 new), dist rebuilt, overlay shims auto-pick up on fleet restart.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.test.ts`.

### M16: Long successful reasoning turns silently marked `timeout` (ROOT CAUSE of strong-model starvation) `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Symptom**: strong reasoning models (kimi-k2-thinking, minimax-m2.7, cogito-2.1, qwen3-coder:480b) were repeatedly being flagged unhealthy and routed around, even when they worked fine. Root cause was a double classification bug:
  1. `assistant.message.completed` checked `duration > timeoutMs` and marked the route `timeout` if the turn took longer than `AICODER_ROUTE_HANG_TIMEOUT_MS` (default 60s). Deep reasoning turns with many tool calls routinely run 2–10+ minutes and complete successfully — a completion is by definition not a hang.
  2. The `setTimeout` hang detector in `chat.params` was set to 60s default, so it fired on every legitimate long turn, scheduled a `timeout` write to `modelRouteHealthMap`, and (after M14) persisted it.
- **Fix**:
  - Remove the duration check from `assistant.message.completed` entirely. Add `sessionStartTimeMap.delete(sessionID)` so any late-firing setTimeout finds no start time and no-ops.
  - Add `sessionStartTimeMap.delete(sessionID)` at the top of the `session.error` handler for the same reason.
  - Raise default `AICODER_ROUTE_HANG_TIMEOUT_MS` from `60000` → `900000` (15 min). Covers realistic deep-reasoning + tool-chain turns while still catching true network hangs.
  - `setTimeout(...).unref()` in `chat.params` — health telemetry must not keep the Node event loop alive. Without this, raising the default broke the test suite (`'Promise resolution is still pending but the event loop has already resolved'`, exit 144 after 715s). Also sped the test suite from ~60s to ~13s by letting prior tests' 60s timers exit immediately instead of waiting.
- **Test**: `assistant_message_completed_after_long_duration_does_not_mark_route_timeout` — simulates a turn that starts, sleeps 20ms, then completes successfully with nonzero tokens while env var pretends the hang threshold was 1ms. Asserts the route stays out of the health map.
- **Verification**: `npx tsc -p tsconfig.json --noEmit` clean, 122/122 tests pass (121 + 1 new), suite runtime 13s (down from ~60s due to unref fix), dist rebuilt.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.keyless.test.ts`.

### M15: `session.error` bare 500 over-classified as `model_not_found` `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `session.error` handler classified `isModelNotFound = statusCode === 500 || (modelID && message.includes("model not found"))`. The `statusCode === 500` clause alone was enough to permanently mark a route `model_not_found` for 1 hour — regardless of error text. Any transient 500 (upstream maintenance, gateway burp, openrouter rate-limit-as-500, database hiccup) poisoned otherwise-healthy routes for an hour.
- **Why it mattered**: with three services sharing this plugin and dozens of agent invocations per minute, random 500s were routinely silencing whole routes. Partial-quota cascades masked as "model gone" would lock out the shared routes under load.
- **Fix**: require `message.includes("model not found")` — drop the standalone statusCode gate. Existing model-not-found path still matches (openrouter's 500+"Model not found" fixture; direct-provider 404+"model not found"). Transient 500s fall through to quota/key_dead/no_credit classification or are ignored.
- **Test**: `session_error_bare_500_without_model_not_found_message_does_not_poison_route` — fires a session.error with `statusCode:500, message:"Internal server error"` against a healthy-model route and asserts the route stays out of the health map.
- **Verification**: `npx tsc -p tsconfig.json --noEmit` clean, 121/121 tests pass (120 + 1 new), dist rebuilt.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.keyless.test.ts`.

### M14: `chat.params` setTimeout route-timeout never persisted `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `chat.params` hook schedules a `setTimeout(..., timeoutMs + 100)` that records a `timeout` state into `modelRouteHealthMap` when a route hangs past `AICODER_ROUTE_HANG_TIMEOUT_MS` (default 60s). The in-memory write happened but `persistProviderHealth()` was never called on that branch — so every opencode restart silently dropped accumulated route-timeout penalties, and the hung route would get retried immediately.
- **Why tests didn't catch it**: existing test `chat_params_when_route_hangs_classifies_route_timeout_backoff` uses `AICODER_ROUTE_HANG_TIMEOUT_MS=20` which falls through the `timeoutMs < 1000` test-only branch — that branch *does* persist. The production `setTimeout` branch was untested.
- **Fix**: add `void persistProviderHealth(providerHealthMap, modelRouteHealthMap);` after the `modelRouteHealthMap.set(..., "timeout", ...)` inside the `setTimeout` callback, mirroring the already-tested fast branch at line 1167. One-line parallel change.
- **Verification**: `npx tsc -p tsconfig.json --noEmit` clean, 120/120 tests pass, dist rebuilt.
- **No new test**: the setTimeout path requires real wall-clock wait past 1000ms (test branch gates on `< 1000`); a faithful test would add 1+ second of sleep to the suite. Pattern matches the already-tested fast branch. Race-reproduction tests for setTimeout-driven persistence are inherently flaky.
- **Files**: `src/plugins/model-registry.ts`.

### M11: Atomic write for `provider-health.json` `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `.opencode/state/plugin/provider-health.json` contained stale tail bytes past the valid JSON terminator (`{...retryCount": 1\n  }\n}yCount": 1\n  }\n}`). Classic concurrent-writer race: a shorter later write layered over a longer prior write leaked tail bytes — Node's `fs.writeFile` opens with `O_TRUNC` but multiple processes racing on the same path can still interleave.
- **Root cause**: three services (`aicoder-opencode`, `dr-repo`, `letta-workspace`) share `~/code/aicoder-opencode/.opencode/state/plugin/provider-health.json` and persist concurrently via `persistProviderHealth()` in `src/plugins/model-registry.ts`, using plain `writeFile`.
- **Fix**: `persistProviderHealth()` now writes to `<target>.<pid>.<rand>.tmp` and `rename()`s into place — atomic on the same filesystem, last-write-wins, no partial reads. Best-effort tmp cleanup on failure. Corrupted state file was also cleaned in-place (recovered one valid entry: `ollama-cloud/glm-4.7` quota backoff).
- **Verification**: `npx tsc -p tsconfig.json --noEmit` clean, `node --import tsx --test 'src/**/*.test.ts'` 118/118 pass.
- **No new test**: `persistProviderHealth()` is module-private and the state file path is hardcoded, so a direct concurrency test would require a refactor (DI on the path) that exceeds this slice. Race-reproduction tests are inherently flaky. Pattern is standard tmp+rename — relying on existing coverage for the health-recording paths that call through `persistProviderHealth()`.
- **Files**: `src/plugins/model-registry.ts` (persist function + import), `.opencode/state/plugin/provider-health.json` (cleaned).

---

## Completed (archive)

### M1: Target-aware database maintenance CLI

Analysis (2026-04-11):
- `opencode-database-maintenance` command previously only operated on the control plane's own database
- Adding `--target <name>` allows maintenance of target-specific databases
- Database paths follow the pattern `<root>/.opencode/xdg-data/opencode/opencode.db`
- Both dr-repo and letta-workspace confirmed to use this pattern
- Backward compatible: no `--target` = existing behavior

### M2: ROADMAP.md and maintenance state tracking

Analysis (2026-04-11):
- Control plane previously had no durable maintenance tracking
- ROADMAP.md established as the canonical maintenance backlog
- Session title and checkpoint updates integrated into the maintenance workflow
