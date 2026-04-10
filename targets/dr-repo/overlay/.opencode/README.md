# OpenCode Runtime Notes

This directory is runtime support for OpenCode in this repo.

Canonical sources of truth:
- Repo workflow: [`../.agents/skills/`](../.agents/skills)
- General change method: [`../TDD_SPEC_FIRST.md`](../TDD_SPEC_FIRST.md)
- Debate roles and specialist selection: [`../docs/AGENT_ROLES.md`](../docs/AGENT_ROLES.md)
- OpenCode runtime policy: [`../docs/OPENCODE_AGENT_POLICY.md`](../docs/OPENCODE_AGENT_POLICY.md)
- OpenCode/runtime infra issue tracking: [`./INFRASTRUCTURE_ISSUES.md`](./INFRASTRUCTURE_ISSUES.md)

What belongs here:
- project-local OpenCode agents in [`agents/`](./agents)
- local OpenCode plugins in [`plugins/`](./plugins)
- local runtime state in [`state/`](./state)
- OpenCode dependency root in [`package.json`](./package.json)
- tracked runtime and operator-support issues in [`INFRASTRUCTURE_ISSUES.md`](./INFRASTRUCTURE_ISSUES.md)

What does not belong here:
- a second copy of the repo method
- a second copy of role definitions
- drifting notes or parallel planning documents
- product backlog or broad feature planning

Use this directory for runtime mechanics.
Use `.agents` and `docs/` for the method.
