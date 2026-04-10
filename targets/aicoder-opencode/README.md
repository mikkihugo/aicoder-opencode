# aicoder-opencode target overlay

This directory is the control-plane source of truth for `aicoder-opencode`
workflow skills.

The target root IS this repository, so overlay files are directly referenced
from `opencode.jsonc` — no symlink or shim layer is needed.

Current layout:

- `overlay/.agents/skills/aicoder-unblock-and-patch/` — self-health check,
  doom-loop recovery for targets, shared skill/plugin patching, fix propagation
  across overlays.
- `overlay/.agents/skills/aicoder-harvest-and-promote/` — synthesizing learnings
  from target sessions into shared base skills, promoting proven overlay patterns
  to the shared base.

Both skills are loaded via the `instructions` array in `opencode.jsonc` at the
repo root.
