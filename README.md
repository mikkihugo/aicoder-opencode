# aicoder-opencode

Control-plane repository for multi-repo AI coding operations.

This repository does not contain product code. It manages target repositories.

Initial targets:

- `dr-repo`
- `letta-workspace`

## Responsibilities

- shared maintenance policy
- target registry
- launcher and sandbox policy
- per-target runtime metadata
- cross-repo maintenance learning

## Non-goals

- copying product repositories into this repo
- replacing product-local plans or tests
- storing product implementation history here

## Layout

```text
config/
  control-plane.yaml
  models.jsonc
  targets/
    dr-repo.yaml
    letta-workspace.yaml
docs/
  ARCHITECTURE.md
  MODEL_REGISTRY.md
  TARGET_MODEL.md
  targets/
    dr-repo.md
    letta-workspace.md
bin/
  aicoder-opencode
```

## First rule

`aicoder-opencode` is the maintenance host. Product repositories remain external targets.

## Basic commands

```bash
make targets
make show-dr-repo
make show-dr-repo-instructions
make validate-dr-repo
make print-dr-repo-launch
make debug-dr-repo-sandbox
make doom-loop-dr-repo
make openportal-start
make openportal-status
make openportal-list
```

`make debug-dr-repo-sandbox` should show empty overlays for `.opencode`,
`.agents`, and `.maintenance`.

## Control-plane portal

- URL: `http://127.0.0.1:3091/`
- OpenCode server port: `4091`
- Host process: `openportal`
- Instance list: `make openportal-list`

## Model routing

- canonical registry: [config/models.jsonc](/home/mhugo/code/aicoder-opencode/config/models.jsonc)
- routing notes: [docs/MODEL_REGISTRY.md](/home/mhugo/code/aicoder-opencode/docs/MODEL_REGISTRY.md)

## Model selector

Use the control-plane CLI for curated routing queries:

```bash
npx tsx src/cli.ts list-models
npx tsx src/cli.ts list-models --enabled
npx tsx src/cli.ts list-models --free --provider mistral
npx tsx src/cli.ts select-models architect
npx tsx src/cli.ts manage-models
```

`manage-models` supports direct edits for:

- `enabled`
- `description`
- `cost_tier`
- `billing_mode`
- `concurrency`
- `default_roles`

OpenCode also auto-loads the local plugin at `.opencode/plugins/model-registry.ts` and exposes:

- `list_curated_models`
- `select_models_for_role`
