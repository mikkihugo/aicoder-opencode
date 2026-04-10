---
name: dr-finish-and-verify
version: 2026-03-31.1
description: "Use for the last mile: rerun verification, inspect diffs, commit or push if requested, and perform local docker-compose checks when needed. This is the DR local-tools replacement for MCP-style finish/deploy carryovers."
---

# DR Finish And Verify

## Purpose

This skill replaces the old deploy and version-control carryovers.

Load `dr-repo-reference` first for shared verification and runtime checks.

Use it to:
- rerun final verification
- inspect the diff
- commit if requested
- push if requested
- run local compose checks if requested

This repo does not use `jj` as a first-class workflow. Use normal git commands unless the user explicitly asks for something else.

If the user is trying to ship or declare the repo production-ready, hand off to
`dr-production-readiness` before making that claim.

If this skill is being used inside `dr-autonomous-iteration` and the overall user goal is still in progress:
- verify the current slice
- record evidence
- refresh `active-slice.md` if one exists
- return control to the loop
- do not stop just because the slice is green

## Slice Done Gate

Do not declare the slice done until:
- the contract test is green
- required verification is green
- the consumer-path check is explicit
- the active-slice artifact and continuity evidence are updated
- no slice-local next step remains

## Final Verification Matrix

Use the component verification matrix from `dr-repo-reference`.

## Git Workflow

Review state first:

```bash
git status --short
git diff --stat
git diff
```

Commit:

```bash
git add path/to/file.go path/to/file_test.go
git commit -m "type: short description"
```

Push:

```bash
git push origin HEAD
```

## Local Runtime Check

When a local deployment-style check is needed:

```bash
docker-compose up -d
docker-compose ps
docker-compose logs --tail=200
```

## Rules

- do not claim completion without fresh verification
- do not claim deployment success from `docker-compose up` alone
- stage only task-relevant files in a dirty worktree
- never forget `GOOS=windows` for `dr-agent/`
