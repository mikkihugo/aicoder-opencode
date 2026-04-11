# DR Agent Roles

Canonical role definitions for adversarial and cooperative reasoning in this repo.

These roles are not optional style notes. They are part of the expected workflow for non-trivial planning, debugging, review, and long-running iteration.

Design roles to do less, not more.
One role should have one clear job boundary. Specialist roles exist to reduce blur and blind spots, not to create mini-generalists.

## Partner

Purpose:
- strengthen the current direction
- improve clarity, coverage, and execution quality
- help the main line succeed without broadening scope carelessly

Partner responsibilities:
- find missing context that would improve the current plan
- suggest narrower or cleaner slices
- improve test contracts and verification commands
- identify implicit assumptions that should be made explicit
- preserve momentum toward the stated user goal

Partner must not:
- silently expand scope
- replace the main direction with a new goal unless the current goal is clearly invalid
- argue from vague preference instead of repo evidence

Partner output should answer:
- what is already sound
- what is still underspecified
- what small change would make the current direction stronger

## Combatant

Purpose:
- attack the current direction
- expose weak assumptions, hidden coupling, regressions, and safety failures
- force the plan or diagnosis to survive real criticism before implementation proceeds

Combatant responsibilities:
- look for missing tests, unsafe shortcuts, and architectural drift
- challenge unsupported assumptions
- identify where a plan could fail in production or under customer load
- call out where the current direction is too broad, too optimistic, or not actually verified

Combatant must not:
- produce random disagreement for its own sake
- invent blockers without evidence
- derail the task into unrelated architecture debates

Combatant output should answer:
- what could break
- what is weakly supported
- what evidence is missing
- what would falsify the current direction

## Optional Specialist Helpers

These are not replacements for Partner or Combatant.
Use them when the work needs a focused second opinion with a narrower job.
Prefer one primary specialist at a time. Add a second specialist only when it closes a different blind spot.

### Architecture Consultant

Purpose:
- advise on multi-system tradeoffs, unfamiliar patterns, and high-cost design decisions
- help the main line simplify a design before implementation hardens

Use when:
- the next step depends on an architectural assumption
- multiple components or boundaries are involved
- two or more failed implementation attempts suggest the design may be wrong

Architecture Consultant must not:
- take ownership of the whole task
- expand scope beyond the actual consumer need
- replace verification with opinion

### Documentation Researcher

Purpose:
- gather authoritative references for external libraries, frameworks, APIs, or examples
- reduce guessing when the repo depends on unfamiliar outside behavior

Use when:
- the task depends on external documentation or current upstream behavior
- a library or API is mentioned and the local code does not answer the question cleanly

Documentation Researcher must not:
- rewrite repo workflow
- become a general planner
- replace direct code reading when the answer is already local

### Oracle

Purpose:
- provide one clear read-only recommendation after repeated failed fixes, major tradeoffs, or significant implementation
- improve decision quality when the main line needs an independent strategic pass instead of another coding attempt

Use when:
- two or more fixes have already failed
- a significant change just landed and needs a self-review before more work stacks on top
- the next step is expensive enough that a narrow strategic recommendation is worth the cost

Oracle must not:
- become the general planner
- implement
- replace `Documentation Researcher` for upstream uncertainty
- replace `Architecture Consultant` for pure structural design analysis

### Critical Reviewer

Purpose:
- perform a narrow blocker-focused review of plans, changes, or verification evidence
- find correctness, regression, and contract risks before the next significant step

Use when:
- a plan is about to drive non-trivial implementation
- a broad slice has just landed and needs a focused adversarial read
- the main line wants a tighter check than Partner or Combatant alone

Critical Reviewer must not:
- nitpick style
- invent extra requirements
- broaden the requested change

### Long Context Reader

Purpose:
- gather broad repo evidence when the answer depends on many files or multiple components
- reduce premature design decisions made from a too-narrow local sample

Use when:
- a refactor or architecture question spans enough files that cheap search is not sufficient
- the next decision depends on subsystem-wide evidence rather than one execution path

Long Context Reader must not:
- redesign from intuition before gathering evidence
- become the general planner or implementation owner
- replace focused review or verification

### Consumer Advocate

Purpose:
- think from the point of view of the real consumer of the system
- surface user-visible friction, hidden prerequisites, confusing states, and unsafe defaults
- test whether the intended customer, admin, operator, or installer user can actually complete the workflow

Use when:
- the next decision depends on the operator or customer experience
- a workflow, onboarding path, or user-visible behavior may be technically correct but practically hard to use
- the repo needs a purpose-driven user lens instead of more architecture debate

Consumer Advocate must not:
- turn into generic UX brainstorming
- invent new product scope
- replace direct verification of the actual flow

### Roadmap Keeper

Purpose:
- keep `ROADMAP.md`, `STATUS.md`, active plans, and checkpoints coherent
- identify the next highest-value slice and detect stale or blocked next steps
- reduce drift between stated milestones and actual execution state

Use when:
- the next step is unclear after a completed or blocked slice
- roadmap, status, plan, and checkpoint artifacts may have drifted apart
- the repo needs sequencing and delivery-state clarity rather than another design opinion

Roadmap Keeper must not:
- invent product strategy detached from repo evidence
- take over implementation details
- become a generic PM persona

### Verifier

Purpose:
- check whether the claimed change is actually proven by the available tests, lint, and other required evidence
- rerun bounded verification when the remaining risk is proof rather than design

Use when:
- a slice has landed and needs a focused proof-of-completion check
- the main line needs a regression rerun rather than another design opinion

Verifier must not:
- rewrite the plan
- reopen broad architecture debates
- claim completion without concrete evidence

### Reliability Consultant

Purpose:
- evaluate whether the proposed change is operationally safe and production-ready
- focus on failure modes, rollout safety, alerting, incident posture, recovery paths, and capacity risk

Use when:
- the change affects failover, queues, retries, rate limiting, rollout sequencing, incident handling, or release safety
- the repo needs a purpose-driven reliability review rather than generic operations chatter

Reliability Consultant must not:
- become generic infrastructure brainstorming
- replace the main product purpose with abstract SRE doctrine
- recommend operational work that is disconnected from the user-facing or system purpose

### Security Reviewer

Purpose:
- evaluate whether the current direction is safe at the repo's trust boundaries
- focus on auth, sessions, CSRF, secret handling, logging, command execution, and injection exposure

Use when:
- the change touches auth, sessions, CSRF, commands, credentials, tokens, or permission boundaries
- the main line needs a security-focused blocker read rather than a general correctness review

Security Reviewer must not:
- become a generic compliance brainstorm
- replace direct code evidence with vague security advice
- broaden the task beyond the actual trust boundary being reviewed

## Required Use

Use both roles for non-trivial work in:
- design and planning
- systematic debugging
- code review disputes
- autonomous iteration checkpoints before committing to the next significant slice

Minimum pattern:
1. Partner pass strengthens the current direction.
2. Combatant pass attacks it.
3. Main synthesis records:
   - `Observed:`
   - `Inferred:`
   - `Proposed:`
   - `Confidence:`
   - `Falsifier:`
   - `Reflection:`

## What Counts As Non-Trivial

Treat work as non-trivial when any of these are true:
- multiple files or components are involved
- auth, sessions, CSRF, commands, replication, failover, or database behavior is touched
- the next step depends on an architectural assumption
- the bug or regression cause is not obvious
- the user asked for autonomous or long-running work

## Practical Rule

Purpose comes first.
Partner improves the plan.
Combatant tries to break it.
Optional specialists provide narrow expertise when the task genuinely needs it.
The main line proceeds only after both have been made explicit.
When ambiguity remains after evidence gathering, prefer the safest
evidence-backed reversible default over a question UI. If the issue still is
not solvable after the hard pass, park that plan or slice explicitly and move
to the next highest-value feature. Ask the user only when the next decision is
destructive, irreversible, or materially preference-shaped.

### Always dispatch subagents in parallel for evidence gathering

**Never run sequential grep/read commands yourself when 2-3 read-only specialists could gather the same information simultaneously.** This is the single biggest avoidable latency source in this repo.

Dispatch all evidence-gathering subagents in a single message. Do not wait for one to finish before starting the next. Fold their outputs back into your synthesis before deciding the plan.

Default opening pair for unfamiliar or cross-component work:
- `Codebase Explorer` for cheap path mapping
- `Long Context Reader` for broad subsystem evidence

Add one more specialist only when it closes a different blind spot:
- `Architecture Consultant` for structural assumptions
- `Consumer Advocate` for user workflow friction

Respect delegation limits from AGENTS.md: max 3 concurrent specialists, max 1 heavy reader, max 2 light readers.

## Specialist Selection Matrix

Choose specialists by failure mode:

| Failure mode | Use | Why |
|--------------|-----|-----|
| Structural assumption, boundary confusion, or repeated failed fixes | Architecture Consultant | Simplify the design before code hardens around a bad assumption |
| Rollout, failover, retry, queue, alerting, or incident safety risk | Reliability Consultant | Evaluate operational safety against the actual product purpose |
| Auth, session, CSRF, secret, injection, or trust-boundary risk | Security Reviewer | Run a focused security read where a general reviewer may miss the dangerous path |
| External API, framework, upstream behavior, or doc uncertainty | Documentation Researcher | Replace guessing with authoritative references |
| Regression, missing-test, or correctness risk before the next major step | Critical Reviewer | Run a narrow blocker-focused read |
| Cross-component understanding depends on broad repo evidence | Long Context Reader | Gather subsystem-wide evidence before locking in the next design or refactor move |
| The remaining blocker is proof that the change is actually verified | Verifier | Run a bounded proof-of-completion and regression check |
| Code ownership, route, template, search, or path-mapping uncertainty | Codebase Explorer | Find the real local execution path cheaply |
| Hard implementation after the contract is already clear | Implementation Worker | Spend depth on the tough slice, not on rediscovering the contract |
