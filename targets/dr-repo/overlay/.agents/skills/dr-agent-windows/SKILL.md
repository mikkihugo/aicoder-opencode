---
name: dr-agent-windows
version: 2026-03-26.1
description: "Use whenever work touches dr-agent. Encodes the Windows-only build, lint, test, and design constraints that are easy to miss from a Linux workstation."
---

# DR Agent Windows

## Non-Negotiable Rule

`dr-agent/` is Windows-only. Always verify with `GOOS=windows`.

Without it, you can get false failures or false confidence.

Load `dr-repo-reference` for the shared verification matrix and repo-wide risk context.

## Required Commands

Lint:

```bash
cd dr-agent && GOOS=windows golangci-lint run ./...
```

Tests:

```bash
cd dr-agent && GOOS=windows go test ./...
```

Build:

```bash
cd dr-agent && GOOS=windows GOARCH=amd64 go build -o dr-agent.exe .
```

## Watch For

- WMI assumptions
- Registry access
- DPAPI use
- Windows service lifecycle
- PowerShell integration
- Hyper-V specific behavior
- code that compiles on Linux but is invalid for the real target

## Planning Rules

When touching `dr-agent/`, the plan must explicitly call out:
- the Windows-only boundary
- the exact verification commands
- any place where Linux-local testing is insufficient

## Review Rules

Push back on any review or implementation suggestion that ignores `GOOS=windows`.

## Subagent Use

When the change is large or ambiguous, ask `windows_agent_reviewer` to review the boundary before editing or before accepting a review comment.

Use the model and reasoning defaults from `docs/CODEX_AGENT_POLICY.md` so Windows boundary review stays higher-depth than routine review.
