---
name: dr-repo-reference
version: 2026-03-26.1
description: "Use when you need the shared DR Platform reference: component verification commands, known repo risk areas, Windows-agent rules, portal checks, and security expectations."
---

# DR Repo Reference

## Purpose

This is the shared reference skill for the repo.

Use it to load the common rules that multiple other skills depend on:
- component verification commands
- portal-specific checks
- Windows-only agent constraints
- security review defaults
- local compose/runtime checks
- known repo risk areas from the current architecture and status docs

## Read These Sources As Needed

- `AGENTS.md`
- `TDD_SPEC_FIRST.md`
- `ARCHITECTURE.md`
- `STATUS.md`
- `docs/AGENT_ROLES.md`
- `docs/CODEX_AGENT_POLICY.md`
- `.github/context/project-context.md`

## Component Verification Matrix

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

Installer:
```bash
cd installer && go test ./...
cd installer && go build ./...
```

Migrations:
- verify migration file pairings
- check rollback expectations when relevant
- verify downstream portal assumptions

## Portal Checks

When touching `portal/`, consider:
- route registration
- handler and template pairing
- middleware order
- session behavior
- auth and admin boundaries
- CSRF wiring
- SSE or realtime producer and consumer paths
- download handlers and file responses

## Windows Agent Rules

When touching `dr-agent/`:
- always verify with `GOOS=windows`
- watch for WMI, Registry, DPAPI, Windows service, PowerShell, and Hyper-V boundaries
- do not trust Linux-local intuition without Windows-target build and test results

## Security Defaults

When changes touch handlers, commands, DB access, sessions, tokens, admin flows, or failover logic, default to security review.

Check for:
- SQL injection
- command injection
- auth/authz gaps
- CSRF implications
- sensitive logging
- audit logging coverage
- unsafe data-loss paths

## Local Runtime Checks

When a local runtime check is needed:
```bash
docker-compose up -d
docker-compose ps
docker-compose logs --tail=200
```

## Known Repo Risk Areas

Current recurring risks called out by repo docs:
- legacy SQLite code in `portal/main.go`
- CSRF middleware not fully wired
- metrics schema mismatch risk
- missing or mismatched templates
- gateway integration gaps
- weakly tested legacy areas in the agent

## Rule

Other DR skills should reference this skill instead of repeating the same repo-wide verification and risk material unless the repetition is necessary for trigger quality.

Role rule:
- for non-trivial work, use the canonical `partner` and `combatant` roles from `docs/AGENT_ROLES.md`
