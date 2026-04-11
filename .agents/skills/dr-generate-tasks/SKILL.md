---
name: dr-generate-tasks
version: 2026-03-26.1
description: "Use after planning and before implementation when you need a concrete, dependency-ordered task list. Turn the DR feature spec and plan into independently testable task slices with exact file paths and verification commands."
---

# DR Generate Tasks

## Purpose

Use this skill to transform a clarified feature spec and execution-ready plan into an actionable task list.

The output should be concrete enough that implementation can proceed without rethinking the task structure.

## Load First

- `dr-repo-reference`
- `docs/templates/FEATURE_SPEC_TEMPLATE.md`
- `docs/templates/CHANGE_SPEC_TEMPLATE.md`
- `docs/templates/TASKS_TEMPLATE.md`
- the current feature spec
- the current plan in `docs/plans/`

## Inputs

Required:
- feature spec using the DR feature spec template
- execution-ready plan with story-sliced tasks

Preferred for substantial changes:
- `proposal.md` using the DR change spec template
- `design.md` using the DR planning format

Optional:
- notes from `dr-clarify-spec`
- supporting operational or architecture docs

## Output

For lightweight work, save the task list next to the plan using:

`docs/plans/YYYY-MM-DD-<feature>-tasks.md`

For non-trivial brownfield changes, save the task list as:

`docs/plans/YYYY-MM-DD-<change-slug>/tasks.md`

## Task Generation Rules

- organize tasks by independently testable user story
- keep setup and shared foundation separate from story slices
- include exact file paths
- include RED, GREEN, lint, and build commands where relevant
- mark only truly parallel work as parallel
- keep tasks small enough to verify
- do not bundle unrelated files into one task

## Task Shape

Each story should include:
- the goal
- the independent test
- the test-first tasks
- the implementation tasks
- the verification tasks

## DR-Specific Requirements

- `dr-agent/` tasks must explicitly include `GOOS=windows`
- portal tasks must account for handlers, templates, middleware, and route wiring together when needed
- security-sensitive tasks must mention required regression coverage
- migration tasks must mention schema alignment and rollback expectations when relevant

## Rules

- task order should reflect real dependencies
- story 1 should be independently shippable where practical
- do not generate placeholder tasks like "update code"
- do not let task structure drift away from the plan's story slices
- if `proposal.md` exists, task slices must trace back to its requirement deltas and acceptance criteria
