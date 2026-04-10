# .opencode/plugins/ — Repo-Local OpenCode Runtime Plugins

This directory contains the repo-local OpenCode runtime plugins for `dr-repo`.

Use this file as the quick map of the plugin layer.
Do not put workflow doctrine here. Repo workflow still belongs in:
- [`../../AGENTS.md`](../../AGENTS.md)
- [`../../.agents/skills/`](../../.agents/skills/)
- [`../../docs/OPENCODE_AGENT_POLICY.md`](../../docs/OPENCODE_AGENT_POLICY.md)

## Plugin Map

| Plugin | Purpose | Key Runtime Surface |
|--------|---------|---------------------|
| `aicoder-model-registry` | Shared control-plane model registry surface from `aicoder-opencode` | curated model listing, role-based model selection |
| `dr-checkpoints` | Session continuity and completion state | checkpoint state, stale checkpoint detection, slice completion checks |
| `dr-plan-context` | Active plan and active-slice context loading | active plan reload, active slice reload, repo state projection, active plans listing |
| `dr-context-compaction` | Context compaction that preserves DR state | structured active-slice preservation during compaction |
| `dr-session-continuation` | Autonomous iteration and continuation behavior | `/autopilot` support, resume behavior, continuation hints |
| `dr-verification-guard` | Verification evidence capture | tool execution evidence recording, verification status surface |
| `dr-json-error-recovery` | Tool-call recovery hint for malformed JSON arguments | guarded JSON parse reminder on real tool-call failures |
| `dr-helper-runtime-control` | Runtime helper fanout control and helper-session inspection | hard helper concurrency caps, helper child session inspection, bounded helper output retrieval |
| `dr-agent-babysitter` | Session-local helper-health and activity tracking | helper failure ledger, recent helper activity, unstable helper warnings, helper inspection |
| `dr-specialist-routing` | Helper-agent selection and delegation policy | specialist suggestions, helper catalog, delegation caps |
| `dr-memory` | Durable cross-session DR memory | memory remember/record outcome/recall/sync/forget, QMD-backed lexical or semantic recall |
| `dr-public-code-search` | Public implementation-pattern research | `grep_app_search` tool with canonical grep.app URL fallback |
| `dr-ast-grep-search` | Local syntax-aware code search | `ast_grep_search` tool for structural search when raw text grep is too weak |

## Design Rules

- Each plugin should have one clear runtime concern.
- Keep business workflow out of plugins.
- Keep plugin tools narrow and state-aware.
- Prefer repo artifacts and explicit state over hidden agent memory.
- Public code examples are pressure, not truth. Repo evidence and official docs win.

## Notes

- `aicoder-model-registry` is a repo-local install shim. Source lives in `/home/mhugo/code/aicoder-opencode/src/plugins/model-registry.ts`.
- `dr-public-code-search` is best-effort. Server-side access to `grep.app` may be blocked by Vercel security checks from this environment, so the tool can fall back to a canonical search URL instead of pretending success.
- `dr-json-error-recovery` only fires on error-shaped tool outputs and skips content-heavy tools, so structural/code-search results do not get polluted by false JSON reminders.
- `dr-ast-grep-search` is the structural complement to `rg`. Use it for handlers, methods, hook shapes, or other syntax-aware queries; keep patterns narrow and path-scoped.
- `dr-memory` stores durable knowledge only. Current slice state belongs in checkpoints and active-slice artifacts.
- `memory_record_outcome` is the structured path for feature outcomes, smoke regressions, user friction findings, and runbook learnings. Do not use it as a generic run log.
- `memory_ingest_pending_outcomes` is the bridge from shell/deploy automation into `dr-memory`. Shell scripts may leave bounded JSON files in `.opencode/state/pending-outcomes/`, but only ingestion should turn them into recallable memory.
- `.opencode/bin/dr-memory-queue-outcome` is the shell entrypoint for that bridge. The staging and Hetzner smoke wrappers use it to queue failed smoke regressions, and they can optionally queue a feature outcome when a smoke gate proves a user-visible change.
- Delegation caps are defined in [`../../AGENTS.md`](../../AGENTS.md) and surfaced again by `dr-specialist-routing`.
- `dr-helper-runtime-control` enforces those caps at runtime for `task` launches, so parallel fanout is now guarded instead of being prompt-only.
- `dr-helper-runtime-control` also blocks relaunching an unstable helper when session-local policy says to prefer a fallback helper or retry later after provider/model instability.
- `dr-agent-babysitter` is session-local by design. It helps the main line stop reusing a helper that has already failed repeatedly in the same session, and it exposes recent helper activity so wedged or noisy helpers are visible without digging through session storage.
