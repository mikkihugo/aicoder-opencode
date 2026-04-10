---
name: letta-monorepo-coordination
version: 2026-04-10.1
description: "Use when work spans multiple letta-workspace subprojects or requires understanding cross-subproject dependencies. Do not use for single-subproject changes."
user-invocable: true
---

# letta-monorepo-coordination

## When to Use

- A change in one subproject affects another (letta ↔ letta-code, letta-fleet ↔ lettactl)
- Deciding which subproject owns a new piece of functionality
- Coordinating a release or schema change across subprojects
- Investigating a bug that crosses subproject boundaries

## Subproject Map

| Subproject | Root | Role |
|---|---|---|
| `letta` | `letta-workspace/letta` | Core agent runtime |
| `letta-code` | `letta-workspace/letta-code` | Code-focused agent layer |
| `letta-fleet` | `letta-workspace/letta-fleet` | Fleet/multi-agent orchestration |
| `letta-selfhost` | `letta-workspace/letta-selfhost` | Self-hosted deployment configs |
| `lettactl` | `letta-workspace/lettactl` | CLI control surface |

## Contract

- Changes that affect the public interface of `letta` must be validated against `letta-code` and `lettactl`.
- `letta-fleet` depends on `letta` runtime — fleet changes require a working `letta` baseline.
- `letta-selfhost` is deployment config only — do not put runtime logic here.
- One subproject at a time unless a cross-cutting change is explicitly scoped.

## Workflow

1. Name which subprojects are affected and why.
2. Start in the subproject closest to the root dependency (`letta` before `letta-code`).
3. Verify each subproject independently before moving to the next.
4. Commit per subproject — do not batch cross-subproject changes in one commit.

## Avoid

- Making assumptions about shared interfaces without reading the source
- Committing a cross-subproject change without verifying downstream subprojects build
- Treating `letta-selfhost` as a place for runtime logic
