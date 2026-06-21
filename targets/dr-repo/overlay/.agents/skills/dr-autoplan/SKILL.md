---
name: dr-autoplan
description: |
  Auto-review pipeline for DR repo plans. Runs sequential adversarial reviews
  (purpose/architecture/implementation/verification) with auto-decisions before
  any code is written. Use before executing any non-trivial phase.
---

# DR Auto-Plan Review

## Purpose

One command. Rough plan in, fully reviewed plan out.

`dr-autoplan` reads a plan file and runs sequential adversarial reviews using
this repo's existing `AGENT_ROLES.md` framework. It auto-decides mechanical
issues and surfaces taste decisions at a final approval gate. The user only
weighs in when reasonable people could disagree.

## Decision Principles

Auto-answer mechanical questions using these rules:

1. **Choose completeness** — Ship the whole thing. Pick the approach that covers more edge cases.
2. **Boil the blast radius** — Fix everything the plan touches + direct importers.
3. **Pragmatic** — If two options fix the same thing, pick the cleaner one.
4. **DRY** — Duplicates existing functionality? Reject. Reuse what exists.
5. **Explicit over clever** — 10-line obvious fix > 200-line abstraction.
6. **Bias toward action** — Flag concerns, don't block indefinitely.

## Sequential Execution

Run in strict order. Each pass must complete before the next begins.

### Pass 1: Purpose & Scope (Partner + Combatant)
- **Partner** strengthens the stated goal, consumer, and value at risk.
- **Combatant** challenges whether this is the right problem to solve now and
  whether scope could be smaller.

**Gate:** If both agree the user's stated direction should change (merge, split,
add, or remove a feature), this is a **User Challenge** and MUST stop for human
input. Everything else is auto-decided.

### Pass 2: Architecture & Boundaries (Partner + Combatant)
- **Partner** verifies the data flow and component boundaries are sound for the
  DR platform (portal, agent, gateway, installer, migrations).
- **Combatant** attacks coupling, hidden assumptions, and missing Windows-agent
  or PostgreSQL edge cases.

**Required outputs:**
- ASCII data-flow diagram for any new cross-component flow
- List of affected components (`portal/`, `dr-agent/`, `gateway/`, `installer/`, `migrations/`)
- Failure mode: one realistic production failure scenario per new codepath

### Pass 3: Implementation & Tests (Partner + Combatant)
- **Partner** improves test contracts and verification commands.
- **Combatant** looks for missing tests, unsafe shortcuts, and unverified
  PowerShell or SQL paths.

**Required outputs:**
- Test coverage diagram (ASCII) for every new branch
- Verification command list (build, lint, test)

### Pass 4: Verification & Risk (Partner + Combatant)
- **Partner** confirms the falsifier is plausible and the out-of-scope list is
  explicit.
- **Combatant** identifies rollback triggers and operational risks (agent crash
  loops, portal 5xx, command queue growth, DLQ filling).

## Final Approval Gate

After all four passes, present a summary:

```
## DR Auto-Plan Review Report

### Auto-Resolved (mechanical)
- [List of decisions made automatically with principle cited]

### Taste Decisions (surface to user)
- [Close approaches, borderline scope, model disagreements]

### User Challenges (STOP — requires your input)
- [If both Partner and Combatant agree direction should change]
```

If there are **no User Challenges**, append the report to the plan file and
return `DONE`.

If there **are User Challenges**, stop and ask one concise question per
challenge. Do not proceed to execution until resolved.

## Input / Output

**Input:** Path to a plan file (e.g. `docs/plans/2026-04-14-feature/design.md`)

**Output:** Updated plan file with `## DR AUTO-PLAN REVIEW REPORT` appended.
