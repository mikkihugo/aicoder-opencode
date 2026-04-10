# Architecture

## Purpose

`aicoder-opencode` is the shared maintenance control plane for repo-local AI coding lanes.

## Core split

- Control plane: this repository
- Product planes: external target repositories

## Control-plane responsibilities

- target registry
- model registry
- maintenance policy
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
