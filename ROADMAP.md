# aicoder-opencode Roadmap

Shared maintenance control plane for repo-local AI coding lanes.

## Current State

- **Branch:** `main` — 12 commits ahead of origin (unpushed)
- **Build:** package.json hardcodes `bun` (not installed); Makefile has npm fallback
- **Targets:** `dr-repo`, `letta-workspace` — both validate OK

## Slice Queue

### S001: Fix build system — package.json bun dependency
- **Status:** ✅ COMPLETED
- **Priority:** High (blocks `make check` on machines without bun)
- **Completion Notes (2026-04-11):** Changed `package.json` check script from `bun run build && bun run test` to `npm run build && npm run test`. Added .specify/, spec-kit/, Product-Manager-Skills/ to .gitignore. Build verified with `make check` after installing dependencies.

### S002: Commit accumulated agent routing changes
- **Status:** Pending
- **Priority:** Medium (12 unpushed commits + unstaged agent model routing changes)
- **Scope:** Review and commit the agent model routing updates (zai-coding-plan → xiaomi-token-plan-ams/opencode-go), Makefile bun/npm fallback, and maintenance script timeout change
- **Risk:** Need to verify agent model assignments match actual provider availability

### S003: Clean untracked directories
- **Status:** Pending
- **Priority:** Low (spec-kit/, Product-Manager-Skills/ are git subrepos; apps/opencode-triad-ui is WIP)
- **Scope:** Decide whether to add to .gitignore, commit as submodule, or remove

### S004: Push unpushed commits
- **Status:** Pending
- **Priority:** Low (local-only changes)
- **Scope:** Review 12 ahead-of-origin commits, verify they're ready, push to origin

## Completed

_(none yet — first iteration)_

## Parked

_(none yet)_
