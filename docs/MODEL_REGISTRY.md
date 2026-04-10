# Model Registry

Canonical routing registry for the control plane.

## Purpose

Keep one source of truth for:

- capability tier
- cost tier
- billing mode
- concurrency
- ordered provider preference
- default role mapping

## File

- [config/models.jsonc](/home/mhugo/code/aicoder-opencode/config/models.jsonc)

## Interfaces

- CLI: `npx tsx src/cli.ts list-models`, `npx tsx src/cli.ts select-models <role>`
- OpenCode plugin tools: `list_curated_models`, `select_models_for_role`

## Rules

- `provider_order` is authoritative. `priority: 1` is the preferred route.
- `capability_tier` and `cost_tier` are separate axes.
- `billing_mode` distinguishes true free lanes from subscription-backed lanes.
- `concurrency` is per exact model family, not per provider.
- `quota_visibility` records whether the control plane can observe the limit directly or whether it is manual operator knowledge.
- Add notes when routing differs from naïve “best model wins” logic.

## Controlled Fields

- `cost_tier` must be one of: `free`, `cheap`, `medium`, `expensive`
- `billing_mode` must be one of: `free`, `subscription`, `quota`, `paid_api`
- Treat both as local routing policy dropdowns, not provider-derived truth

## Tier hints

- `fast` means helper/triage speed matters more than depth.
- `strong` means default high-quality coding/review lane.
- `frontier` means reserve for architecture, long-context, or irreversible calls.
