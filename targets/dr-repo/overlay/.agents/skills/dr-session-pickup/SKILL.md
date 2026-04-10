---
name: dr-session-pickup
version: 2026-04-09.1
description: "Use when resuming work in this repo after a pause or starting a fresh session on in-flight changes. Reconstruct the current state, open risks, relevant files, completed verification, and next actions."
---

# DR Session Pickup

## Purpose

Use this skill to recover working context quickly without re-deriving everything from scratch.

It should produce a compact, actionable state summary for the current task or repo area.

## Load First

Before summarizing, load:
- `dr-repo-reference`
- `AGENTS.md`
- `STATUS.md` when the task touches known architecture or integration gaps

## What To Inspect

### Step 1: Parallel evidence pass (always do this first)

**Always dispatch read-only subagents in parallel before running sequential commands yourself.**

When the area is unfamiliar, spans multiple components, or the next step depends on broad repo evidence, launch 2-3 specialists simultaneously:

- `codebase_explorer` — ownership, routes, execution-path mapping
- `long_context_reader` — broad subsystem evidence across many files
- `architecture_consultant` — structural assumptions (only when the next step depends on one)
- `consumer_advocate` — user workflow friction (only when that is central)

Dispatch all of them in a single message. Do not wait for one to finish before starting the next.

Respect delegation limits (AGENTS.md):
- max 3 concurrent specialists
- max 1 heavy reader (`long_context_reader`, `architecture_consultant`, `reliability_consultant`, `consumer_advocate`)
- max 2 light readers (`codebase_explorer`, `documentation_researcher`)

### Step 2: Local quick-check commands

After the parallel evidence pass returns, run fast local checks for anything the subagents did not cover:

```bash
git status --short
git diff --stat
git diff
git log --oneline -n 10
```

Then inspect the likely task area:

```bash
rg -n "<symbol>|<route>|<command>|TODO|FIXME" portal dr-agent gateway installer migrations
```

If the work is portal-heavy, use `portal_explorer`.
If it touches `dr-agent/`, load `dr-agent-windows`.
If it touches auth, commands, sessions, tokens, or DB boundaries, load `dr-security-review`.

## Required Output

Produce a short state block with:

```markdown
## Session Pickup

- Goal:
- Active component:
- Relevant files:
- What changed:
- Verified already:
- Not verified yet:
- Open risks:
- Next best action:
```

## Rules

- prefer current repo evidence over memory
- do not guess verification status; name the exact commands if known
- mention `GOOS=windows` explicitly if `dr-agent/` is involved
- if the worktree is dirty, separate task-relevant changes from unrelated noise
- if the current direction is unclear, recommend the next smallest clarifying step
- when called from `dr-autonomous-iteration`, end with the next executable slice, not a passive summary
- when pickup depends on broad repo evidence, prefer a short parallel read-only pass before long sequential search

## When To Use

Use this skill when:
- reopening a partially finished task
- switching to a fresh Codex session
- inheriting work from another agent
- preparing to continue a long-running portal or agent change
