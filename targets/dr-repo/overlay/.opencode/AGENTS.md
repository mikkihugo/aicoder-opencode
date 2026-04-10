# .opencode/ — Repo-Local OpenCode Runtime

This directory is the repo-local OpenCode runtime layer for `dr-repo`.

Use this file as the quick map of the runtime surface.
Do not put repo workflow doctrine here. Workflow remains in:
- [`../AGENTS.md`](../AGENTS.md)
- [`../.agents/skills/`](../.agents/skills/)
- [`../docs/OPENCODE_AGENT_POLICY.md`](../docs/OPENCODE_AGENT_POLICY.md)

## Overview

Repo-local OpenCode runs through:
- [`.opencode/bin/opencode`](./bin/opencode) for repo isolation and repo-local XDG config
- [`.opencode/xdg-config/opencode/opencode.json`](./xdg-config/opencode/opencode.json) for repo-local MCPs and runtime config
- [`.opencode/opencode.jsonc`](./opencode.jsonc) for repo-local plugin registration

This layer owns:
- helper-agent prompts
- runtime plugins
- autopilot/watchdog mechanics
- repo-local runtime state

This layer does not own:
- product workflow
- spec-first method
- role doctrine
- product backlog or plans

## Key Areas

| Path | Purpose |
|------|---------|
| [`agents/`](./agents) | Repo-local OpenCode helper agents and their prompts |
| [`plugins/`](./plugins) | Repo-local runtime plugins |
| [`commands/`](./commands) | Repo-local slash commands |
| [`autopilot/`](./autopilot) | Watchdog CLI and helper logic |
| [`bin/`](./bin) | Repo-local OpenCode wrapper and shell entrypoints |
| [`state/`](./state) | Checkpoints, ledgers, memory, helper health, and autopilot status |
| [`xdg-config/opencode/`](./xdg-config/opencode) | Repo-local OpenCode config root used by the wrapper |

## Runtime Composition

### Wrapper Layer

- [`bin/opencode`](./bin/opencode)
  - forces repo-local config isolation
  - keeps global persona/plugins out
  - preserves repo-required MCPs
- [`bin/dr-autopilot`](./bin/dr-autopilot)
  - shell entrypoint for the repo-local watchdog
- [`bin/dr-memory-queue-outcome`](./bin/dr-memory-queue-outcome)
  - shell bridge for staging durable smoke regressions or feature outcomes into pending outcome files

### Commands

- [`commands/autopilot.md`](./commands/autopilot.md)
- [`commands/autopilot-status.md`](./commands/autopilot-status.md)
- [`commands/helper-activity.md`](./commands/helper-activity.md)
- [`commands/helper-output.md`](./commands/helper-output.md)
- [`commands/helper-sessions.md`](./commands/helper-sessions.md)
- [`commands/repo-state.md`](./commands/repo-state.md)
- [`commands/plans.md`](./commands/plans.md)
- [`commands/stale-checkpoints.md`](./commands/stale-checkpoints.md)

### Agents

See [`agents/`](./agents) for the helper catalog. The main split is:
- owner: `implementation_lead`
- readers: `codebase_explorer`, `long_context_reader`, `documentation_researcher`
- advisors: `oracle`, `architecture_consultant`, `consumer_advocate`, `reliability_consultant`
- critics: `critical_reviewer`, `security_reviewer`, `verifier`
- planners/state keepers: `planning_analyst`, `roadmap_keeper`
- workers: `implementation_worker`, `small_change_worker`

All specialist prompts now enforce:
- maximum subagent depth `1`
- specialists must not spawn more specialists

### Plugins

See [`plugins/AGENTS.md`](./plugins/AGENTS.md) for the plugin map.

Current plugin stack:
- `dr-checkpoints`
- `dr-plan-context`
- `dr-context-compaction`
- `dr-session-continuation`
- `dr-verification-guard`
- `dr-json-error-recovery`
- `dr-helper-runtime-control`
- `dr-agent-babysitter`
- `dr-specialist-routing`
- `dr-memory`
- `dr-public-code-search`
- `dr-ast-grep-search`

### Autopilot

- [`autopilot/cli.mjs`](./autopilot/cli.mjs)
  - repo-local timer/watchdog runner
  - stale task reap fallback
  - checkpoint-based resume logic
- [`autopilot/helpers.mjs`](./autopilot/helpers.mjs)
  - shared constants and helpers for autopilot behavior

## State Surface

| Path | Purpose |
|------|---------|
| [`state/checkpoints/`](./state/checkpoints) | session checkpoints and next-step continuity |
| [`state/ledgers/`](./state/ledgers) | continuity ledgers |
| [`state/memory/`](./state/memory) | durable dr-memory artifacts such as feature outcomes, smoke regressions, user friction, and runbook learnings |
| [`state/pending-outcomes/`](./state/pending-outcomes) | shell-staged durable outcomes awaiting explicit ingestion into dr-memory |
| [`state/agent-health/`](./state/agent-health) | session-local helper instability tracking |
| [`state/autopilot/`](./state/autopilot) | watchdog status |

## Design Rules

- Keep this layer repo-serving, not generic.
- Prefer explicit state over hidden agent memory.
- Prefer narrow plugins over one orchestration blob.
- Public code examples are pressure, not truth.
- If a runtime concern cannot be explained in one sentence, it probably needs its own file.
- Unstable helpers are not retried blindly. Runtime control can block a relaunch and redirect to a safer fallback or a retry-later path.
