# dr-repo target instructions

## Role

`dr-repo` is a standalone product repository.

The control plane must treat it as product code first and maintenance runtime
second.

## What belongs here

- portal, agent, gateway, installer, migrations
- product tests
- product plans under `docs/plans/`
- product release and staging work

## What does not belong here

- shared maintenance prompts
- cross-repo orchestration policy
- fleet-wide runtime experiments
- copied control-plane logic

## Control-plane expectations

- launch product work with maintenance paths hidden
- keep target-local product decisions in `dr-repo`
- push maintenance/runtime lessons back to the control plane only when they are
  cross-repo lessons
- preserve `docs/plans/*` as the continuity surface for autonomous work

## Maintenance boundary

`dr-repo` should stop hosting its own maintenance runtime over time.

The control plane should migrate:

- `.opencode/`
- `.agents/`
- `.maintenance/`

out of `dr-repo` and keep only the product-facing launch surface in the target.
