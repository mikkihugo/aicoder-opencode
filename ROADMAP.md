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
- `node --import tsx --test 'src/**/*.test.ts'` — 45/45 pass
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

### M5: Database path auto-discovery `⬜ PENDING`

- When `--target` is not specified, scan known XDG paths to find the actual database
- Current behavior: always uses `~/.local/share/opencode/opencode.db`
- Risk: could discover wrong database in multi-install setups

### M6: Backup directory target-awareness `⬜ PENDING`

- Backup directory is always `~/.local/state/opencode/backups` regardless of `--target`
- Target-specific backups should go to `<root>/.opencode/xdg-data/opencode/backups/`
- Or at minimum, include target name in backup filename

### M8: Letta-workspace overlay — make agent files durable `✅ COMPLETED`

Completion Notes (2026-04-11):
- Created `targets/letta-workspace/overlay/.opencode/agents/` and seeded with all 15 live agent files from `letta-workspace/.opencode/agents/` — byte-identical `diff -q` verified pre-swap.
- Atomic swap on letta side: `mv agents agents.bak && ln -s <absolute overlay path> agents`, re-verified identical content through the symlink, removed `.bak`.
- `letta-workspace/.opencode/agents` → `/home/mhugo/code/aicoder-opencode/targets/letta-workspace/overlay/.opencode/agents` (absolute symlink, matching dr-repo layout).
- PDD-softened `implementation_lead.md` (6-line Purpose block + CONFIDENCE slot + subagent-output guard) is now version-controlled via this overlay.
- **Closes letta LW1** (cross-reference in `/home/mhugo/code/letta-workspace/roadmap.md`).
- Still ephemeral in letta: `.opencode/bin/`, `.opencode/commands/`, `.opencode/plugins/` — deferred to M10 for principled propagation rather than repeat manual copy.

### M9: Enforce partner/combatant review discipline `⬜ PENDING`

- During the M1 slice, the aicoder autopilot dispatched exactly 1 subagent (`roadmap_keeper`) and then did all 38 bash + 12 read + 4 edit calls solo. The implementation_lead workflow prompt explicitly says "for every non-trivial slice, run a concrete partner/combatant pair in parallel before coding" — this step was silently skipped.
- The PDD Purpose-gate softening does NOT enforce subagent dispatch; it only asks the lead to frame the slice. A lead that frames AND skips review still ships un-reviewed code.
- Fix options: (a) add a hard rule that non-trivial slices MUST show a `task` tool call to a supportive + adversarial specialist before any `edit` tool call; (b) add a pre-commit hook that rejects autopilot commits lacking a review annotation in the checkpoint; (c) add a verifier-pass check at close-out that refuses to mark `[COMMIT]` without review evidence.
- Evidence: `ses_284ca4aa4ffeIUhQjEjeomSPUB` on `:8080`, commit `c700ce8` shipped solo after only `roadmap_keeper`.

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
