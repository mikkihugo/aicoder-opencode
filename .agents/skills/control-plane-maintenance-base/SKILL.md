---
name: control-plane-maintenance-base
description: Shared maintenance topology and policy for aicoder-opencode — one server per repo, shared plugins, overlay-first changes
user-invocable: false
---

# control-plane-maintenance-base

Shared maintenance/control-plane base for repos that attach to the `aicoder-opencode`
server.

Use this skill when work is about:
- shared maintenance workflows
- shared OpenCode control-plane behavior
- cross-repo maintenance plugin baselines
- per-repo server topology that should stay consistent across product repos

## Responsibilities

- Keep one OpenCode server per repo.
- Keep shared maintenance logic in `aicoder-opencode`.
- Push repo-specific overlays back into the product repo only when they are truly product-specific.
- Prefer thin install shims in product repos over copied plugin implementations.
- Change maintenance topology in small reversible steps and verify one target
  repo path before rolling the same pattern wider.

## Contract

- `aicoder-opencode` owns shared maintenance plugins and skills.
- Product repos may install shared base shims, then add local overlays.
- Control-plane changes should not silently fork per repo.

## Topology

- `aicoder-opencode` on `8080`
- `dr-repo` on `8082`
- `letta-workspace` on `8084`
- OpenChamber attaches to one repo server at a time

## Shared Base

- Shared plugin source belongs in `src/plugins/`
- Shared skill source belongs in `.agents/skills/`
- Product repos consume shared base via repo-local shims

## Runtime: Model Provider Priority

Subscription providers are always preferred over pay-per-token. Current sources in priority order:

| Priority | Provider | Status | Notes |
|---|---|---|---|
| 1 | `ollama-cloud/*` | Free (rate-capped daily) | Best models when available |
| 2 | `minimax/*` | Subscription (minimax.io) | Reliable fallback |
| 3 | `kimi-for-coding/*` | Subscription (api.kimi.com) | User-Agent gated, works via opencode |
| 4 | `openrouter/*` (paid models) | Pay-per-token | Last resort only |

`openrouter/:free` models are NOT available on the current paid account — they 404.

### Autopilot model selection (per task matrix)

| Task type | Primary | Fallback |
|---|---|---|
| Autonomous coding iteration (dr-repo) | `ollama-cloud/qwen3-coder:480b` | `minimax/MiniMax-M2` |
| Maintenance / type fixes (letta-workspace) | `ollama-cloud/devstral-2:123b` | `minimax/MiniMax-M2` |
| Fast general iteration | `ollama-cloud/kimi-k2.5` | `minimax/MiniMax-M2` |
| Architecture / heavy reasoning | `ollama-cloud/kimi-k2-thinking` | `minimax/MiniMax-M2` |

Current active env: `DR_AUTOPILOT_MODEL` and `LETTA_MAINTENANCE_MODEL` in `~/.config/opencode/opencode-runtime.env`. Set to `minimax/MiniMax-M2` while ollama-cloud is rate-capped. Switch back to ollama-cloud models when cap resets.

## Runtime: Model Selection

The `model-registry` plugin exposes two tools:
- `list_curated_models` — all registry entries; use `freeOnly: true` to scope to free providers
- `select_models_for_role` — models recommended for a named role (e.g. `"autonomous-agent"`, `"code-review"`)
- `get_quota_backoff_status` — providers currently in quota backoff and when they expire

Rules:
- Before starting a long autonomous task, call `get_quota_backoff_status`. If a needed provider is in backoff, pick a curated fallback from the same registry entry's `provider_order`.
- Never fall back to `longcat`, `claude`, `gpt`, or `grok` models automatically. These are subscription-gated or architecturally undesirable as automatic fallbacks.
- Free providers (ollama-cloud, openrouter free-tier) are preferred for autonomous/maintenance loops. Paid providers (openrouter paid models) only when no free alternative covers the capability tier.
- Temperature is set automatically by the `model-registry` plugin based on the model's `capability_tier`. Do not override temperature in prompts.

## Runtime: Autonomous Execution

These rules apply to all repo maintenance sessions (dr-repo autopilot, letta-workspace maintenance, aicoder unblock-and-patch):

- Default to sustained execution. Do substantial work before reporting back.
- Take your own best evidence-backed recommendation for reversible decisions.
- Ask only when the next action is destructive, irreversible, or preference-shaped in a way that materially changes the path.
- If confidence is low on a critical sub-decision, spawn a specialist subagent for review before proceeding — do not interrupt the human.
- When a maintenance loop fires and finds no pending work, log and exit cleanly. Do not spin on empty queues.
- If a session was previously interrupted, re-read the last checkpoint or session-id file before starting new work to resume cleanly.

### Autopilot continuation

When the autopilot timer fires:
1. Check if the runner unit is already active — if yes, exit immediately (do not start a second runner).
2. Check the session-id file. If it contains a valid session ID, resume that session with `--session <id>`.
3. If no session-id file exists, start a new session with the configured title.
4. Use `get_quota_backoff_status` before starting a long chain — if the configured model's provider is in backoff, switch to the next provider in the priority table above.
5. On quota error (429) mid-session, the model-registry plugin records the backoff. The next timer cycle will start a fresh attempt — do not retry in a tight loop within the same session.

## Runtime: Quota and Provider Events

The plugin tracks quota events automatically and backs off providers for 1 hour on HTTP 429 or quota-keyword errors. No manual action is needed during normal operation.

If you observe a provider persistently failing (beyond the 1-hour window), call `get_quota_backoff_status` and route around it using the curated fallback in `provider_order`.

## Avoid

- Copy-pasting shared plugin logic into product repos
- Moving product doctrine into `aicoder-opencode`
- Adding extra OpenCode servers when one per repo is enough
- Large topology rewrites without verifying the next real maintenance path
- Overriding temperature manually (the plugin sets it from capability tier)
