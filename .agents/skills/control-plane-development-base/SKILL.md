---
name: control-plane-development-base
description: Shared development doctrine for aicoder-opencode and its target repos — plugin ownership, overlay split, shared base vs product boundaries
user-invocable: false
---

# control-plane-development-base

Shared development base for product repos that consume the `aicoder-opencode`
control plane.

Use this skill when work is about:
- shared plugin baselines that product repos should install locally
- shared prompts, doctrine, or overlays that apply to more than one repo
- base development workflow that should stay consistent across target repos
- deciding what belongs in `aicoder-opencode` versus a product repo

## Responsibilities

- Keep shared development doctrine in `aicoder-opencode`.
- Install thin repo-local shims into product repos instead of copying source.
- Separate shared base behavior from repo-specific overlays.
- Keep product-specific implementation, plans, and release evidence in the
  target repo.
- Move in small verified slices so one control-plane change does not destabilize
  multiple target repos at once.

## Contract

- `aicoder-opencode` owns the shared plugin and shared skill sources.
- Product repos consume shared development base through local shims.
- Shared changes must be neutral enough to serve more than one target repo.
- Product-specific doctrine must remain local to the product repo.

## Shared Base

- Shared plugin source belongs in `src/plugins/`.
- Shared skill source belongs in `.agents/skills/`.
- Repo-local install shims belong in each product repo under `.opencode/plugins/`
  and `.agents/skills/`.

## Target Repos

- `dr-repo`
- `letta-workspace`

## Avoid

- Copy-pasting plugin code into product repos
- Moving product implementation doctrine into `aicoder-opencode`
- Treating the control plane as a product monorepo
- Broad rewrites when one iterative change can prove the path first
