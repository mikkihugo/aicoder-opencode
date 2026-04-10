---
description: Show stale DR checkpoints that still need work.
agent: roadmap_keeper
subtask: false
---

Show stale checkpoints for this repo.

Use `list_stale_checkpoints`.
Default to the current stale threshold unless the user asked for another one.

Return a compact list with:
- session id
- plan
- current slice
- next step
- missing verification
- why it is stale
