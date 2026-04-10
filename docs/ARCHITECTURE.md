# Architecture

## Purpose

`aicoder-opencode` is the shared maintenance control plane for repo-local AI coding lanes.

## Core split

- Control plane: this repository
- Product planes: external target repositories

## Control-plane responsibilities

- shared development doctrine
- target registry
- model registry
- maintenance policy
- local OpenCode runtime maintenance
- launcher contracts
- sandbox contracts
- shared runtime doctrine
- cross-repo maintenance memory

## Product-plane responsibilities

- product code
- product tests
- product plans
- product docs
- product release evidence

## Target-specific control-plane responsibilities

- target overlays on top of the shared control-plane base
- repo-operating prompts, plugins, commands, and skills
- target-specific maintenance runtime policy

## Topology

```text
aicoder-opencode
  -> dr-repo
  -> letta-workspace
       -> letta
       -> letta-code
       -> letta-fleet
       -> letta-selfhost
       -> lettactl
```

## Design rule

The control plane may supervise many targets, but it must not become a monorepo of copied products.

## Runtime maintenance split

- `aicoder-opencode` owns OpenCode SQLite maintenance for the local control-plane runtime
- product repos do not each invent their own database checkpoint/backup policy
- automated maintenance is online-safe: checkpoint, optimize, backup, prune
- disruptive maintenance such as `VACUUM` stays manual
