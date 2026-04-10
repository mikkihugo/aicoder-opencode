# AI Agent Instructions for aicoder-opencode

This repository is the maintenance control plane.

## Purpose

Manage AI coding infrastructure across multiple target repositories without mixing product code into the maintenance host.

## Target Model

Targets are external repositories or monorepos.

Current target types:

- `repo`
- `monorepo`

Current seeded targets:

- `dr-repo`
- `letta-workspace`

## Rules

- Do not copy product trees into this repository.
- Shared maintenance logic lives here.
- Product decisions stay in the target repository's own plans, tests, and docs.
- Cross-repo lessons may live here only when they are maintenance/runtime lessons rather than product behavior.

## Initial direction

- `dr-repo` is a standalone repo target.
- `letta-workspace` is a monorepo target with child projects.
- Maintenance ownership should migrate here over time.
