# aicoder-opencode Roadmap

Shared maintenance control plane for repo-local AI coding lanes.

## Current State

- **Branch:** `main` — 14 commits ahead of origin (unpushed)
- **Build:** `make check` works (bun→npm fallback); 14/14 tests pass
- **Targets:** `dr-repo`, `letta-workspace` — both validate OK
- **Agents:** model routing updated to registry-approved providers (iflowcn, xiaomi-token-plan-ams, ollama-cloud, kimi-for-coding)
- **Maintenance:** timeout increased to 1200s

## Slice Queue

### S001: Fix build system — package.json bun dependency
- **Status:** ✅ COMPLETED
- **Priority:** High (blocks `make check` on machines without bun)
- **Completion Notes (2026-04-11):** Changed `package.json` check script from `bun run build && bun run test` to `npm run build && npm run test`. Added .specify/, spec-kit/, Product-Manager-Skills/ to .gitignore. Build verified with `make check` after installing dependencies.

### S002: Commit accumulated agent routing changes
- **Status:** ✅ COMPLETED
- **Priority:** Medium (12 unpushed commits + unstaged agent model routing changes)
- **Completion Notes (2026-04-11):** Committed 26 files with model routing updates. All models verified against config/models.jsonc registry. Changes: codebase_explorer/consumer_advocate/critical_reviewer → iflowcn/qwen3-coder-plus; implementation_lead/implementation_worker → xiaomi-token-plan-ams/mimo-v2-pro; documentation_researcher/long_context_reader/architecture_consultant → ollama-cloud/minimax-m2.7. Makefile bun/npm fallback. Maintenance timeout 300s→1200s. implementation_lead.md got 'persist findings' close-out workflow.

### S003: Clean untracked directories
- **Status:** ✅ COMPLETED
- **Priority:** Low
- **Completion Notes (2026-04-11):** Added .specify/, spec-kit/, Product-Manager-Skills/, apps/ to .gitignore. These are external repos (git subrepos) that don't belong in aicoder-opencode.

### S004: Push unpushed commits
- **Status:** Parked
- **Priority:** Low (local-only changes)
- **Parked (2026-04-11):** 16 commits ahead of origin. Pushing to origin is a visible external action — requires user confirmation. All local commits verified: `make check` passes, targets validate.

## Completed

_(none yet — first iteration)_

## Parked

_(none yet)_
