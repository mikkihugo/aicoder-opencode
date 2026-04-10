---
description: Summarize the current DR repo execution state across plans, checkpoints, and autopilot.
agent: roadmap_keeper
subtask: false
---

Summarize the current DR repo execution state.

Use `list_active_plans` to inspect open plans.
Use `list_stale_checkpoints` to inspect stale work.
Use `bash` to run `dr-autopilot status`.

Return only:
- open plan count and the most important open plans
- stale checkpoint count and the most important stale sessions
- autopilot timer state and whether a resume target exists
- the single highest-value next intervention
