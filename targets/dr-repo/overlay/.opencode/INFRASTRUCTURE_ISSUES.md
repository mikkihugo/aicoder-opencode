# OpenCode / Runtime Infrastructure Issues

Track support-infrastructure issues here when they affect how this repo is
worked on, verified, deployed, or operated.

This file is not:
- the product backlog
- a generic architecture wishlist
- a drifting notes file
- a replacement for repo plans

Use it for narrow, evidence-backed issues in the repo's support layer.

## Entry Format

```markdown
## [open|blocked|resolved] Short issue name

- Scope:
- Observed:
- Impact:
- Next step:
- Links:
```

## Open Issues

## [open] Maintenance recovery workflow is scaffolded, but not yet connected to a supervised maintenance lane

- Scope: `.maintenance/mistral-recovery/` and the future product-vs-maintenance split
- Observed: the repo now has a support-only durable Hetzner portal recovery workflow, but there is no separate supervised maintenance checkout or runner yet.
- Impact: recovery logic exists, but it still depends on manual operator startup and shares the same repo view as product work.
- Next step: create the real maintenance lane launcher/worktree split so product sessions cannot see or edit support infrastructure.
- Links:
  - [`.maintenance/README.md`](/home/mhugo/code/dr-repo/.maintenance/README.md)
  - [`.maintenance/mistral-recovery/README.md`](/home/mhugo/code/dr-repo/.maintenance/mistral-recovery/README.md)

## [open] Hetzner bootstrap does not use host-side sops-nix for runtime secrets

- Scope: `deploy/hetzner/` bootstrap and NixOS host secret flow
- Observed: [`deploy/hetzner/create-beta-node.sh`](/home/mhugo/code/dr-repo/deploy/hetzner/create-beta-node.sh) and [`deploy/hetzner/ssh-beta-node.sh`](/home/mhugo/code/dr-repo/deploy/hetzner/ssh-beta-node.sh) decrypt repo-local SOPS files on the operator machine, while [`deploy/hetzner/cloud-init.yaml`](/home/mhugo/code/dr-repo/deploy/hetzner/cloud-init.yaml) writes runtime environment directly into the generated NixOS configuration instead of using rendered host-side secret env files.
- Impact: clean adoption of llm-gateway bearer credentials, rendered env files, and host-local secret rotation is harder than it should be.
- Next step: separate infra slice to add `sops-nix` to the Hetzner NixOS bootstrap and render the required env files on-host.
- Links:
  - [`deploy/hetzner/README.md`](/home/mhugo/code/dr-repo/deploy/hetzner/README.md)
  - [`docs/OPENCODE_AGENT_POLICY.md`](/home/mhugo/code/dr-repo/docs/OPENCODE_AGENT_POLICY.md)

## [open] External llm-gateway `/v1/*` surface is available, but this repo has no canonical consumer wiring yet

- Scope: external LLM gateway consumption from repo support infrastructure
- Observed: `https://llm-gateway.centralcloud.com/v1/models` is reachable and Caddy-auth-gated, but the repo does not yet define a canonical rendered secret/env flow for an external `LLM_GATEWAY_BASE_URL` + bearer token consumer.
- Impact: the endpoint exists, but using it in a repeatable repo-native way would currently require ad hoc environment setup.
- Next step: resolve together with the `sops-nix` bootstrap slice instead of adding partial local-only wiring.
- Links:
  - [`deploy/hetzner/cloud-init.yaml`](/home/mhugo/code/dr-repo/deploy/hetzner/cloud-init.yaml)
  - [`opencode.json`](/home/mhugo/code/dr-repo/opencode.json)
