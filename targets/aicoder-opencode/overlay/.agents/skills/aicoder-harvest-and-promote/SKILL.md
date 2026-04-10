---
name: aicoder-harvest-and-promote
description: Harvest learnings from target sessions and promote proven overlay patterns to the shared control-plane base
user-invocable: false
---

# aicoder-harvest-and-promote

Improvement and harvest workflow for the `aicoder-opencode` control plane.

## When to use

- After a successful target session.
- Periodically (weekly) to keep shared skills current with what is working.
- When a pattern in a target overlay has proven reliable across multiple sessions.

## Harvest procedure

After a target session:

1. Review what the session produced: did any skill or agent pattern work
   unexpectedly well or fail?
2. Check `targets/<target>/overlay/.agents/skills/` for any local skills that
   were added or modified during the session.
3. For each candidate: determine whether it is target-specific or cross-repo
   general.

## Promotion criteria

Promote a local overlay skill to the shared base when:

- It has worked correctly in at least 2 independent sessions.
- It makes no assumptions about the target repo's product code.
- It would serve at least one other target unchanged or with minimal
  parameterization.

## Promotion procedure

1. Move the skill source to `.agents/skills/<skill-name>/SKILL.md`.
2. Add it to `.agents/skills/.manifest.json` if one exists.
3. Update the `instructions` array in `opencode.jsonc`.
4. Remove or thin the local overlay copy to a shim or pointer.
5. Run `bun run check` to confirm nothing broke.

## Model registry improvement

After sessions that used specific models:

- Note which provider routes were actually called vs. skipped.
- If a model's top provider route consistently failed: update `config/models.jsonc`
  to reorder or disable it.
- Run `make manage-models` to interactively adjust, then `make validate-dr-repo`
  to confirm the change does not break the target path.

## Plugin improvement signals

- A plugin tool was called in every session: probably good, keep it.
- A plugin tool was never called: consider whether it should stay in the hot set.
- A plugin returned wrong data: fix the source in `src/plugins/`, propagate shim
  updates to any affected target overlays.

## Avoid

- Promoting skills that encode product-specific assumptions.
- Demoting stable skills based on one bad session.
- Changing the model registry without running a test probe first.
