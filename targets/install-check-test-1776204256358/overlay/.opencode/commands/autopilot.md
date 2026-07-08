---
description: Enter shared maintenance mode and keep going until the target task is done or truly blocked.
agent: implementation_lead
subtask: false
---

Enter shared maintenance mode on the control-plane server.

Interpret the attached message as the target-repo maintenance request.

Workflow:
- Identify the named target repo from the request.
- Read the target repo's `AGENTS.md` before acting.
- If the target is `dr-repo`, also consult `/home/mhugo/code/aicoder-opencode/targets/dr-repo/README.md`.
- If the target is `letta-workspace`, also consult `/home/mhugo/code/aicoder-opencode/docs/targets/letta-workspace.md`.
- Use the shared maintenance and development skills loaded in `aicoder-opencode`.
- Prefer control-plane fixes when the break is shared.
- Prefer target-repo fixes only when the issue is truly product-local.
- Keep going until the maintenance task is done or truly blocked.

Do not create a separate maintenance lane.
