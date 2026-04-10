# aicoder-opencode target instructions

## Role

`aicoder-opencode` is the shared AI coding control plane.

It supervises itself as a target alongside the product repos it manages. Changes
here propagate to every downstream target, so correctness and reversibility
matter more than speed.

## What belongs here

- shared plugins (`src/plugins/`, `.opencode/plugins/`)
- shared skills (`.agents/skills/`)
- model registry (`src/model-registry.ts`, `config/models.jsonc`)
- target configs (`config/targets/`)
- maintenance policy and launcher contracts
- target overlay assets (`targets/<target>/overlay/`)
- this repo's own source, tests, and build config

## What does not belong here

- product code, product plans, or product tests from target repos
- target-specific doctrine that applies only to one product repo
- copied product logic imported from a target repo into the control plane

## Two core workflows

### aicoder-unblock-and-patch

Self-health check, doom-loop recovery for targets, shared skill and plugin
patching, and fix propagation across overlays.

Use when the control plane itself is broken, when a target repo is stuck, or
when a shared skill or plugin needs updating across targets.

Skill: `targets/aicoder-opencode/overlay/.agents/skills/aicoder-unblock-and-patch/SKILL.md`

### aicoder-harvest-and-promote

Synthesize learnings from target sessions into shared base skills and promote
proven overlay patterns to the shared base.

Use after a successful target session or periodically (weekly) to keep shared
skills current with what is actually working.

Skill: `targets/aicoder-opencode/overlay/.agents/skills/aicoder-harvest-and-promote/SKILL.md`

## Control-plane expectations

- Run `bun run check` (build + tests) before patching any shared asset.
- Change shared skills in small reversible steps.
- Verify one target path before rolling the same change wider.
- Keep `aicoder-unblock-and-patch` and `aicoder-harvest-and-promote` current as
  doctrine evolves — they are the living spec for how the control plane
  maintains itself.

## Maintenance boundary

Unlike product repos, `aicoder-opencode` has no `hidden_paths` split. The full
repository is the maintenance surface. There is no product lane and no
doom-loop guard because the control plane does not use checkpoint/active-slice
state.
