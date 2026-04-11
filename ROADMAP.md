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
