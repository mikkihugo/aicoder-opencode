---
name: dr-systematic-debugging
version: 2026-03-26.1
description: "Use for bugs, failing tests, bad runtime behavior, or unexpected regressions. Gather evidence locally, identify root cause, then fix and verify through the correct component commands."
---

# DR Systematic Debugging

## Iron Law

```
NO FIX WITHOUT ROOT-CAUSE INVESTIGATION FIRST
NO NON-TRIVIAL FIX WITHOUT AN EXPLICIT REPRO
```

## Gather Evidence

Load `dr-repo-reference` before running component-specific verification.
Load `docs/AGENT_ROLES.md` for non-trivial bugs.

Start with the smallest reliable reproduction:

```bash
git diff -- <path>
git log -- <path>
rg -n "<symbol>|<error>|<route>" portal dr-agent gateway installer
```

If relevant, inspect runtime state:

```bash
docker-compose ps
docker-compose logs --tail=200 portal
docker-compose logs --tail=200 postgres
```

## Diagnose

Before editing, state:
- what fails
- where it fails
- what changed
- what evidence would falsify the leading hypothesis

Label diagnosis work as:
- `Observed:` logs, diffs, tests, traces, or code facts
- `Inferred:` root-cause explanation supported by those facts
- `Proposed:` fix or next experiment
- `Confidence:` 0.0-1.0 with one-line reason
- `Falsifier:` what result would disprove the current diagnosis
- `Reflection:` weakest assumption and the next diagnostic check

For non-trivial issues:
- run one partner pass to strengthen the diagnosis
- run one combatant pass to challenge it

Use the canonical role behavior from `docs/AGENT_ROLES.md`.

Use subagents only when evidence gathering can run in parallel:
- `portal_explorer` to map the failing portal path
- `windows_agent_reviewer` to check Windows-only agent constraints
- `security_reviewer` if the bug crosses a security boundary

## Verify By Component

Use the component verification matrix from `dr-repo-reference`, narrowing to the failing component and test target.

## Rules

- fix the root cause, not the symptom
- write or update the regression test first
- keep a before and after repro path for meaningful bugs
- if the issue is in `dr-agent/`, assume Linux-local intuition is unreliable until the Windows build path passes
