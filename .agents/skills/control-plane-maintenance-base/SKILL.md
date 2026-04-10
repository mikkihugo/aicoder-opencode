---
name: control-plane-maintenance-base
description: Shared maintenance topology and policy for aicoder-opencode — one server per repo, shared plugins, overlay-first changes
user-invocable: false
---

# control-plane-maintenance-base

Shared maintenance/control-plane base for repos that attach to the `aicoder-opencode`
server.

Use this skill when work is about:
- shared maintenance workflows
- shared OpenCode control-plane behavior
- cross-repo maintenance plugin baselines
- per-repo server topology that should stay consistent across product repos

## Responsibilities

- Keep one OpenCode server per repo.
- Keep shared maintenance logic in `aicoder-opencode`.
- Push repo-specific overlays back into the product repo only when they are truly product-specific.
- Prefer thin install shims in product repos over copied plugin implementations.
- Change maintenance topology in small reversible steps and verify one target
  repo path before rolling the same pattern wider.

## Contract

- `aicoder-opencode` owns shared maintenance plugins and skills.
- Product repos may install shared base shims, then add local overlays.
- Control-plane changes should not silently fork per repo.

## Topology

- `aicoder-opencode` on `8080`
- `dr-repo` on `8082`
- `letta-workspace` on `8084`
- OpenChamber attaches to one repo server at a time

## Shared Base

- Shared plugin source belongs in `src/plugins/`
- Shared skill source belongs in `.agents/skills/`
- Product repos consume shared base via repo-local shims

## Avoid

- Copy-pasting shared plugin logic into product repos
- Moving product doctrine into `aicoder-opencode`
- Adding extra OpenCode servers when one per repo is enough
- Large topology rewrites without verifying the next real maintenance path
