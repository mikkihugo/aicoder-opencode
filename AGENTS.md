# AI Agent Instructions for aicoder-opencode

This repository is the maintenance control plane.

## Purpose

Manage AI coding infrastructure across multiple target repositories without mixing product code into the maintenance host.

## Target Model

Targets are external repositories or monorepos.

Current target types:

- `repo`
- `monorepo`

Current seeded targets:

- `dr-repo`
- `letta-workspace`

## Rules

- Do not copy product trees into this repository.
- Shared development and maintenance bases live here.
- Shared maintenance logic lives here.
- Move slowly and iteratively.
- Prefer the smallest working control-plane change that improves one real target
  repo path.
- Product decisions stay in the target repository's own plans, tests, and docs.
- Cross-repo lessons may live here only when they are maintenance/runtime lessons rather than product behavior.

## Initial direction

- `dr-repo` is a standalone repo target.
- `letta-workspace` is a monorepo target with child projects.
- Maintenance ownership should migrate here over time.

---

## Control Plane State Model

The `aicoder-opencode` control plane does not use the same DR-style checkpoint/active-slice state as its product targets.

Instead, the control plane's state is derived from:

| Source | How to access | When to use |
|--------|--------------|-------------|
| Checkpoints (`.opencode/state/checkpoints/*.json`) | `dr-session-pickup` skill reads automatically | Resume aborted sessions |
| `<dr_state>` block | Injected into every OpenCode session | Current execution context |
| `list_active_plans` tool | Via `dr-plan-context` plugin | Machine-readable plan state |
| Active-slice.md files | One per plan under `docs/plans/YYYY-MM-DD-*/` | Human-readable slice state (for target repos) |
| `STATUS.md` | **Not used by control plane** | Only in target repo overlays (e.g., dr-repo) |

**Canonical precedence when they disagree:**
1. Checkpoint state (auto-maintained, session-bound)
2. Active-slice.md in the correct target repo's `docs/plans/`
3. `<dr_state>` block (derived from checkpoint + plan)
4. `STATUS.md` — not used by control plane, only target overlays

**Control plane does not maintain `STATUS.md`** — unlike product repos, it has no `STATUS.md` file. The `dr-session-pickup` and `dr-design-and-planning` skills reference STATUS.md as a *possible* state artifact, but the control plane's purpose is to *supervise* targets, not *author* product plans.

**Maintainable state only lives here when it is shared across targets or affects operation of the OpenCode server itself** — e.g., `config/models.jsonc`, `config/targets/`, `src/plugins/`, shared skills in `.agents/skills/`.

**When in doubt about the next step, use the decision matrix:** 
- Target repo work? → Checkpoints + active-slice.md in target repo
- Shared infrastructure work? → OpenCode plugins, shared skills, config
- Product plans or specs? → Not here — keep in target repos
