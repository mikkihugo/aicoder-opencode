---
name: dr-wave-implementation
version: 2026-03-31.1
description: "Use when executing a non-trivial DR implementation plan across multiple files or independent slices. Run implementation in bounded waves, review each wave before the next, and keep local-tool verification explicit."
---

# DR Wave Implementation

## Purpose

Use this skill when the approved work is too large for a single tight TDD slice.

This skill is the execution bridge between:
- contract-first work in `dr-spec-first-tdd`
- final verification in `dr-finish-and-verify`

It is for:
- multi-file implementation
- parallelizable story slices
- bounded refactors with clear file ownership
- work that benefits from review gates between batches

It is not for:
- trivial single-file changes
- changes that are already complete after `dr-spec-first-tdd`
- vague "just keep hacking" execution without an approved contract

## Bootstrap

Before using this skill:
1. Read `AGENTS.md`
2. Read `TDD_SPEC_FIRST.md`
3. Load `dr-repo-reference`
4. Confirm the user approved an execution-ready plan
5. Confirm `dr-spec-first-tdd` already established the contract test for the current slice
6. Confirm the current `active-slice.md` is up to date if the work uses a change folder

## Skill Chain

```text
dr-design-and-planning -> dr-generate-tasks -> dr-spec-first-tdd -> dr-wave-implementation -> dr-finish-and-verify
```

If `dr-spec-first-tdd` already made the whole slice green, skip this skill and go straight to `dr-finish-and-verify`.

## Core Rule

```text
DO NOT START WAVE 2 UNTIL WAVE 1 IS REVIEWED, VERIFIED, AND STILL MATCHES THE CONTRACT
```

Waves are for controlling risk, not for creating ceremony.

## When To Split Into Waves

Use waves when any of these are true:
- more than one file must change
- one slice has independent subparts that can be verified separately
- a cleanup/refactor needs an intermediate safety gate
- the component boundary is broad enough that review should happen before the next batch

Do not split into waves when the work is still one coherent local edit.

## Wave Shape

For each wave:
1. restate the contract this wave must satisfy
2. name the exact files owned by the wave
3. implement only the smallest set needed for that wave
4. run the wave verification commands
5. review the result for regressions and missing tests
6. refresh the active-slice artifact and record the evidence markers
7. only then start the next wave

## Parallel Work Rule

If two or more tasks are genuinely independent:
- keep ownership disjoint by file or narrow subsystem
- use read-only specialists to map or review in parallel
- do not run parallel edits against the same file

Use DR's Codex agents only for concrete parallel read-only work:
- `portal_explorer`
- `reviewer`
- `security_reviewer`
- `windows_agent_reviewer`

Keep critical-path implementation local unless the split is clearly safe.

## Pre-Wave Check

Before each wave, confirm:
- the consumer is still the same
- the contract test still expresses the right behavior
- the current wave has exact file ownership
- the verification commands are known up front
- the next wave is actually blocked on this one

If any answer is unclear, return to planning instead of improvising.

## Review Gate After Each Wave

After each wave, record:
- `Observed:` what changed and what passed
- `Inferred:` what that means for correctness or risk
- `Proposed:` next wave or cleanup step
- `Confidence:` 0.0-1.0 with one-line reason
- `Falsifier:` what result would prove this wave is not actually safe
- `Reflection:` weakest assumption before the next wave

Do not continue to the next wave if:
- the contract test is failing
- lint is failing
- build is failing
- the wave introduced unexplained drift
- review found a regression that is not resolved

## Slice Done Gate

Do not call a slice done until all of these are true:
- the contract test is green
- required component verification is green
- the consumer-path check is explicit
- the active-slice artifact and continuity evidence are updated
- no next step remains for the current slice

Green code alone is not enough.

## Local Verification

Use component-specific commands from `dr-repo-reference`.

Typical examples:

Portal:
```bash
cd portal && go test ./...
cd portal && golangci-lint run ./...
cd portal && go build -o dr-portal .
```

Agent:
```bash
cd dr-agent && GOOS=windows go test ./...
cd dr-agent && GOOS=windows golangci-lint run ./...
cd dr-agent && GOOS=windows GOARCH=amd64 go build -o dr-agent.exe .
```

Gateway:
```bash
cd gateway && go test ./...
cd gateway && go build ./...
```

## Rules

- one wave should correspond to one meaningful, reviewable increment
- do not weaken the contract test to make a wave easier
- do not leave duplicate temporary paths behind without a follow-up wave that removes them
- if the wave touches `dr-agent/`, assume Linux-local confidence is insufficient until Windows checks pass
- route failures into `dr-systematic-debugging` immediately

## Exit Condition

Leave this skill only when one of these is true:
- all planned waves are complete and verified
- the remaining work is small enough for `dr-finish-and-verify`
- a blocker requires a return to planning or debugging
