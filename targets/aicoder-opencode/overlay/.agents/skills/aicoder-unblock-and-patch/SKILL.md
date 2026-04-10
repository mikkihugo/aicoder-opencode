---
name: aicoder-unblock-and-patch
description: Self-health check, doom-loop recovery, and patch propagation workflow for the aicoder-opencode control plane
user-invocable: false
---

# aicoder-unblock-and-patch

Maintenance and unblock workflow for the `aicoder-opencode` control plane.

## When to use

- The control plane itself is broken: failing tests, build errors, import failures.
- A target repo is stuck in a doom-loop and has not recovered on its own.
- A shared skill or plugin needs patching and the fix must propagate across targets.

## Self-health check procedure

1. Run `bun run check` (build + tests). Fix any failures before proceeding.
2. Run `make validate-dr-repo` and `make validate-letta-workspace`. Confirm
   target paths exist and launchers resolve.
3. Run `make doom-loop-dr-repo`. If stalled, proceed to the target unblock
   procedure below.

## Target unblock procedure

When a doom-loop fires on a target:

1. Read the target's `docs/plans/` active-slice to understand what was in flight.
2. Read checkpoint files under `.opencode/state/checkpoints/` to see last known
   state.
3. Determine whether work was actually complete (false positive) or genuinely
   stuck.
4. If stuck: identify the blocker, apply a minimal patch, clear the stale state.
5. If false positive: update the active-slice to reflect completion, then reset
   the loop guard state under `.state/doom-loop/`.

## Patch propagation procedure

When a shared skill or plugin needs updating:

1. Make the change in the control plane source (`src/plugins/` or
   `.agents/skills/`).
2. Run `bun run check` to verify.
3. For skills that are overlaid into product repos: update
   `targets/<target>/overlay/.agents/skills/` shim or content.
4. Verify the target can still launch: `make validate-<target>`.
5. Commit in one atomic change so the skill version and overlay stay in sync.

## Avoid

- Patching multiple targets in one commit before the first has been verified.
- Silently swallowing errors during any step of the procedure.
- Changing shared skills to serve one target's quirk without confirming the
  change is safe for all other targets.
