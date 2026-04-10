# Target Model

## Target kinds

### `repo`

A single standalone repository.

Example:

- `dr-repo`

### `monorepo`

A repository with explicit child projects.

Example:

- `letta-workspace`

## Required target fields

- `name`
- `kind`
- `root`
- `default_branch`
- `maintenance_owner`

## Optional target fields

- `product_launcher`
- `maintenance_launcher`
- `hidden_paths`
- `subprojects`
- `notes`

## Initial policy

- `dr-repo` should eventually stop hosting its own maintenance layer.
- `letta-workspace` should stay monorepo-aware because its subprojects share doctrine and runtime boundaries.
