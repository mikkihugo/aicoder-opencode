---
description: Show the current dr-autopilot timer and resume-target state.
agent: roadmap_keeper
subtask: false
---

Show the current dr-autopilot state for this repo.

Use `bash` to run `dr-autopilot status`.
Return only:
- timer enabled/active state
- current target session, if any
- last run result
- whether the watchdog needs intervention
