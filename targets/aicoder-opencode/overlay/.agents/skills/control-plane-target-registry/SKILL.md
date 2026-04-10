---
name: control-plane-target-registry
version: 2026-04-10.1
description: "Use when adding or modifying targets in config/targets/ or their overlays in targets/. Do not use for model registry or plugin changes."
user-invocable: true
---

# control-plane-target-registry

## When to Use

- Adding a new repo target (`config/targets/<name>.yaml`)
- Modifying a target's launcher config, root path, or instruction path
- Creating or updating overlay skills in `targets/<name>/overlay/.agents/skills/`
- Adding autopilot helpers to `targets/<name>/overlay/.opencode/`
- Changing doom-loop guard settings or maintenance launcher mode

## Contract

- `config/targets/` owns target declarations — one file per target.
- `targets/<name>/overlay/` owns the skills and helpers deployed into that repo.
- Overlay skills are the source of truth — do not edit them inside the product repo.
- Target `root` paths must exist on the local machine before the target is valid.
- Run `bin/aicoder-opencode validate-target <name>` after any target config change.

## Workflow

1. Read `config/targets/<name>.yaml` and `docs/targets/<name>.md` for context.
2. Make the targeted change — one target, one concern at a time.
3. Run `bin/aicoder-opencode validate-target <name>` — confirm validation passes.
4. Run `bin/aicoder-opencode show-target <name>` — confirm fields render correctly.
5. If adding a new target: also create `docs/targets/<name>.md` with overview, notes, skill chain.
6. Commit overlay and config together so they stay in sync.

## Key Files

| File | Role |
|---|---|
| `config/targets/<name>.yaml` | Target declaration |
| `targets/<name>/overlay/` | Skills and helpers deployed into the product repo |
| `docs/targets/<name>.md` | Human-readable target overview |
| `src/cli.ts` | Target loading, validation, launcher logic |

## Adding a New Target — Checklist

- [ ] `config/targets/<name>.yaml` created with `name`, `kind`, `root`, `default_branch`, `maintenance_owner`
- [ ] `docs/targets/<name>.md` created
- [ ] `targets/<name>/overlay/.agents/skills/` created with at least one skill
- [ ] `bin/aicoder-opencode validate-target <name>` passes
- [ ] `bin/aicoder-opencode list-targets` shows the new target

## Avoid

- Editing overlay skills inside the product repo (changes will be overwritten)
- Adding a target whose `root` path does not exist locally
- Duplicating skills that belong in `.agents/skills/` shared base
