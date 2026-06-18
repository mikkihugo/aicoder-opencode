---
name: dr-eng-review
description: |
  Engineering review for DR repo plans. Locks in architecture, data flow,
  diagrams, edge cases, test coverage, and operational risks before coding.
  Use when asked to "review the architecture", "engineering review", or
  "lock in the plan".
---

# DR Engineering Review

## Purpose

Catch architecture issues before implementation hardens around bad assumptions.
This review is **required** for any plan that touches more than one component
or introduces a new trust boundary.

## Before You Start

1. Read `AGENTS.md`
2. Read `ARCHITECTURE.md`
3. Read `TDD_SPEC_FIRST.md`
4. Read the plan file being reviewed
5. Detect the stack:
   - `go.mod` → Go
   - `portal/templates/` → Gin + HTMX + DaisyUI
   - `dr-agent/` → Windows service + PowerShell
   - `migrations/` → PostgreSQL + TimescaleDB

## Review Sections

Evaluate every section. "No issues" is valid only after stating what was
checked and why nothing was flagged.

### 1. Architecture Review

Evaluate:
- Component boundaries (portal / agent / gateway / installer / migrations)
- Dependency graph and coupling between components
- Data flow patterns and potential bottlenecks
- Single points of failure (VPN, Headscale, PostgreSQL primary, single gateway)
- Security architecture (auth, sessions, API keys, command injection, DPAPI)
- Whether new flows deserve an ASCII diagram in the plan or in code comments
- **Windows-agent constraints:** Does the plan respect `GOOS=windows` builds,
  PowerShell execution policy, and Windows service lifecycle?
- **PostgreSQL constraints:** Does the plan account for role-aware queries,
  connection pool lifecycle, and replication lag edge cases?

**STOP.** For each issue found, present one recommendation with options.
Only proceed after the issue is resolved.

### 2. Code Quality Review

Evaluate:
- Module structure and file placement (follow `CONVENTIONS.md` naming)
- DRY violations — flag repetition aggressively
- Error handling patterns and missing edge cases
- Areas that are over-engineered or under-engineered
- Stale ASCII diagrams in touched files — update or flag them

**Confidence Calibration:**
- 9-10: Verified by reading specific code
- 7-8: High-confidence pattern match
- 5-6: Medium confidence, caveat required
- 1-4: Suppress unless P0 severity

Format: `[P1] (confidence: 9/10) file:line — description`

### 3. Test Review

100% coverage is the goal for every new branch.

**For each planned codepath:**
1. Trace data flow from entry point to output/side effect
2. Draw an ASCII diagram showing:
   - Every function added or modified
   - Every conditional branch
   - Every error path
   - Every call to another function (trace into it)
3. Map user flows and interaction edge cases:
   - Rapid resubmit, navigate away mid-operation, stale session
   - Slow connection, concurrent actions
   - Empty/zero/boundary states
4. Verify both branches of every conditional have tests
5. Verify every error path has a test
6. Verify every Windows-specific path has a `GOOS=windows` test

If the plan is missing tests, add them directly to the plan.

### 4. Operational Readiness

Evaluate:
- Rollback strategy if the deploy fails
- Monitoring and alerting for new paths
- Agent crash-loop behavior
- Database migration safety (backwards-compatible?)
- Command queue depth growth under failure
- DLQ behavior for failed commands
- Failover RTO impact if this change is in the critical path

## Output

Append a `## DR ENGINEERING REVIEW REPORT` section to the plan file with:
- Findings per section (with confidence scores)
- ASCII diagrams produced
- Test gaps identified and filled
- Operational risks and mitigations
- Verdict: `APPROVED` / `APPROVED_WITH_NOTES` / `BLOCKED`

Do not proceed to implementation until the verdict is `APPROVED` or
`APPROVED_WITH_NOTES`.
