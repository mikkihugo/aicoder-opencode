---
name: dr-portal-ui-and-handlers
version: 2026-03-26.1
description: "Use for portal-heavy work: Gin handlers, middleware, templates, SSE flows, dashboard pages, auth, sessions, CSRF wiring, and user-visible portal behavior."
---

# DR Portal UI And Handlers

## Use This Skill When

The change touches:
- `portal/main.go`
- handlers
- middleware
- templates
- SSE or realtime flows
- login, admin, dashboard, or registration pages

Load `dr-repo-reference` first for shared portal checks and component verification commands.

## Default Verification

Use the portal entries from `dr-repo-reference`.

## Portal-Specific Checks

Always consider:
- route registration
- middleware order
- session behavior
- auth and admin boundaries
- CSRF handling
- template existence and rendering paths
- SSE or realtime stream behavior
- download handlers and file responses

## Known Risk Areas In This Repo

- legacy SQLite code still present in `portal/main.go`
- CSRF middleware wiring gaps
- missing or mismatched templates
- metrics schema mismatches
- gateway integration assumptions the gateway does not yet satisfy

## Working Rules

- check the handler and its template together
- if a route renders HTML, verify the template exists
- if a stream or realtime path changes, verify both producer and consumer behavior
- if auth, session, or CSRF behavior changes, treat it as security-sensitive

## Subagent Use

For large portal tasks:
- use `portal_explorer` first to map routes, middleware, templates, and tests
- use `reviewer` for correctness review once the change is understood
- use `security_reviewer` if auth, admin, session, CSRF, token, or download behavior is involved

Use the model and reasoning defaults from `docs/CODEX_AGENT_POLICY.md` instead of treating all portal subagent work as the same cost or depth.
