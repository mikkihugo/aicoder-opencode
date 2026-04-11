# aicoder-opencode Maintenance Log

Chronological worklog of control-plane changes. One entry per shipped/analyzed/parked slice. No forward-looking slice queue — that's product-roadmap territory and does not belong here.

## 2026-04-11 — build-system-bun-fix
- **Status:** SHIPPED
- **Change:** `package.json` check script: `bun run build && bun run test` → `npm run build && npm run test`. Added `.specify/`, `spec-kit/`, `Product-Manager-Skills/`, `apps/` to `.gitignore` (external subrepos).
- **Why:** `make check` was broken on machines without bun installed; external subrepos were polluting `git status`.
- **Verification:** `make check` — 14/14 tests pass.
- **Follow-ups:** none.

## 2026-04-11 — agent-routing-commit
- **Status:** SHIPPED
- **Change:** Committed 26 files of accumulated model-routing updates against `config/models.jsonc` registry. Providers: `iflowcn/qwen3-coder-plus` (readers/reviewers), `xiaomi-token-plan-ams/mimo-v2-pro` (implementation leads/workers), `ollama-cloud/minimax-m2.7` (long-context/research), `kimi-for-coding/kimi-k2-thinking` (dr-repo lead fallback). Makefile bun→npm fallback. Maintenance timeout 300s→1200s. `implementation_lead.md` files got the persist-findings close-out workflow.
- **Why:** 12 unpushed local commits + unstaged agent edits were drifting out of band; routing needed to match the curated registry.
- **Verification:** `make check` pass; all referenced models exist in `config/models.jsonc`.
- **Follow-ups:** S004 parked — pushing 16 commits to origin is a visible external action; requires explicit user confirmation.
