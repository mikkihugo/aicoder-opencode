---
name: dr-spec-first-tdd
version: 2026-03-31.2
description: "Use for any repo behavior change. Purpose and consumer first, failing test before code, then component-appropriate lint, build, and evidence. Hand off to implementation waves only when the slice is too broad for one focused change."
---

# DR Spec-First TDD

## Bootstrap

Before using this skill:
1. Read `AGENTS.md`
2. Read `TDD_SPEC_FIRST.md`
3. Load `dr-repo-reference`
4. Confirm the user approved an execution-ready plan
5. Confirm the current slice is decision-complete before coding begins

## Iron Law

```
NO BEHAVIOR CHANGE WITHOUT A FAILING TEST FIRST
NO COMPLETION WITHOUT A REAL CONSUMER
NO JUDGMENT CALL WITHOUT A CONFIDENCE AND FALSIFIER
```

## Skill Chain

```text
dr-design-and-planning -> dr-generate-tasks -> dr-spec-first-tdd -> [dr-wave-implementation if needed] -> dr-finish-and-verify
```

Default expectation:
- write the contract test first
- make the smallest passing implementation locally
- only invoke `dr-wave-implementation` when the slice is truly multi-file or wave-shaped

## Workflow

1. Name the consumer and boundary.
2. Name the value at risk if the behavior is wrong.
3. Write the failing test first.
4. Verify RED for the right reason.
5. Implement the smallest passing change.
6. Verify GREEN.
7. Run lint and build for the touched component.
8. Record evidence.

Do not start implementation if purpose, consumer, value at risk, contract, verification, out-of-scope, or falsifier are still missing.

## Authorship Boundary

This skill owns:
- the contract test
- the first minimal implementation
- the red to green proof for one focused slice

Escalate to `dr-wave-implementation` when:
- the implementation spans multiple files
- the slice has independent subparts that need review gates
- a bounded refactor or cleanup remains after the contract is green

If the change is already green and verified here, go directly to `dr-finish-and-verify`.

For non-trivial TDD work, record:
- `Observed:` current behavior, failing output, or consumer facts
- `Inferred:` intended contract supported by those facts
- `Proposed:` minimal change to satisfy the contract
- `Confidence:` 0.0-1.0 with one-line reason after major steps
- `Falsifier:` what would prove the contract or fix is wrong
- `Reflection:` weakest assumption and the next verification step

If the work uses a change folder, keep `active-slice.md` current while the slice moves from RED to GREEN.

## Consumer Discovery

Use local search:

```bash
rg -n "<symbol>|<route>|<template>|<command>" portal dr-agent gateway installer
git grep -n "<symbol>"
```

If you cannot name a real consumer, stop.

## Component Verification

Use the component verification matrix from `dr-repo-reference`.

## Rules

- bug fixes require a regression test first
- security fixes require adversarial payload coverage
- `dr-agent/` always requires `GOOS=windows`
- the contract should name the value at risk, not just the expected output
- tests define the contract, not the other way around
- if RED fails for the wrong reason, enter `dr-systematic-debugging`
- do not continue into broad follow-on edits once the contract is green without deciding whether the remaining work belongs in `dr-wave-implementation`

## Evidence

Before calling work complete, capture:
- the failing test that motivated the change
- the passing test result
- lint result
- build result when relevant
- the consumer path
- the value at risk
- the updated active-slice artifact when one exists

For non-trivial slices, add:

```markdown
## Evidence Markers

- Observed:
- Inferred:
- Proposed:
- Confidence:
- Falsifier:
- Reflection:
```
