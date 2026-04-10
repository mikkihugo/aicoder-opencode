# aicoder-opencode

Control-plane repository for multi-repo AI coding operations.

This repository does not contain product code. It manages target repositories.

Initial targets:

- `dr-repo`
- `letta-workspace`

## Responsibilities

- shared maintenance policy
- shared development doctrine
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
targets/
  dr-repo/
    README.md
    overlay/
      .agents/
      .opencode/
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

## Nix

This repo includes a flake-based dev shell for the control-plane toolchain.

```bash
nix develop
npm ci
npm run check
```

If you use `direnv`, the repo also includes `.envrc`:

```bash
direnv allow
```

The shell provides:

- `bun`
- `node`, `npm`, `typescript`, `typescript-language-server`
- `git`, `rg`, `jq`, `yq`, `just`, `bubblewrap`, `jj`
- `nixfmt`, `alejandra`, `deadnix`, `statix`

The flake is for toolchain provisioning. Project JavaScript dependencies still
come from `package-lock.json` via `npm ci`.

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
bun run src/cli.ts list-models
bun run src/cli.ts list-models --enabled
bun run src/cli.ts list-models --free --provider mistral
bun run src/cli.ts select-models architect
bun run src/cli.ts manage-models
```

`manage-models` supports direct edits for:

- `enabled`
- `description`
- `cost_tier`
- `billing_mode`
- `concurrency`
- `default_roles`

OpenCode auto-loads the install shim at `.opencode/plugins/model-registry.ts`.
The actual plugin source lives at `src/plugins/model-registry.ts`.

That plugin exposes:

- `list_curated_models`
- `select_models_for_role`

## Shared skills

`aicoder-opencode` owns the shared base skills consumed by target repos:

- `control-plane-development-base`
- `control-plane-maintenance-base`

Target repos should install thin local shims that point back to these shared
skill sources, then layer repo-specific skills locally.

## Target overlays

`aicoder-opencode` also owns target-specific maintenance overlays when the
runtime behavior is part of the softtools rather than the product.

For `dr-repo`, the source-of-truth runtime now lives under:

- `targets/dr-repo/overlay/.opencode/`
- `targets/dr-repo/overlay/.agents/`

`dr-repo` keeps only local runtime state, caches, and thin symlinked entrypoints
needed for OpenCode to load from repo-local paths.

## dr-memory plugin

The `dr-repo` overlay includes a `dr-memory` plugin that stores and recalls
cross-session learnings (architectural decisions, feature outcomes, failure
patterns, etc.).

Search backend: **[qmd](https://www.npmjs.com/package/@tobilu/qmd)** (`@tobilu/qmd`)
— a local hybrid search engine combining BM25 full-text and vector semantic
search via Reciprocal Rank Fusion. Runs entirely locally.

Three search modes exposed via the plugin:

| mode | what it does |
|---|---|
| `query` | BM25 full-text only |
| `search` | hybrid BM25 + vector (default for recall) |
| `vsearch` | pure vector semantic search |

`qmd` is resolved at runtime: uses the `qmd` binary if installed globally,
otherwise falls back to `npx --yes @tobilu/qmd`. No explicit install step
required.

## OpenCode SQLite maintenance

`aicoder-opencode` owns the local OpenCode SQLite maintenance flow.

- hourly: checkpoint + optimize
- daily: online backup + retention prune
- manual only: `VACUUM`

Commands:

```bash
make opencode-db-maintenance-start
make opencode-db-maintenance-status
make opencode-db-checkpoint-now
make opencode-db-backup-now
make opencode-db-vacuum
```

Live paths:

- database: `/home/mhugo/.local/share/opencode/opencode.db`
- backups: `/home/mhugo/.local/state/opencode/backups`

The automated path stays online-safe. `VACUUM` is intentionally not on a timer.
