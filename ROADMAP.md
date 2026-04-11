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
- `node --import tsx --test src/**/*.test.ts` — 14/14 pass
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

### M3: CLI unit tests for `cli.ts` main() `⬜ PENDING`

- `src/cli.ts` has 746 lines but no unit tests for the CLI handler
- The `main()` function covers target loading, validation, launch, doom-loop, model registry, and DB maintenance
- Test at least: argument parsing, target resolution, error paths

### M4: Batch database maintenance across all targets `⬜ PENDING`

- Currently requires one invocation per target
- A `--all-targets` flag would run checkpoint/backup across all configured targets in one call
- Useful for scheduled maintenance (cron, systemd timer)

### M5: Database path auto-discovery `⬜ PENDING`

- When `--target` is not specified, scan known XDG paths to find the actual database
- Current behavior: always uses `~/.local/share/opencode/opencode.db`
- Risk: could discover wrong database in multi-install setups

### M6: Backup directory target-awareness `⬜ PENDING`

- Backup directory is always `~/.local/state/opencode/backups` regardless of `--target`
- Target-specific backups should go to `<root>/.opencode/xdg-data/opencode/backups/`
- Or at minimum, include target name in backup filename

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
