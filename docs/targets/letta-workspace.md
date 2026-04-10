# letta-workspace target instructions

## Role

`letta-workspace` is a monorepo target.

The control plane must preserve shared context across subprojects instead of
pretending each directory is a standalone product.

## Child projects

- `letta`
- `letta-code`
- `letta-fleet`
- `letta-selfhost`
- `lettactl`

## What belongs here

- monorepo-aware planning
- fleet/runtime alignment work
- shared developer tooling and release coordination across child projects

## What does not belong here

- flattening monorepo decisions into per-project local doctrine
- copying subprojects into the control-plane repo
- treating `letta-fleet` as optional context

## Control-plane expectations

- keep monorepo context visible during planning
- support child-project targeting without losing workspace-wide coupling
- store target-specific doctrine here, not in generic control-plane prose
- allow maintenance work that spans `letta`, `letta-code`, and `letta-fleet`

## Maintenance boundary

`letta-workspace` should remain monorepo-aware even when launched through a
generic control plane.
