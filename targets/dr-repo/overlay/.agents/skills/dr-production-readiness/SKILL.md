---
name: dr-production-readiness
version: 2026-03-26.1
description: "Use when the goal is to drive the repo toward production readiness instead of just passing one local slice. Enforces cross-component release gates, rollout prerequisites, and evidence for a real ship decision."
---

# DR Production Readiness

## Purpose

Use this skill when the real goal is:
- make the system shippable
- prove the current state is production-ready
- identify exactly what still blocks a production decision

This skill sits above per-slice completion. Passing one feature or test cluster is not enough.

## Load First

- `dr-repo-reference`
- `docs/BASE_SPEC.md`
- `docs/PRODUCTION_CHECKLIST.md`
- `docs/RUNBOOKS.md`
- `docs/ON-CALL.md`
- `docs/AGENT-ROLLOUT.md`
- `STATUS.md`
- `ROADMAP.md`

## What Production-Ready Means

Do not use "production-ready" loosely.

For this repo, it means:
- the highest-risk product workflows are freshly verified
- the portal, agent, gateway, installer, migrations, and deployment surfaces each have a real readiness status
- security-sensitive paths have regression evidence
- rollout, rollback, runbooks, and on-call prerequisites are present and coherent

## Required Output

Produce a readiness block:

```markdown
## Production Readiness

- Portal:
- Agent:
- Gateway:
- Installer:
- Migrations:
- Deployment:
- Runbooks / On-call:
- Security:
- Remaining blockers:
- Recommended next slice:
```

## Readiness Rules

- do not infer readiness from old status prose alone
- use fresh verification evidence where possible
- separate "implemented" from "verified"
- treat missing rollout or rollback evidence as a real blocker
- if a component is not the current focus, mark it `unknown` rather than pretending it is green

## Final Gate

Only call the repo production-ready when `docs/PRODUCTION_CHECKLIST.md` is satisfied or every remaining unchecked item is explicitly marked as an out-of-scope operational decision.
