---
name: dr-code-review
version: 2026-03-31.1
description: "Use for both preparing work for review and responding to review feedback. Keep review evidence local, concrete, and scoped to the real contract. Verify technically before agreeing or changing code."
---

# DR Code Review

## Use This Skill For

- preparing a review packet
- validating review feedback
- pushing back with evidence
- fixing review findings

## Before Requesting Review

Include:
- what changed
- the consumer
- exact files changed
- test results
- lint results
- build results when relevant
- known risks

For non-trivial reviews, also include:
- `Observed:` concrete findings from code or verification
- `Inferred:` risk or behavior conclusion
- `Proposed:` requested change or rebuttal
- `Confidence:` 0.0-1.0 with one-line reason
- `Falsifier:` what would prove the review conclusion wrong
- `Reflection:` weakest assumption and the next check

Helpful commands:

```bash
git diff --stat
git diff
```

Portal:
```bash
cd portal && go test ./...
cd portal && golangci-lint run ./...
```

Agent:
```bash
cd dr-agent && GOOS=windows go test ./...
cd dr-agent && GOOS=windows golangci-lint run ./...
```

## When Receiving Review

Do this in order:
1. restate the comment
2. verify it locally
3. decide whether it is correct
4. fix or push back with evidence
5. rerun the relevant checks

When responding to non-trivial comments, label your reasoning with `Observed`, `Inferred`, and `Proposed`.

Do not agree with review feedback before verification.
The required pattern is:
- read the full comment
- restate the actual requirement
- verify it in code, tests, or runtime checks
- then fix it or push back with evidence

For larger review items, prefer one issue at a time:
- blocking correctness or security issues first
- simple fixes next
- broader refactors only after the underlying comment is proven valid

## Push Back When

- the feedback adds dead code
- the feedback breaks the tested contract
- the feedback ignores `GOOS=windows` constraints
- the feedback weakens security, validation, auth, or audit logging

## Review Debate

For non-trivial review disputes:
- partner pass: strongest case for the comment
- combatant pass: strongest case against it
- decide only after the disagreement is explicit

Use the canonical role behavior from `docs/AGENT_ROLES.md`.

## Subagent Use

For larger reviews, use narrow read-only subagents:
- `reviewer`
- `security_reviewer` for security-sensitive changes

Use the model and reasoning defaults from `docs/CODEX_AGENT_POLICY.md` rather than treating all review work as equal-cost and equal-depth.

For larger reviews, use narrow read-only subagents:
- `reviewer` for correctness, regressions, and missing tests
- `security_reviewer` for security-sensitive diffs
- `windows_agent_reviewer` for `dr-agent/` changes
- `portal_explorer` when the portal execution path is unclear

Do not use subagents for tiny, obvious review fixes.
