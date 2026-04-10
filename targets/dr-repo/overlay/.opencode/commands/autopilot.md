---
description: Enter DR autonomous iteration mode and keep going until the task is done or truly blocked.
agent: implementation_lead
subtask: false
---

Enter DR autonomous iteration mode for this repo.

Use `bash` to run `./.opencode/bin/dr-autopilot start` first so the external watchdog is enabled,
not just the current session.
Load `dr-autonomous-iteration`.
Resume the current repo checkpoint and active slice if they exist.
If they do not exist yet, treat that as an internal planning gap:
- use the repo purpose and current request to infer the most likely user goal
- consult `planning_analyst` and `consumer_advocate` before considering any user interruption
- if confidence is still not high, gather more evidence from repo artifacts, orthogonal specialists, and research unstable external facts plus adjacent problem-space context before choosing a default
- keep iterating research and specialist passes while confidence is still rising between passes
- if confidence keeps stalling, treat that as a signal that the slice is too broad or a foundation task is missing; shrink the slice or create the missing foundation task before continuing
- create or refresh the right plan artifacts before coding
- do not use multi-choice or paged user-question tools in this repo
- if the remaining ambiguity is reversible, choose the safest evidence-backed default, record the assumption, and continue
- if the current path is still not solvable after the hard evidence and research pass, park the blocked plan or slice explicitly, ask `roadmap_keeper` for the next highest-value slice, and continue there
- ask one concise plain-text question only if the next decision is destructive, irreversible, or materially preference-shaped and still unsafe after those internal passes

Keep going until the task is actually done or truly blocked.
Do not stop at a single green slice.
Record continuity in the active slice and checkpoint as you go.
