---
name: dr-design-and-planning
version: 2026-03-31.1
description: "Use before implementation. Merge design discovery and plan writing into one DR-specific flow: identify the consumer, inspect the repo, debate boundaries with partner and combatant, and produce an execution-ready plan that hands off cleanly into DR-native tasks, TDD, and implementation waves."
---

# DR Design And Planning

## Bootstrap

Before using this skill:
1. Read `AGENTS.md`
2. Read `TDD_SPEC_FIRST.md`
3. Load `dr-repo-reference`
4. Check `ARCHITECTURE.md` or `STATUS.md` for the affected area
5. Load `docs/templates/FEATURE_SPEC_TEMPLATE.md`
6. Load `docs/templates/CHANGE_SPEC_TEMPLATE.md` for brownfield behavior changes
7. Load `docs/AGENT_ROLES.md`

## Purpose

Do two things in one flow:
- decide what should be built
- write the execution-ready plan

Do not split design and planning into separate rituals unless the problem is unusually large.

## Skill Chain

```text
dr-clarify-spec -> dr-design-and-planning -> dr-generate-tasks -> dr-spec-first-tdd -> [dr-wave-implementation if needed] -> dr-finish-and-verify
```

## Required Outputs

Before implementation starts, name:
- the purpose
- the production consumer
- the value at risk if the behavior is wrong
- the affected component: `portal/`, `dr-agent/`, `gateway/`, `installer/`, or `migrations/`
- the test contract
- the verification commands
- what is explicitly out of scope
- the falsifier

If the request is underspecified, use `dr-clarify-spec` before writing the plan.

For substantial brownfield work, produce a change folder instead of a single flat plan file:
- `docs/plans/YYYY-MM-DD-<change-slug>/proposal.md`
- `docs/plans/YYYY-MM-DD-<change-slug>/design.md`
- `docs/plans/YYYY-MM-DD-<change-slug>/tasks.md`
- `docs/plans/YYYY-MM-DD-<change-slug>/active-slice.md`

Use `proposal.md` for requirement deltas and acceptance criteria.
Use `design.md` for the execution-ready technical plan.
Use `active-slice.md` as the single authoritative working artifact for the current slice once execution starts.

## Local Discovery

Search before proposing changes:

```bash
rg -n "<term>" portal dr-agent gateway installer migrations
rg --files portal dr-agent gateway installer migrations
git grep -n "<symbol>"
git log -- <path>
```

Read the closest existing tests and handlers before inventing abstractions.

## Debate Rule

For non-trivial design choices:
- run one partner pass to strengthen the preferred design
- run one combatant pass to attack coupling, scope, and missing tests
- synthesize only after the disagreement is explicit

Use the canonical role behavior from `docs/AGENT_ROLES.md`, not improvised versions.

For non-trivial planning decisions, record:
- `Observed:` facts from code, docs, tests, or command output
- `Inferred:` reasoning supported by those facts
- `Proposed:` recommended design or plan choice
- `Confidence:` 0.0-1.0 with one-line reason
- `Falsifier:` what result would prove the current plan wrong
- `Reflection:` weakest assumption and the next check

## Decision Complete Gate

Implementation must not start until the next slice is decision-complete.

Minimum bar:
- purpose is specific enough to reject irrelevant work
- consumer is concrete
- value at risk is named
- contract test is explicit
- required verification is explicit
- out-of-scope is explicit
- falsifier is plausible

If any item is missing, the work is not ready. Clarify or keep planning instead of improvising in code.

## Subagent Use

Use subagents only when the work is genuinely parallelizable.

For unfamiliar or cross-component work, open with a short parallel evidence pass before locking the plan:
- `codebase_explorer` for cheap execution-path and ownership mapping
- `long_context_reader` for broad subsystem evidence
- add `architecture_consultant` only when the next decision depends on a structural assumption
- add `consumer_advocate` only when user workflow friction is central

Keep the opening pass read-only, narrow, and capped at two or three specialists that cover different blind spots.
Synthesize their evidence before writing the plan.

Prefer one narrow specialist at a time after the opening evidence pass.
Use specialists by failure mode, not by habit:
- `portal_explorer` when route, template, middleware, or SSE ownership is unclear
- `windows_agent_reviewer` when the plan touches `dr-agent/` and Windows-only boundaries could be misunderstood
- `security_reviewer` when auth, commands, tokens, sessions, or DB boundaries are part of the design

Do not spawn subagents for simple single-file planning work.

## Plan Format

Default lightweight output:

`docs/plans/YYYY-MM-DD-<feature>.md`

Preferred output for non-trivial brownfield changes:

`docs/plans/YYYY-MM-DD-<change-slug>/design.md`

Use this shape:

```markdown
# [Feature] Plan

> **For agents:** Use `dr-wave-implementation` when execution is multi-file or wave-shaped. Use `dr-spec-first-tdd` alone for focused single-slice work.

**Goal:** [one sentence]
**Component:** [portal | dr-agent | gateway | installer | migrations]
**Consumer:** [real caller or user flow]
**Out of scope:** [explicitly refused work]

## Task N: [Behavior]

**Purpose:** [...]
**Contract:** [test that proves it]
**Files:** [exact paths]
**RED:** [exact command]
**GREEN:** [exact command]
**Lint:** [exact command]
**Build:** [exact command if needed]
**Evidence:** [runtime or user-visible check]
```

For the paired change proposal, use `docs/templates/CHANGE_SPEC_TEMPLATE.md` and save it as:

```markdown
# [Change] Proposal

## Why This Change
...

## Requirement Deltas

### ADDED Requirements
- ...

### MODIFIED Requirements
- ...

### REMOVED Requirements
- ...

### RENAMED Requirements
- ...

## Acceptance Criteria
...
```

For non-trivial plans, append:

```markdown
## Decision Markers

- Observed:
- Inferred:
- Proposed:
- Confidence:
- Falsifier:
- Reflection:
```

If the change folder exists, also create or refresh:

```markdown
docs/plans/YYYY-MM-DD-<change-slug>/active-slice.md
```

Use `docs/templates/ACTIVE_SLICE_TEMPLATE.md`.

## Story-Slice Rule

Plans should be organized around independently testable user-story slices, not generic file-edit buckets.

Each meaningful slice should:
- map to one user story or one sub-slice of a user story
- have its own contract test
- be verifiable on its own
- deliver value without requiring every later slice to exist first

Bad:
- "edit handlers"
- "update templates"
- "wire database"

Good:
- "P1 story: customer can see current VM replication health on dashboard"
- "P1 story: operator can submit a guarded failover request"
- "P2 story: admin can manage customer enrollment tokens"

## Verification Matrix

Use the component verification matrix from `dr-repo-reference`.

## Stop Condition

After the plan is execution-ready, use `dr-generate-tasks` to produce the concrete task list.

Stop and ask for `go` only when both the plan and task structure are execution-ready.
