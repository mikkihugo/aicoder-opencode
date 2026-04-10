# .opencode/plugins/ — Shared Control-Plane OpenCode Plugins

This directory contains repo-local install shims for the shared control-plane
plugin base owned by `aicoder-opencode`.

Source code belongs under:
- `src/plugins/`

Install shims belong under:
- `.opencode/plugins/`

Rules:
- shared plugin source lives in `aicoder-opencode`
- product repos consume shared plugins through thin repo-local entrypoints
- repo-specific product behavior stays in the product repo
- do not copy plugin implementations into product repos when a shared base is enough

Current shared plugin base:
- `model-registry` → `src/plugins/model-registry.ts`
