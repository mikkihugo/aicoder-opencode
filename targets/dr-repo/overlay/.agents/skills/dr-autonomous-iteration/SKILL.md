---
name: dr-autonomous-iteration
version: 2026-03-31.1
description: "Use when asked to work in a continuous loop until done or truly blocked. Orchestrates pickup, planning, TDD execution, implementation waves when needed, debugging side-chains, verification, and resume behavior."
---

# DR Autonomous Iteration

## Purpose

Use this skill when the user wants the work to proceed continuously until the task is complete or a real blocker is reached.

This is the orchestration skill for the repo's looped workflow.

Default interpretation:
- continue across multiple green slices without asking to continue again
- send short progress updates, but do not pause the loop just to summarize a clean checkpoint
- only stop when a listed stop condition is actually met

## Loop Shape

Default loop:
1. load `dr-session-pickup`
2. load `dr-repo-reference`
3. load `docs/AGENT_ROLES.md`
4. if no active plan exists and the task is clear enough to infer safely, use `planning_analyst` and `consumer_advocate` internally, then create or refresh the right plan artifacts before coding
5. if no active plan exists and the task is still not fully safe after the internal planning, user-advocate, and research pass, choose the safest reversible evidence-backed default, record the assumption, and continue
6. choose the next smallest meaningful slice
7. for any non-trivial slice, run one supportive/goal-shaping helper pass and one adversarial helper pass before committing to the approach
8. use `dr-design-and-planning` if the slice is not execution-ready
9. for non-trivial brownfield changes, create or refresh `docs/plans/YYYY-MM-DD-<change-slug>/proposal.md` and `design.md`
10. create or refresh `docs/plans/YYYY-MM-DD-<change-slug>/active-slice.md` when the slice is non-trivial
11. use `dr-generate-tasks` if the slice is planned but not task-ready
12. use `dr-spec-first-tdd` to establish the contract test and the first green slice
13. use `dr-wave-implementation` when the remaining work is multi-file, parallelizable, or needs review gates
14. use `dr-finish-and-verify` to verify the slice
15. if the user goal is repo-wide completion or production readiness, use `dr-production-readiness`
16. repeat until the task is done

Between cycles:
- send a short commentary update
- immediately choose the next slice unless a stop condition has been met
- do not treat "one bounded slice is now green" as completion of the overall request
- before a new non-trivial slice, make the partner/combatant disagreement explicit again if the risk profile changed
- do not leave "partner/combatant" abstract: use concrete helpers
- default supportive/goal-shaping helpers: `planning_analyst`, `consumer_advocate`, `codebase_explorer`
- default adversarial helpers: `critical_reviewer`, `security_reviewer`, `oracle`
- before moving on from a non-trivial green slice, run a post-change read-only pass with `verifier` by default or `critical_reviewer` when regression or proof risk is higher
- if a non-trivial slice skips helper passes, record the reason in the iteration checkpoint
- when the next action is unclear from the user-of-system point of view, consult `consumer_advocate` before treating the ambiguity as a blocker
- when confidence is not yet high, gather more evidence before interrupting the user: inspect the repo, reload active artifacts, use `documentation_researcher` for unstable external facts and adjacent problem-space research, and use one or two orthogonal specialists before choosing the default
- iterative research and specialist passes are allowed while confidence is still rising between passes; stop only when confidence plateaus and the issue remains unsolved
- if confidence keeps stalling, assume the slice is too broad or a foundation task is missing; shrink the slice or create the missing foundation task before doing more speculative work
- do not use multi-choice or paged user-question tools in this repo; if a question is still unavoidable, ask one concise plain-text question only for a destructive, irreversible, or materially preference-shaped decision
- if the remaining ambiguity is reversible, choose the safest evidence-backed default, record the assumption, and continue
- if the issue is still not solvable after the hard evidence, specialist, and research pass, park the blocked plan or slice explicitly, ask `roadmap_keeper` for the next highest-value slice, and continue there
- when external research produces a durable fact that will likely matter again, store it in `dr-memory` as `research-finding` with source and date so future sessions do not repeat the same search

## Failure Routing

Enter `dr-systematic-debugging` immediately when:
- RED fails for the wrong reason
- GREEN fails
- lint fails
- build fails
- runtime verification fails
- the observed behavior does not match the intended contract

After debugging resolves the blocker:
- return to the interrupted step
- rerun the failed verification
- continue the loop

## Skill Routing

Use additional specialized skills when needed:
- `dr-agent-windows` for any `dr-agent/` work
- `dr-portal-ui-and-handlers` for portal-heavy tasks
- `dr-security-review` for security-sensitive changes
- `dr-code-review` when a structured review or rebuttal is needed
- `dr-production-readiness` when the target is actual ship readiness rather than local slice completion

Use read-only subagents only when work is parallelizable:
- `portal_explorer`
- `reviewer`
- `security_reviewer`
- `windows_agent_reviewer`

Use them for a concrete purpose, not by reflex.
Prefer the cheaper/faster read-only specialists first for exploration and routine review.
Keep critical-path implementation local unless the work is clearly parallelizable and non-blocking.

Default cost bias:
- use `portal_explorer` for broad portal discovery before spending main-session time mapping routes/templates manually
- use `reviewer` for routine post-slice review, missing-tests review, and regression scanning
- reserve `windows_agent_reviewer` for real Windows-boundary uncertainty, not generic Go review
- reserve `security_reviewer` for security-sensitive slices and adversarial checks
- do not spend main-session depth on read-only mapping that a cheaper sidecar can do in parallel

Concrete mapping for non-trivial slices:
- `supportive/goal-shaping` means one helper that sharpens purpose, user impact, or missing evidence before edits
- `adversarial` means one helper that tries to break the current approach before edits
- `post-change review` means one helper that checks proof-of-completion or regression risk after the slice is green
- default trio when the risk is generic brownfield change:
  - before edits: `codebase_explorer` or `planning_analyst`
  - before edits: `critical_reviewer`
  - after green: `verifier`

Spawn `portal_explorer` when:
- the next slice depends on understanding a broad portal surface first
- route registration, middleware order, template wiring, SSE flow, or handler ownership is unclear
- planning would otherwise guess at the real execution path across handlers, templates, and tests

Spawn `windows_agent_reviewer` when:
- the slice touches `dr-agent/` and the next decision depends on validating Windows-only boundaries
- GOOS, service lifecycle, Registry, DPAPI, WMI, PowerShell, or Hyper-V assumptions could be wrong
- a Linux-local read of the code could create false confidence before editing or review acceptance

Spawn `security_reviewer` when:
- the slice crosses auth, sessions, CSRF, secrets, commands, database boundaries, or dangerous failover behavior
- you need an adversarial pass before accepting the design or implementation

Spawn `reviewer` when:
- a completed slice needs a parallel correctness, regression, or missing-tests pass
- you want a bounded read-only second opinion before moving to the next slice
- you want a cheaper sidecar to review a green slice while the main session starts the next mapping step

Do not spawn subagents when:
- the work is trivial and single-file
- the next step is a tightly coupled local edit that would be blocked on the subagent result
- the task is already well understood and a parallel read-only pass would only add latency
- the only reason to spawn is habit rather than a concrete cost or latency win

When subagents are used, fold their outputs back into the loop checkpoint:
- `Observed:` exact facts from code, tests, logs, traces, or the subagent report
- `Inferred:` the supported decision or risk
- `Proposed:` the next concrete local action
- `Reflection:` weakest remaining assumption after synthesis

Use `docs/CODEX_AGENT_POLICY.md` for the model and reasoning defaults behind each specialist.

## Checkpoint After Each Cycle

After each loop cycle, record:

```markdown
## Iteration Checkpoint

- Goal:
- Current slice:
- Observed:
- Inferred:
- Proposed:
- Confidence:
- Falsifier:
- Reflection:
- Verified:
- Blockers:
- Next step:
```

Record the checkpoint in `active-slice.md` first when one exists, then in the relevant plan or task artifact if needed.
Checkpointing is for continuity, not a reason to stop.

## Stop Conditions

Stop only when one of these is true:
- the requested task is complete and verified
- a production-readiness check shows the remaining blockers explicitly and the current iteration goal is complete
- the next step is destructive, irreversible, or materially preference-shaped and cannot be taken safely without explicit user input
- a real blocker prevents further progress
- the task would require a destructive or high-risk action needing explicit approval

Do not stop just because one slice is complete if the overall task is still in progress.
Do not stop just because verification passed for the current slice.
Do not stop just to ask whether to continue when the user already requested autonomous continuation.
Do not stop for reversible ambiguity; choose the best evidence-backed default and continue.

## Rules

- prefer the smallest next slice
- route failures into debugging, not guesswork
- resume the interrupted path after debugging
- do not claim completion without fresh verification
- if the repo area is ambiguous, start with `dr-session-pickup`
- use progress updates as telemetry, not handoff points
- confidence must be evidence-backed, not rhetorical
- treat external facts as unstable until verified; research them when they affect the next step
- prefer one more research pass over one more user interruption when the missing fact is discoverable
