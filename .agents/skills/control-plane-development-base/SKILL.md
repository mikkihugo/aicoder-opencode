---
name: control-plane-development-base
description: Shared development doctrine for aicoder-opencode and its target repos — plugin ownership, overlay split, shared base vs product boundaries
user-invocable: false
models:
  - ollama-cloud/glm-5.1
  - ollama-cloud/kimi-k2-thinking
  - ollama-cloud/minimax-m2.7
routing_role: architect
routing_complexity: medium
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

## Executing actions with care

Match caution to reversibility and blast radius. Approval granted once is scoped to that one action, not a standing license.

Free to do without asking:
- Local file edits in this repo or a target overlay
- Running tests, linters, type checks
- Reading git state, diffing, inspecting branches
- Creating local commits on a non-shared branch

Confirm first (state the exact command, wait for a yes):
- `git push`, especially to shared branches
- Force-push, `git reset --hard`, amending published commits
- Branch deletion, deleting files whose purpose you have not verified
- Destructive SQL (DROP, TRUNCATE, unbounded DELETE/UPDATE), schema migrations
- Mutating config of shared services (control-plane plugins consumed by multiple target repos, CI/CD, shared infra)
- Removing or downgrading dependencies
- Anything visible to others: PR comments, issue state, Slack, external uploads

On obstacles, find the root cause. Do not use destructive shortcuts (`--no-verify`, wiping state, deleting lock files) to make an error disappear. Unfamiliar files or branches may be in-progress work — investigate before overwriting. Resolve merge conflicts, do not discard them.

## Memory staleness

Memory records capture what was true at one point. Before acting on a remembered fact about code — file paths, function names, exported symbols, flag names, config keys, line ranges — verify it against current state by reading the file. On conflict, trust what you observe now: update or delete the stale memory and, if still useful, save a fresh record. Never let a remembered fact override a current read.
