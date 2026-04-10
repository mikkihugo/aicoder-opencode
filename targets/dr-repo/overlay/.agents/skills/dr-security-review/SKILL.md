---
name: dr-security-review
version: 2026-03-26.1
description: "Use for security-sensitive changes or reviews. Focus on injection, auth, session handling, auditability, sensitive logging, and the repo’s required adversarial test posture."
---

# DR Security Review

## Priorities

Load `dr-repo-reference` first for shared security defaults and component verification commands.

From `AGENTS.md`, treat these as first-class:
- credentials or secrets exposure
- SQL injection
- command injection
- missing auth or authz
- sensitive logging
- unsafe failover or data-loss paths

## Review Checklist

When the change touches handlers, commands, DB access, sessions, tokens, or admin flows, check:
- input validation
- parameterized queries
- command construction
- auth and authorization gates
- CSRF implications
- session lifecycle
- audit logging
- secret or token leakage in logs

For non-trivial security review, record:
- `Observed:` exact risky patterns, boundaries, or verification output
- `Inferred:` security consequence supported by those facts
- `Proposed:` mitigation or required test
- `Confidence:` 0.0-1.0 with one-line reason
- `Falsifier:` what result would show the suspected issue is not real
- `Reflection:` weakest assumption and the next security check

## Required Test Posture

Use adversarial tests when relevant. The repo guidance includes:
- SQL injection payload coverage
- command injection payload coverage
- NoSQL, LDAP, and XML style payload checks where applicable

Security fixes without a regression test are incomplete.

## Useful Verification

Use the relevant component verification entries from `dr-repo-reference`.

## Rules

- prefer explicit validation over assumptions
- do not weaken auth, CSRF, or audit paths for convenience
- if a change affects login, admin, registration, commands, tokens, or database queries, default to a security review

## Subagent Use

For large or mixed-surface changes, use `security_reviewer` as a dedicated read-only pass.
If the security issue is inside portal request handling, pair it with `portal_explorer`.

Use the model and reasoning defaults from `docs/CODEX_AGENT_POLICY.md` so security review remains on the strongest review path.
