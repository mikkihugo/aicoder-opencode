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

### M32: `recommendTaskModelRoute` last-resort fallback returned provider-healthy but route-level-dead routes `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: the terminal `for (const entry of roleMatchedEntries)` loop at the end of `recommendTaskModelRoute` (post-best-branch fall-through) iterated visible routes and returned the first whose PROVIDER was healthy. It did not consult `modelRouteHealthMap` at all, so a provider-healthy-but-route-dead route (`model_not_found`, zero-token quota, hang-timer `timeout`) was returned as the "Fallback to first healthy visible route" and the caller got a route that was guaranteed to fail on the next inference call. Same bug class as M29 (agent-facing tool output), M31 (ranking comparator) — third variant at the terminal routing path.
- **Reachability**: production-reachable. Path to hit: caller has no agent metadata (preferredModels=[]) and a task prompt that does not match any candidate's `best_for`/`default_roles` substring, so `selectBestModelForRoleAndTask` filters down to zero candidates and returns null → `best` branch is skipped → last-resort scan kicks in. If any role-matched entry has a primary visible route with a route-level penalty but a healthy provider, that route was returned as the recommendation.
- **Fix**: walk visible routes with both `isProviderHealthy(providerHealthMap, route.provider, now)` AND `modelRouteHealthMap.get(composeRouteKey(route))?.until <= now` as `continue` guards, then return the first route that passes both. Control flow preserved — the function still throws at the end if no entry has a fully-healthy visible route.
- **Test**: `recommendTaskModelRoute_whenLastResortMustSkipRouteLevelDeadRoute_returnsNextHealthyRoute` — single role-matched entry with two visible routes (`iflowcn/dead-last-resort` with `model_not_found` penalty, `ollama-cloud/live-last-resort` healthy); no agent metadata; task prompt `"zzz_completely_orthogonal_task_description_nothing_matches"` to force `best` to return null and push control into last resort. Asserts `selectedModelRoute === "ollama-cloud/live-last-resort"` AND `reasoning` matches `/Fallback to first healthy visible route/`.
- **Verification**: verified-on-HEAD by temporarily reverting the last-resort block to provider-only; exactly 1 test failed (the new one), restored fix, 143/143 green (142 + 1 new). `npm run build` clean.
- **Files**: `src/plugins/model-registry.ts` (last-resort fallback loop), `src/plugins/model-registry.test.ts` (1 new test).
- **Rebuilt `dist/plugins/model-registry.js`** so overlay shims pick up the fix.

### M31: `selectBestModelForRoleAndTask` ranking counter ignored `modelRouteHealthMap` — route-level-dead candidates could win ties against fully-live candidates `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: the ranking comparator in `selectBestModelForRoleAndTask` computed an "unhealthy visible route" count per candidate using ONLY `isProviderHealthy(providerHealthMap, route.provider, now)`. The third parameter `_modelRouteHealthMap` was declared with a leading underscore to silence the unused-param warning — an explicit TODO marker. Two candidates at the same capability tier — one whose visible routes were all route-level dead (`model_not_found`, zero-token quota, hang `timeout`) but provider-healthy, and one with fully live visible routes — counted equal, and sort stability then picked whichever came first in the input array (which is registry declaration order, not health order).
- **Reachability**: production-reachable. The downstream caller (`recommendTaskModelRoute`'s best branch at line ~948) walks the winning entry's visible routes searching for a health one and falls through to the last-resort scan if none pass — so an actual inference failure was unlikely, but the reasoning string was wrong ("Best registry model for role") and the last-resort scan bypasses the intent of the best branch, which is to honor billing preference + capability tier. Also a silent correctness defect in the exported helper used in tests and potentially in future callers.
- **Fix**: un-underscore the parameter (interface is now honored), add an `isRouteUnhealthy` closure that unions provider-level and route-level health via `composeRouteKey(route)` (the M30 helper), and count routes against that closure. No change to tier/billing ordering.
- **Test**: `selectBestModelForRoleAndTask_whenCandidateHasDeadVisibleRoutes_ranksLowerThanCandidateWithLiveRoutes` — two candidates at tier `strong` / billing `free`, deadCandidate has `iflowcn/dead-strong` with a `model_not_found` penalty and is passed FIRST in the input array (so sort stability favored it under the old counter), liveCandidate has `ollama-cloud/live-strong` fully healthy. Asserts `best.id === "live-route-strong"`.
- **Verification**: verified-on-HEAD by temporarily stubbing the counter back to provider-only + `void modelRouteHealthMap`; exactly 1 test failed (the new one), restored fix, 142/142 green (141 + 1 new). `npm run build` clean.
- **Files**: `src/plugins/model-registry.ts` (parameter un-underscored, comparator closure), `src/plugins/model-registry.test.ts` (import + 1 new test).
- **Rebuilt `dist/plugins/model-registry.js`** so overlay shims pick up the fix.

### M30: `modelRouteHealthMap` lookups used raw `providerRoute.model` but writes used composite `${provider}/${model.id}` — longcat routes silently ignored all route-level penalties `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: write-side keys into `modelRouteHealthMap` are always composite — session.error at line 1355 builds `` `${providerID}/${modelID}` ``, assistant.message.completed at line 1436 does the same, and the chat.params hang timer at lines 1477/1497 also. Read-side lookups, however, passed `providerRoute.model` verbatim in seven places (`findCuratedFallbackRoute`, `computeRegistryEntryHealthReport`, `buildProviderHealthSystemPrompt`'s owning-entry `find`, `buildAvailableModelsSystemPrompt`, `recommendTaskModelRoute`'s preferredModels walker, `recommendTaskModelRoute`'s best-entry walker, and `recommend_model_for_role`'s alternatives map). For most registry entries this was harmless because `provider_order[].model` is already composite (`ollama-cloud/glm-5`, `iflowcn/qwen3-coder-plus`). For three longcat entries it was NOT — `config/models.jsonc` stores `{ provider: "longcat", model: "LongCat-Flash-Chat" }` UNPREFIXED (same for `LongCat-Flash-Thinking` and `LongCat-Flash-Lite`).
- **Reachability**: **production-reachable today**. `longcat-flash-chat`, `longcat-flash-thinking`, and `longcat-flash-lite` are all enabled entries in `config/models.jsonc` and are actively routed. Every path to `modelRouteHealthMap.get(...)` with a longcat entry's raw `.model` field returns `undefined`, so a route-level `model_not_found`, zero-token quota, or hang-timer `timeout` recorded by the error handlers is invisible to the health-aware routing logic, to the system-prompt fallback walker, and to the agent-facing `list_curated_models` / `recommend_model_for_role` tool output. Agents keep getting routed to provably dead longcat models. Discovered via a `python3` audit of `config/models.jsonc` looking for `provider_order[].model` values that do not start with `` `${provider}/` ``.
- **Fix**: added exported pure helper `composeRouteKey(providerRoute)` that returns `providerRoute.model` if it already starts with `` `${provider}/` ``, otherwise returns `` `${provider}/${model}` ``. Applied at all seven read sites. `buildProviderHealthSystemPrompt`'s owning-entry `find` now compares `composeRouteKey(route) === routeKey` so the "Curated fallback for X" line emits for unprefixed longcat entries. Write paths left unchanged because they already produce composite keys. Normalization at the read boundary keeps the persisted `providerHealth.json` format stable.
- **Tests**: (a) `composeRouteKey_whenRegistryEntryIsUnprefixed_producesCompositeKey` — pins all three shapes: unprefixed longcat, already-composite `ollama-cloud/glm-5`, nested composite `openrouter/xiaomi/mimo-v2-pro`. (b) `computeRegistryEntryHealthReport_whenLongcatEntryIsUnprefixed_detectsRouteLevelPenaltyFromCompositeKey` — seeds `modelRouteHealthMap.set("longcat/LongCat-Flash-Chat", { state: "model_not_found", ... })` and a longcat-flash-chat registry entry, asserts the report surfaces the `model_not_found` penalty with `scope: "route"`. `findCuratedFallbackRoute` was rejected as the regression anchor because longcat is also substring-blocked in `FALLBACK_BLOCKED_MODEL_SUBSTRINGS` (different filter, would mask the regression); `computeRegistryEntryHealthReport` has no such filter.
- **Verification**: verified-on-HEAD by temporarily stubbing `composeRouteKey` body to `return providerRoute.model`, re-running tests — exactly 2 failures (both new tests), no others. Restored fix, 141/141 green (139 + 2 new). `tsc -p tsconfig.json` clean.
- **Files**: `src/plugins/model-registry.ts` (new exported helper, 7 read sites normalized), `src/plugins/model-registry.test.ts` (import + 2 new tests).
- **Rebuilt `dist/plugins/model-registry.js`** so dr-repo and letta-workspace overlay shims pick up the fix on next service start.

### M29: `list_curated_models` + `recommend_model_for_role` tools read raw `provider_order[0]` and ignored route health — lied to agents about primary-route health `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: two agent-facing plugin tools reported health on raw `provider_order[0]` using `isProviderHealthy(primaryRoute.provider)` only.
  1. `listCuratedModels` (feeds `list_curated_models` and `select_models_for_role` tool output): each entry's `providerHealth` field showed `null` (treated as "healthy") even when the primary route had `model_not_found`, zero-token quota, or a hang-timer `timeout` at the route level while the overall provider was healthy — agents kept picking dead primaries from the tool output.
  2. `recommend_model_for_role`: `primaryProviderHealthy` and `alternativeRoutes[].healthy` both only checked provider-level health; route-level penalties were silently ignored, and raw `provider_order[0]` could expose hidden paid routes (defensive class shared with M23/M24/M28).
- **Reachability**: the route-health aspect is production-reachable today — any 404 `model_not_found`, zero-token quota response, or hang-timeout on a live route populates `modelRouteHealthMap` but leaves provider health untouched. The visibility aspect is defensive (grep of `config/models.jsonc` confirms no current entry has a hidden provider as `provider_order[0]`), but kept consistent with the rest of the plugin.
- **Fix**: extract pure helper `computeRegistryEntryHealthReport(entry, providerHealthMap, modelRouteHealthMap, now)` that walks `filterVisibleProviderRoutes` + checks both maps and returns `{ state, until, scope: "provider" | "route" } | null`. New `scope` field lets the agent distinguish "whole provider down" from "this specific route dead". Rewire `listCuratedModels` to call the helper. Rewire `recommend_model_for_role` to use `filterVisibleProviderRoutes` as the walk source and a shared `isRouteHealthy(route)` closure that consults both maps for both the primary and `alternativeRoutes`. Also replace its inline provider-only expire loop with `expireHealthMaps(providerHealthMap, modelRouteHealthMap, now)` (M25 helper) so `recommend_model_for_role` cleans up route entries too.
- **Tests**: (a) `computeRegistryEntryHealthReport_whenPrimaryVisibleRouteIsRouteUnhealthy_reportsRouteScope` — single-route entry with `modelRouteHealthMap` containing `iflowcn/dead-primary: model_not_found`, asserts `report.state === "model_not_found"` and `report.scope === "route"`. (b) `computeRegistryEntryHealthReport_whenPrimaryRouteIsHiddenPaid_walksToVisibleSibling` — mimo-v2-pro shape `[openrouter/xiaomi/mimo-v2-pro, opencode-go/mimo-v2-pro]` with `openrouter` marked quota-backoff; asserts `report === null` because the visible primary (`opencode-go`) is healthy. Verified regression on HEAD-equivalent: temporarily reverted helper body in place to `provider_order[0]` + provider-only, both new tests failed (null expected scope:route; null expected scope:provider from hidden primary), restored fix, 139/139 green.
- **Verification**: `npm test` 139/139 (137 + 2 new), `npm run build` clean, both regression tests verified to fail on pre-fix helper body.
- **Files**: `src/plugins/model-registry.ts` (new exported helper, two call sites rewired), `src/plugins/model-registry.test.ts` (2 new tests + import).
- **Rebuilt `dist/plugins/model-registry.js`** so dr-repo and letta-workspace overlay shims pick up the fix on next service start.

### M28: `buildAvailableModelsSystemPrompt` used raw `provider_order[0]` and ignored route health — listed dead models as "available" `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `buildAvailableModelsSystemPrompt` decided whether to surface each registry entry under the "Available models" section of the penalty-mode system prompt by reading `entry.provider_order[0]` (raw first route) and only checking `isProviderHealthy(primaryRoute.provider)`. Two independent defects, both reachable:
  1. Raw `provider_order[0]` leaked hidden paid routes (togetherai, xai, cerebras, cloudflare-ai-gateway, non-`:free` openrouter, deepseek, github-copilot, minimax-cn*) into the decision. For entries whose first route is such a hidden provider, the function was asking "is the hidden paid provider healthy?" — often yes, leading to the entry being listed under a route the rest of the plugin actively blocks. Same bug class as M23/M24 at yet another call site.
  2. Route-level health was ignored entirely. An entry whose primary had `model_not_found` / route-level quota / hang-timer `timeout` but a healthy overall provider was listed as "available" despite being provably dead.
- **Secondary bug**: the function guarded with `if (providerHealthMap.size === 0) return null;` — same M27 short-circuit. Route-only penalties produced no "Available models" block even when the rest of the transform (post-M27) emitted the route-level warning. Inconsistent with the sibling `buildProviderHealthSystemPrompt` after M27.
- **Fix**: walk `filterVisibleProviderRoutes(entry.provider_order)` and select the first route that is both provider-healthy AND route-healthy (`modelRouteHealthMap.get(route.model)?.until <= now`). Skip the entry if no such route exists. Expand the outer guard to `providerHealthMap.size === 0 && modelRouteHealthMap.size === 0`. Thread `modelRouteHealthMap` through from the transform hook call site. Export for direct unit testing.
- **Semantic choice**: an entry with a hidden paid primary and a visible+healthy sibling is now listed as "available". Previously it was skipped or mis-listed. This matches the intent — the plugin will route the actual request through the visible sibling via M23's `best` branch.
- **Tests**: (a) `buildAvailableModelsSystemPrompt_whenPrimaryRouteIsHiddenPaid_walksToVisibleSibling` — seeds `[togetherai hidden, opencode-go visible]`, triggers the outer guard with an unrelated route-only penalty, asserts the entry appears in the prompt under its role. (b) `buildAvailableModelsSystemPrompt_whenOnlyVisibleRouteIsUnhealthyAtRouteLevel_skipsEntry` — pins the route-health filter by marking the single visible route as `model_not_found` and asserting the entire prompt collapses to null because no entries survive.
- **Verification**: 137/137 tests pass (135 + 2 new), `tsc -p tsconfig.json` clean.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.test.ts`.

### M27: system prompt silently ignored route-level penalties — short-circuit on `providerHealthMap.size === 0` skipped the whole health block `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `experimental.chat.system.transform` guarded the health injection with `if (providerHealthMap.size === 0) return;`. Three common error paths write ONLY to `modelRouteHealthMap`, never touching `providerHealthMap`: (a) `assistant.message.completed` with zero input+output tokens → route-level `quota`, (b) `session.error` with "model not found" message → route-level `model_not_found`, (c) the hang-detector `setTimeout` in `chat.params` after `AICODER_ROUTE_HANG_TIMEOUT_MS` → route-level `timeout`. When any of these fired and no provider-level penalty was present, the transform hook returned early and the agent got zero warning that the route it was currently using had just been classified as dead. It would happily retry the exact same dead route on the next turn until enough route failures eventually escalated something to provider level.
- **Secondary bug**: `buildProviderHealthSystemPrompt` itself had no code path for route-level penalties — it only iterated `providerHealthMap`. Even if the outer guard had been removed in isolation, the prompt builder would have returned an empty string.
- **Fix**: extend `buildProviderHealthSystemPrompt` to also iterate `modelRouteHealthMap.entries()` filtered by `until > now`. For each active route penalty, locate the owning registry entry (first enabled entry whose `provider_order[].model === routeKey`) and emit a section with the route id, state label, expiry time, and a "Curated fallback for &lt;entry.id&gt;" line computed via `findCuratedFallbackRoute`. The route-level health check added in M24 means passing an empty `blockedProviderID` is safe: the bad route is skipped via the route-health check, not via the provider-id check, and any sibling visible+healthy route can serve as the fallback. Also drop the transform-hook guard to `providerHealthMap.size === 0 && modelRouteHealthMap.size === 0`.
- **Export**: `buildProviderHealthSystemPrompt` was file-private; exported it for direct unit testing.
- **Tests**: (a) `buildProviderHealthSystemPrompt_whenOnlyRoutePenaltiesExist_emitsRouteSection` — seeds a single entry with two routes (iflowcn primary dead via `model_not_found`, opencode-go secondary live), calls with empty provider map, asserts the emitted prompt contains both `Route iflowcn/qwen3-coder-plus [MODEL NOT FOUND]` AND the `Curated fallback for qwen3-coder-plus: opencode-go/qwen3-coder-plus` line (proving the M24 route-aware fallback walker feeds correctly into the M27 section). (b) `buildProviderHealthSystemPrompt_whenNoPenalties_returnsNull` — pins the clean-state fast path.
- **Deferred to a follow-up**: `buildAvailableModelsSystemPrompt` still uses raw `provider_order[0]` and ignores route health. Same bug class, different function. Left unfixed in this commit to keep the edit bounded; will be M28 or later.
- **Verification**: 135/135 tests pass (133 + 2 new), `tsc -p tsconfig.json` clean.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.test.ts`.

### M26: session terminal handlers only cleared `sessionStartTimeMap` — `sessionActiveProviderMap` and `sessionActiveModelMap` leaked one entry per session forever `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: `chat.params` populates three per-session maps — `sessionStartTimeMap`, `sessionActiveProviderMap`, `sessionActiveModelMap` — that the hang-detector `setTimeout` and the `session.error` / `assistant.message.completed` handlers read to classify route failures. Both terminal handlers only called `sessionStartTimeMap.delete(sessionID)` — leaving the other two maps growing unbounded for the full lifetime of the plugin process. Every session in a long-running autopilot loop (days of uptime, hundreds of sessions) leaked two Map entries.
- **Correctness impact**: zero. The hang-detector short-circuits on `sessionStartTimeMap.get(sessionID)` being falsy, so stale provider/model entries don't cause misclassification — they just sit in memory forever. But it's a real unbounded growth bug, and on dr-repo autopilot the plugin is expected to run for weeks.
- **Fix**: extracted `clearSessionHangState(sessionID, startMap, providerMap, modelMap)` helper and called it from both terminal handlers. Both handlers now read `providerID` and `model` BEFORE clearing, so the downstream classification (`model_not_found`, quota, no-credit, key-dead for session.error; zero-token quota for completed) still has the context it needs.
- **Why a unit-test-only regression**: the session maps are created inside the `ModelRegistryPlugin` factory closure and are not directly observable from outside the plugin object. I did NOT add a test-only inspector tool (test-only APIs rot quickly) — instead I extracted `clearSessionHangState` as an exported pure function and unit-tested it directly on seeded maps, pinning the contract that all three maps lose the target session while sibling sessions are untouched. The behavioral side (that the handlers now call it) is covered transitively by the existing event-hook tests (session_error_model_not_found, session_error_bare_500, assistant_message_completed_with_zero_tokens, assistant_message_completed_after_long_duration) all still passing after the refactor — they exercise the production code path including the new clearing logic and verify the classification stays correct.
- **Verification**: 133/133 tests pass (132 + 1 new), `tsc -p tsconfig.json` clean.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.test.ts`.

### M25: `experimental.chat.system.transform` only expired providerHealthMap — modelRouteHealthMap grew unbounded and leaked to persisted disk state `✅ COMPLETED`

Completion Notes (2026-04-11):
- **Bug observed**: the `experimental.chat.system.transform` hook ran a local `for (const [providerID, health] of providerHealthMap.entries()) { if (health.until <= now) providerHealthMap.delete(providerID); }` loop on every message to keep the provider health map lean. It did NOT run the equivalent loop on `modelRouteHealthMap`. Since the only other `modelRouteHealthMap.delete` site was `get_quota_backoff_status` (which only fires when the agent explicitly queries status), every route-level penalty — `model_not_found`, route-level quota, hang-timer `timeout` — stayed in memory for the full lifetime of the process.
- **Consequence 1 (memory)**: long-running plugin sessions (autopilot loops, days of uptime) accumulated dead route entries without bound. Not catastrophic but real and easy to fix.
- **Consequence 2 (persisted disk state)**: `persistProviderHealth(providerHealthMap, modelRouteHealthMap)` is called from every error-event handler and serializes both maps to `providerHealth.json`. Expired-but-still-in-memory route entries were re-written to disk on every error, and `loadPersistedProviderHealth` on restart reloaded them and clamped-or-kept them depending on their `until` values. Cross-restart drift: route backoffs that should have expired while the process was stopped didn't, because `loadPersistedProviderHealth` doesn't currently expire at load time either (it just trusts the stored `until` — which is correct as long as the in-memory map is kept pruned).
- **Consequence 3 (semantic)**: M23 and M24 both added `modelRouteHealthMap.get(route.model)?.until <= now` checks. Those checks are correct regardless of whether stale entries are pruned (an expired entry with `until <= now` is equivalent to no entry), so the routing decisions themselves were not broken by the leak. Only memory and disk state were affected.
- **Fix**: extract a shared `expireHealthMaps(providerHealthMap, modelRouteHealthMap, now)` helper that walks both maps in-place, and call it from the transform hook instead of the inline provider-only loop. Exported for direct unit testing. `key_missing` entries with `until = Number.POSITIVE_INFINITY` remain non-expiring by construction (`Infinity > now` is always true, so the `<= now` check never fires).
- **Tests**: (a) `expireHealthMaps_whenRouteEntryExpired_dropsRouteEntry` — seeds each map with one expired and one live entry, asserts only the expired entries are dropped from BOTH maps. (b) `expireHealthMaps_whenKeyMissingEntryIsInfinite_neverExpires` — pins the `key_missing` semantics by advancing `now` one year and asserting the entry survives. (No "fails on old behavior" pass needed — the function is brand new, the test is the spec for what it must do.)
- **Verification**: 132/132 tests pass (130 + 2 new), `tsc -p tsconfig.json` clean.
- **Files**: `src/plugins/model-registry.ts`, `src/plugins/model-registry.test.ts`.

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
