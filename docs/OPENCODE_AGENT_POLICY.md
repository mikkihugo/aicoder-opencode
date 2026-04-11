# OpenCode Agent Policy

This repo uses a repo-local OpenCode runtime split across wrapper, XDG config, plugin registration, and helper-agent prompts.
In this repo, `opencode` should resolve through [`.opencode/bin/opencode`](/home/mhugo/code/dr-repo/.opencode/bin/opencode), which forces `--pure` and preloads repo-required secret-backed MCP environment so global persona plugins do not bleed into DR work.
Repo-local helper commands live under [`.opencode/commands`](/home/mhugo/code/dr-repo/.opencode/commands). Use `/autopilot` to start autonomous iteration and enable the repo-local watchdog, `/repo-state` or `/plans` to inspect current execution state, `/stale-checkpoints` to find stalled work, `/autopilot-status` to inspect the watchdog, `/helper-activity` to inspect recent helper work, `/helper-sessions` to inspect helper child sessions and output snippets, `/helper-output` to fetch one helper transcript with optional short blocking, or `!dr-autopilot start` to enable the repo-local timer watchdog directly.
`dr-repo` no longer owns a separate visible maintenance web lane. The shared maintenance/control-plane OpenCode server lives in `aicoder-opencode` on `127.0.0.1:8080`. Run `make maintenance-autonomous-start` to seed a `dr-repo` maintenance session there, or `make maintenance-autonomous-service-start` to auto-seed it on login. `dr-autopilot` attaches resume cycles to that shared server when reachable instead of spawning an invisible local foreground run.

`.agents/skills` is the canonical source for repo workflow.
The repo-local wrapper and config files define runtime behavior:
- [`.opencode/bin/opencode`](/home/mhugo/code/dr-repo/.opencode/bin/opencode) isolates the repo runtime
- [`.opencode/xdg-config/opencode/opencode.json`](/home/mhugo/code/dr-repo/.opencode/xdg-config/opencode/opencode.json) carries repo-local MCP/runtime config
- [`.opencode/opencode.jsonc`](/home/mhugo/code/dr-repo/.opencode/opencode.jsonc) registers repo-local plugins
- [`.opencode/agents/`](/home/mhugo/code/dr-repo/.opencode/agents) defines helper agents, model routing, and permissions
Do not duplicate planning, TDD, debugging, or review workflow logic inside OpenCode-only prompts.

Repo-local OpenCode config stays focused on runtime support and helper behavior. Repo MCP access is provided through the repo wrapper plus repo-local XDG OpenCode config under `.opencode/xdg-config/`, so global persona plugins stay out while `MiniMax`, `exa`, and `DeepWiki` remain available.

## Core Principles

- Purpose is first. The point of helper agents and plugins is to serve the user-facing or system purpose, not to create generic agent activity.
- Purpose drives the rest: planning, tests, implementation, specialist consultation, verification, and stop conditions should all trace back to the purpose.
- This repo is about `dr-repo`, not about OpenCode itself. The runtime layer is support infrastructure only.
- Our DR workflow remains spec-first: purpose, consumer, contract, failing test, implementation, verification.
- Specialists are narrow helpers, not alternate owners of the task.
- For non-trivial design, review, and production-readiness decisions, use different model families when practical to reduce blind spots.

## Agent Design Rule

Use smaller, sharper helper roles.

- Give each helper one clear role.
- Keep role identity in the agent prompt.
- Keep scenario-specific instructions in `.agents`, the active slice, and the current task context.
- Do not overload one helper with planning, implementation, review, and research responsibilities at once.
- Prefer one primary specialist. Add a second specialist only when it closes a different blind spot.

## Reasoning Markers

For non-trivial planning, debugging, review, and production-readiness work, the synthesis should be explicit:

- `Observed:` facts from code, tests, docs, command output, or runtime evidence
- `Inferred:` reasoning supported by those facts
- `Proposed:` recommended next action or design choice
- `Confidence:` 0.0-1.0 plus a short reason
- `Falsifier:` what would prove the current view wrong
- `Reflection:` weakest assumption and the next check

Confidence is required when the next step depends on judgment rather than direct proof.
High confidence without a plausible falsifier is a smell.
High confidence should come from repo evidence, active artifacts, and research when the fact is unstable or external.
Adjacent research is valid when it raises confidence about scope, missing foundations, or the real user workflow rather than just repeating the same direct query.

Do not use multi-choice, paged, or auto-timeout user-question tools in this repo.
The local runtime cannot guarantee recommended-option ordering, default
selection, or a 10-second auto-pick. When ambiguity remains after repo
inspection, specialist consultation, and research:
- choose the safest evidence-backed reversible default
- record the assumption in the active slice or checkpoint
- park the blocked plan or slice and move to the next highest-value feature if
  the issue is still not solvable after the hard pass
- ask one concise plain-text question only for destructive, irreversible, or
  materially preference-shaped decisions

## Role Split

Keep these layers distinct:

- `.agents/skills`: shared DR workflow
- `docs/AGENT_ROLES.md`: canonical debate roles and optional specialist helper definitions
- `.opencode/bin/opencode`: runtime wrapper and isolation
- `.opencode/xdg-config/opencode/opencode.json`: repo-local MCP/runtime config
- `.opencode/opencode.jsonc`: repo-local plugin registration
- `.opencode/agents`: runtime helper agents and model selection

Partner and Combatant are reasoning roles.
They are not OpenCode agent names.

## Current OpenCode Helpers

| Agent | Primary Use | Model |
|-------|-------------|-------|
| `implementation_lead` | Purpose-holding owner for synthesis and edits | `opencode-go/glm-5.1` |
| `planning_analyst` | Read-only purpose, scope, contract, and task slicing | `kimi-for-coding/kimi-k2-thinking` |
| `architecture_consultant` | Read-only structural assumptions, boundaries, and simplification | `minimax/MiniMax-M2.7` |
| `reliability_consultant` | Read-only operational safety and production-readiness risk | `minimax/MiniMax-M2.7` |
| `oracle` | Read-only strategic advisor for repeated failed fixes, self-review, and high-cost tradeoffs | `kimi-for-coding/kimi-k2-thinking` |
| `implementation_worker` | Hard coding or debugging after the contract is clear | `ollama-cloud/glm-5.1` |
| `critical_reviewer` | Read-only correctness, regression, and missing-proof review | `ollama-cloud/qwen3.5:397b` |
| `security_reviewer` | Read-only security review for trust boundaries and dangerous paths | `kimi-for-coding/kimi-k2-thinking` |
| `codebase_explorer` | Cheap local ownership and execution-path mapping | `ollama-cloud/glm-4.7` |
| `long_context_reader` | Read-only broad subsystem evidence gatherer before a big design or refactor move | `opencode-go/mimo-v2-pro` |
| `consumer_advocate` | Read-only user-of-the-system check for workflow friction and hidden prerequisites | `opencode-go/mimo-v2-omni` |
| `roadmap_keeper` | Read-only milestone, next-slice, and artifact-coherence keeper | `minimax/MiniMax-M2.7` |
| `verifier` | Read-only regression and proof-of-completion checker | `ollama-cloud/qwen3-coder-next` |
| `documentation_researcher` | External docs, APIs, and authoritative references | `ollama-cloud/glm-4.7` |
| `documentation_writer` | Bounded summaries, plans, and supporting prose | `ollama-cloud/glm-4.7` |
| `small_change_worker` | Cheap bounded worker for small straightforward edits | `ollama-cloud/glm-4.7` |

## Current Model Split

- Implementation ownership and hard edits use GLM first: `opencode-go/glm-5.1`, then `ollama-cloud/glm-5.1`
- Fast bounded edits and local mapping use `ollama-cloud/glm-4.7`
- Review and verification use Qwen: `ollama-cloud/qwen3-coder-next` or `ollama-cloud/qwen3.5:397b`
- Partner and Combatant depth use Kimi directly: `kimi-for-coding/k2p5`, `kimi-for-coding/kimi-k2-thinking`
- Architecture and operational safety use direct MiniMax: `minimax/MiniMax-M2.7`, `minimax/MiniMax-M2.5`
- Oracle-style escalation uses Kimi thinking: `kimi-for-coding/kimi-k2-thinking`
- Whole-subsystem and long-context reading use Mimo: `opencode-go/mimo-v2-pro`, `opencode-go/mimo-v2-omni`
- Roadmap and execution-state coherence use `minimax/MiniMax-M2.7`
- Consumer workflow critique uses `opencode-go/mimo-v2-omni`

## Usage Guidance

Default sequence:
1. Use `.agents` skills to decide the workflow.
2. Keep the main session or `implementation_lead` responsible for ownership and synthesis.
3. Use helper agents only for bounded specialist work.

For unfamiliar or multi-component work, open with a short parallel evidence pass when it reduces rediscovery latency:
- pair `codebase_explorer` with `long_context_reader` when you need both local path mapping and broad subsystem evidence
- add `architecture_consultant` only if the next step depends on a structural assumption
- add `consumer_advocate` only if user workflow friction is central
- keep the opening pass read-only and capped at two or three specialists with different blind spots
- synthesize the evidence before deciding the plan or the next slice

Preferred pairings:

- `dr-design-and-planning` -> `planning_analyst`; add `architecture_consultant` when design risk is real
- repeated failed fixes, significant self-review, or high-cost tradeoff sanity check -> `oracle`
- `dr-production-readiness` -> `reliability_consultant`
- `dr-spec-first-tdd` -> `implementation_lead`; add `implementation_worker` only when the slice is genuinely hard
- `dr-code-review` -> `critical_reviewer`
- `dr-security-review` -> `security_reviewer`
- `dr-systematic-debugging` -> `implementation_lead`; add `architecture_consultant` after repeated failed fixes
- failover, rollout, incident, queue, retry, or release-safety work -> `reliability_consultant`
- broad subsystem read before a refactor or architecture call -> `long_context_reader`
- user workflow, onboarding, or operator-friction check -> `consumer_advocate`
- roadmap, next-slice ordering, or stale status/plan cleanup -> `roadmap_keeper`
- post-change proof or bounded regression rerun -> `verifier`
- external library or API lookup -> `documentation_researcher`
- cheap repo mapping -> `codebase_explorer`
- summary or supporting write-up -> `documentation_writer`

When the work is ambiguous, ask:
- what failure mode am I trying to reduce?
- what is the narrowest helper that answers that?

## Model Diversity Rule

When a decision matters and blind spots are expensive:

- strengthen with `Partner`
- attack with `Combatant`
- add one specialist only if it adds real evidence
- prefer at least two different model families across the main line and specialist checks

Example:
- main implementation on `opencode-go/glm-5.1`
- architecture check on `minimax/MiniMax-M2.7`
- broad subsystem read on `opencode-go/mimo-v2-pro`
- critical review on `ollama-cloud/qwen3.5:397b`
- security review on `kimi-for-coding/kimi-k2-thinking`
- verification rerun on `ollama-cloud/qwen3-coder-next`
- combatant pass on `kimi-for-coding/kimi-k2-thinking`

Do not create diversity for its own sake on tiny tasks. Use it where disagreement or blind spots are likely.

## Canonical Active Slice

For non-trivial brownfield work, keep one active working artifact:

`docs/plans/YYYY-MM-DD-<change-slug>/active-slice.md`

That file should be the first place an agent looks for:
- current purpose
- consumer
- value at risk
- current slice
- required verification
- next step
- open risks
- `Observed:`
- `Inferred:`
- `Proposed:`
- `Confidence:`
- `Falsifier:`
- `Reflection:`

Do not create a separate drifting thoughts file.
If a reflection pass would help, use `build_reflection_packet`, ask one narrow helper or different model family to work on that packet, and fold the useful result back into the active artifact.

## Local Plugin Stack

The repo uses local OpenCode plugins for runtime behavior, not workflow ownership:

- `dr-checkpoints`
- `dr-plan-context`
- `dr-context-compaction`
- `dr-session-continuation`
- `dr-verification-guard`
- `dr-json-error-recovery`
- `dr-helper-runtime-control`
- `dr-agent-babysitter`
- `dr-specialist-routing`
- `dr-memory`
- `dr-public-code-search`
- `dr-ast-grep-search`

These plugins read and write `.opencode/state/` and exist to reinforce the DR workflow already defined in `.agents`.

Useful runtime tools from that stack:

- `suggest_specialist_helpers`: recommend the narrowest helper agents for the current failure mode
- `list_specialist_helpers`: inspect the repo-local helper catalog and current model assignments
- `load_active_plan_context`: reload the active plan artifact for the current session
- `load_active_slice_context`: reload the active slice beside the active plan
- `show_verification_status`: inspect recorded verification evidence for the current session
- `show_helper_sessions`: inspect recent helper child sessions and their latest assistant text snippets
- `show_helper_output`: inspect one helper child session transcript, optionally with bounded blocking while it is still running
- `show_unstable_helpers`: inspect helpers that have failed repeatedly in the current session
- `show_helper_activity`: inspect recent running, failed, and completed helper tasks in the current session
- `evaluate_slice_completion`: check whether the current slice is actually done
- `memory_list_types`: inspect the allowed DR memory categories
- `memory_remember`: persist durable cross-session knowledge
- `memory_record_outcome`: persist structured feature outcomes, smoke regressions, user friction findings, and runbook learnings
- `memory_ingest_pending_outcomes`: ingest durable pending outcome files left by shell automation under `.opencode/state/pending-outcomes/`
- `memory_recall`: semantically or lexically recall durable knowledge
- `memory_sync`: refresh QMD indexing or embeddings for DR memory
- `memory_forget`: remove stale or wrong durable memory
- `grep_app_search`: best-effort public code-pattern search through grep.app, with canonical search URL fallback when server-side access is blocked
- `ast_grep_search`: local syntax-aware code search for handlers, methods, hooks, and other structural patterns that plain text grep misses

`dr-helper-runtime-control` is the hard runtime guard:
- it enforces helper fanout caps for `task` launches at execution time
- it blocks relaunching an unstable helper when session-local fallback policy says to prefer a different read-only helper or retry later after provider/model instability
- it exposes helper child sessions so recent helper output is inspectable without scraping the whole parent transcript
- it exposes bounded helper transcript reads so you can inspect one running or finished helper without waiting blind
- it intentionally does not fake an in-process task cancel primitive that OpenCode does not actually expose

`dr-agent-babysitter` is session-local:
- it records repeated helper failures in `.opencode/state/agent-health/`
- it warns when a helper is unstable for the current session
- it classifies provider/model instability separately from ordinary helper failures
- `dr-specialist-routing` will avoid an unstable helper when a stable alternative exists

`dr-memory` is for long-lived recall only.
Use it to retain durable external research as `research-finding` when an upstream fact, API behavior, or documentation conclusion is likely to matter again.
Use `memory_record_outcome` for durable:
- `feature-outcome`
- `smoke-regression`
- `user-friction-finding`
- `runbook-learning`
Shell automation may stage durable smoke or feature findings under `.opencode/state/pending-outcomes/`; use `memory_ingest_pending_outcomes` to promote them into searchable memory once they are worth keeping.
The shell bridge for that path is [`.opencode/bin/dr-memory-queue-outcome`](/home/mhugo/code/dr-repo/.opencode/bin/dr-memory-queue-outcome). The staging and Hetzner smoke wrappers use it automatically on failed smoke runs, and they can also queue an explicit `feature-outcome` when a smoke gate proves a user-visible change.
Use `grep_app_search` only for public implementation pattern pressure, not for canonical truth. Prefer repo evidence first, then official docs, then public code examples when needed.
Do not store:
- current slice state
- next steps
- active plan details
- secrets or tokens
- customer-specific sensitive data
- raw run logs or every transient smoke pass/fail event

Keep current execution state in checkpoints, `STATUS.md`, `ROADMAP.md`, and `active-slice.md`.

The strongest `micode` patterns adopted here are:

- continuity ledgers under `.opencode/state/ledgers/`
- searchable prior artifacts across `docs/plans/...` and continuity ledgers
- context injection from the repo constitution plus the active plan/checkpoint state

The OpenAgent ULW pattern influenced these plugins in one narrow way:
- explicit planning
- execution from an active plan
- continuation until done or truly blocked
- carried-forward context
- verification pressure

The repo does not adopt OpenAgent naming, `.sisyphus` artifacts, or a second orchestration system.

## Infrastructure Issue Tracking

Do not use GitHub Issues as the default tracking system for OpenCode/runtime/deployment support work in this repo.

Use:
- [`.opencode/INFRASTRUCTURE_ISSUES.md`](/home/mhugo/code/dr-repo/.opencode/INFRASTRUCTURE_ISSUES.md) for support-infrastructure issues that affect repo execution, verification, deployment, or operator workflows

Do not use that file for:
- product backlog
- feature ideas
- broad architecture wishes
- drifting notes

Keep entries evidence-backed, short, and actionable.
If an issue is no longer real, remove it or mark it resolved in the file instead of letting it drift.

## DR Autonomous Iteration Mode

When a user says `ulw`, `ultrawork`, `keep going until done`, or otherwise asks for a continuous loop, interpret that as DR autonomous iteration:

1. recover or record the active checkpoint
2. clarify only if the next significant decision is still ambiguous
3. create or refresh the active `docs/plans/...` artifact when the slice is not yet execution-ready
4. create or refresh `active-slice.md` when the slice is non-trivial
5. generate or refresh task slices
6. write the failing test first for behavior changes
7. implement and verify the current slice
8. continue to the next slice until the work is done or truly blocked

This is not a free-form “max mode.”
It is a purpose-driven loop constrained by:

- spec-first TDD
- the active plan artifact
- verification evidence
- explicit stop conditions

The `dr-session-continuation` plugin exists to reinforce that loop, not replace it.

## Stop Conditions

Do not add a separate `.opencode/oh-my-openagent.json[c]` plugin layer unless native OpenCode proves insufficient.

A plugin is justified only when the repo needs behavior that native `opencode.json` cannot express, such as:

- required continuation hooks
- automatic context compaction/recovery
- a task orchestration feature that native helpers cannot approximate

Until then, keep the runtime simple:
- one canonical skill surface
- one native OpenCode config
- self-documenting helper names
