---
name: control-plane-model-registry
version: 2026-04-10.1
description: "Use when changing config/models.jsonc — tier policy, role assignments, provider routing, cost/quota visibility. Do not use for target registry or overlay changes."
user-invocable: true
---

# control-plane-model-registry

## When to Use

- Adding or removing a model from `config/models.jsonc`
- Changing a model's `capability_tier`, `cost_tier`, `billing_mode`, or `default_roles`
- Adjusting `provider_order` priorities or marking routes `disfavored`
- Updating `quota_visibility`, `concurrency`, or `latency_tier`
- Rotating which model serves a role (architect, partner, combatant, oracle)

## Contract

- `config/models.jsonc` is the single source of truth for model metadata.
- `src/model-registry.ts` owns the schema — never add fields to the jsonc that the schema does not validate.
- `src/cli/model-commands.ts` renders the registry — update render logic when fields are added.
- Tests live in `src/model-registry.test.ts` — run them before committing.

## Workflow

1. Read `config/models.jsonc` and `src/model-registry.ts` (schema + validators).
2. Make the targeted change — one model or one policy rule at a time.
3. Run `npm test` — confirm model registry tests pass.
4. Run `bin/aicoder-opencode list-models` — confirm the change appears correctly.
5. Commit with a message that names the model and the changed field.

## Key Files

| File | Role |
|---|---|
| `config/models.jsonc` | Canonical model registry — edit here |
| `src/model-registry.ts` | Schema, validators, loaders |
| `src/cli/model-commands.ts` | Render + interactive editor |
| `src/model-registry.test.ts` | Registry unit tests |

## Avoid

- Editing `config/models.jsonc` without running tests
- Adding a model without specifying `default_roles`
- Setting `quota_visibility: hidden` for models used as defaults
- Changing provider priority without verifying the route exists in `opencode models`
