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
- Shared `.opencode` maintenance launchers, agent contracts, and target overlays are canonical here first.
- Move slowly and iteratively.
- Prefer the smallest working control-plane change that improves one real target
  repo path.
- Product decisions stay in the target repository's own plans, tests, and docs.
- Cross-repo lessons may live here only when they are maintenance/runtime lessons rather than product behavior.

## Canonical Ownership

For shared maintenance/runtime files, the source of truth is this repository:

- `.opencode/agents/`
- `.opencode/bin/`
- `targets/dr-repo/overlay/.opencode/`
- `targets/letta-workspace/overlay/.opencode/`

Working rule:

- edit shared maintenance logic here first
- mirror outward to target runtime copies only after the control-plane change is correct
- do not treat target repo copies of shared maintenance files as the canonical edit location

## Operating Model

This repository is the current OpenCode-based maintenance control plane, not the final product.

- `aicoder-opencode` owns shared `.opencode` launchers, agent contracts, target overlays, and model-routing law.
- OpenCode remains the temporary execution substrate under that control plane.
- `letta-workspace` owns the target platform, the Singularity Matrix operator surface, and the backend contract that should eventually replace the OpenCode-specific control-plane glue.
- `dr-repo` is a product target and canary workload, not the place to invent shared control-plane policy.

Current transition rule:

- keep `aicoder-opencode` as the canonical shared control-plane source while Letta is still missing contract truth
- keep the `aicoder-opencode` main service available as sidecar infrastructure, but keep its autonomous maintenance timer paused unless the control plane itself is the blocker
- run active autonomous work from `letta-workspace`
- keep `dr-repo` paused as a canary workload unless a human explicitly resumes it
- build takeover features in `letta-workspace`, not here, whenever the work is about operator truth, progress tracking, run/session truth, or Matrix behavior
- retire OpenCode-specific control-plane behavior only after Letta can satisfy the same contract directly
- keep live-root reuse conservative: do not rotate a root to stale while it still has fresh child work or accepted artifacts; salvage before archive

## Initial direction

- `dr-repo` is a standalone repo target.
- `letta-workspace` is a monorepo target with child projects.
- Maintenance ownership should migrate here over time.

---

## Runtime Map

Current operator/runtime ports and ownership:

- `8080` — `aicoder-opencode` OpenCode control-plane lane
- `8082` — `dr-repo` OpenCode lane
- `8084` — `letta-workspace` OpenCode lane
- `3012` — Singularity Matrix backend adapter
- `3013` — Singularity Matrix UI, owned by `letta-workspace` rather than this repo

The only operator surface in use is Singularity Matrix.

Service ownership rule:

- if the question is about shared OpenCode lanes, routing, launchers, or overlays, answer from this repo
- if the question is about Matrix UI/backend behavior, answer from `letta-workspace`
- if the question is about product behavior, answer from the target repo

Current lane state:

- `letta-workspace` is the only active autonomous workstream
- `aicoder-opencode` is paused as an autonomous lane and stays up only as shared sidecar infrastructure
- `dr-repo` is paused as a canary lane

## Letta Takeover Intake

Translate a shared control-plane gap into `letta-workspace` backlog only when the missing capability belongs in the product operator surface:

- run/job state and terminal outcomes
- branch/result validation
- progress and artifact truth
- root/session reuse and salvage policy
- Matrix visibility and operator decisions

Keep these in `aicoder-opencode` instead:

- OpenCode-era launcher mechanics
- target overlay mirroring
- shared agent prompt law
- model routing and provider-health glue

## Verification And Status Questions

Do not suggest DR-repo quality gates here by default. In particular, do not answer status or explanation questions with `ruff`, `pyright`, or other DR/Python verification unless the change actually touches a Python subtool in this repo.

Default verification for this repo:

- TypeScript/control-plane changes: `npm run build`, `npm run test`, or `npm run check` from the repo root
- Matrix UI changes under `apps/opencode-triad-ui/`: use that app's frontend build/test commands, not repo-root Python checks
- Launcher or shell-script changes: `bash -n` on the touched scripts
- Runtime/status questions: inspect docs, config, systemd units, ports, and live HTTP endpoints first

Status-question rule:

- when the user asks for current state, explain the current runtime map and live services
- do not propose code-quality commands unless the user asked for validation of a code change

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
