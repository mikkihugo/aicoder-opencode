---
name: dr-clarify-spec
version: 2026-03-26.1
description: "Use before planning when a feature or change request is underspecified. Resolve high-impact ambiguity around scope, consumers, security, failure handling, and acceptance criteria before writing the implementation plan."
---

# DR Clarify Spec

## Purpose

Use this skill after the rough feature idea exists but before technical planning starts.

Its job is to reduce ambiguity that would otherwise cause bad plans, wrong tests, or rework.

## Load First

- `dr-repo-reference`
- `docs/BASE_SPEC.md`
- `AGENTS.md`
- `TDD_SPEC_FIRST.md`

## Clarification Priorities

Clarify the highest-impact unknowns first:
- primary user or operator
- production consumer
- in-scope vs out-of-scope behavior
- failure and safety expectations
- security requirements
- measurable success or acceptance criteria

If the change touches `dr-agent/`, explicitly clarify Windows-only boundaries.
If it touches auth, tokens, commands, DB access, or admin flows, explicitly clarify security expectations.

## Question Rules

- ask one question at a time
- prefer short, high-impact questions
- do not ask for technical stack choices unless they block correctness
- do not ask low-value style questions

## Output

Produce a short clarification block that can feed planning:

```markdown
## Clarified Spec

- Goal:
- Primary user:
- Production consumer:
- In scope:
- Out of scope:
- Security expectations:
- Failure handling expectations:
- Acceptance criteria:
- Open questions still deferred:
```

For substantial existing-feature changes, the clarification should also identify whether the next artifact should be a change proposal in:

`docs/plans/YYYY-MM-DD-<change-slug>/proposal.md`

## Rules

- do not guess where ambiguity changes scope or safety
- do make reasonable assumptions on low-impact details
- stop clarifying once the next planning step is safe
