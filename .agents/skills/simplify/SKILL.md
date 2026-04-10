---
name: simplify
description: Post-implementation review — launch three parallel reviewers (reuse, quality, efficiency) over recent control-plane changes and synthesize a ranked fix list
user-invocable: true
models:
  - ollama-cloud/kimi-k2-thinking
  - ollama-cloud/glm-5.1
  - ollama-cloud/minimax-m2.7
routing_role: reviewer
routing_complexity: medium
---

# simplify

Review recent changes across the aicoder-opencode control plane for reuse,
quality, and efficiency, then fix what is worth fixing.

Use this skill after an implementation pass that touched:
- shared plugins in `src/plugins/`
- shared skills in `.agents/skills/`
- overlay agents, prompts, or launchers under `targets/*/overlay/.opencode/`
- autopilot loops, bash shims in `bin/`, or `opencode.jsonc`

## Responsibilities

- Identify the changeset to review.
- Launch three review subagents in parallel, each with a distinct lens.
- Aggregate findings into a ranked fix list.
- Apply the fixes directly, or record why a finding was skipped.

## Contract

- Input: a recent diff or an explicit set of changed files.
- Output: a synthesized list of findings grouped by lens, ranked by impact, and
  a fix log describing what was changed versus what was skipped and why.
- Never argue with a reviewer finding in the synthesis — either fix it or skip
  it with a one-line reason.

## Phase 1: Identify Changes

Run `git diff` (or `git diff HEAD` if changes are staged) to capture the
changeset. If the working tree is clean, review the files the user named or the
files edited earlier in the current session. For overlay work, include both the
shared source under `src/plugins/` or `.agents/skills/` and the installed shim
under `targets/*/overlay/.opencode/`.

## Phase 2: Launch Three Reviewers In Parallel

Dispatch all three reviewers in a single batch. Pass each one the full diff
plus the paths of any ambient files it needs to cross-reference (registry,
sibling plugins, sibling agents).

### Reviewer 1: Code Reuse

1. Search for existing utilities, plugin hooks, tools, or shared skill sections
   that the change re-implements. Common locations: `src/plugins/`,
   `.agents/skills/control-plane-*-base/`, sibling overlay agents under
   `targets/*/overlay/.opencode/agents/`.
2. Flag any new function, tool, or agent block that duplicates an existing one.
   Name the existing artifact to reuse.
3. Flag hardcoded model IDs where `model-registry` (`list_curated_models`,
   `select_models_for_role`) should be called instead.
4. Flag duplicated routing logic across `control-plane-specialist-routing` and
   per-overlay agent frontmatter — these should resolve through the shared
   registry, not forked copies.
5. Flag re-implemented quota / provider backoff logic — it belongs in the
   `model-registry` plugin.

### Reviewer 2: Code Quality

1. Redundant state across plugin singletons, overlay status files, and
   autopilot session-id files.
2. Parameter sprawl on plugin-exposed tools and agent `models:` metadata.
3. Copy-paste across sibling overlay agent markdown — unify via the shared
   base skill.
4. Leaky abstractions: overlay shims reaching into shared plugin internals
   instead of calling exported hooks.
5. Stringly-typed provider / model / role identifiers where registry enums or
   literal unions already exist.
6. Over-broad agent tool permissions — `tools:` grants that exceed what the
   agent actually invokes.
7. Dead or commented-out agent frontmatter, stale `models:` fallbacks, or
   doctrine paragraphs that narrate the change instead of stating the rule.
8. Comments that restate the code; keep only non-obvious "why" (quota quirks,
   provider gotchas, User-Agent gating, etc.).

### Reviewer 3: Efficiency

1. Redundant subagent spawns — orchestrators that launch a reviewer when a
   shared skill section already answers the question.
2. Unnecessary tool calls per iteration: repeated `get_quota_backoff_status`,
   repeated `list_curated_models`, re-reading unchanged config files.
3. Oversized contexts — agents handed the whole repo tree when a scoped path
   would do; prompts that inline large reference material already available
   as a shared skill.
4. Missed concurrency: sequential overlay installs or sequential reviewer
   dispatch where parallel is safe.
5. Hot-path bloat in autopilot loops — blocking work added to the timer cycle
   that should run once at session start.
6. Recurring no-op writes to `state/autopilot/status.json` or session-id files
   when nothing changed.
7. TOCTOU existence checks before reading overlay files — operate and handle
   the error.
8. Tight retry loops on 429 inside a single session — backoff belongs to the
   registry plugin across sessions, not inline retry.

## Phase 3: Synthesize And Fix

- Wait for all three reviewers.
- Merge findings, drop duplicates, rank by impact (correctness > reuse >
  efficiency > cosmetic).
- Apply each fix directly. If a finding is a false positive or out of scope,
  record it as skipped with a one-line reason.
- When finished, report what was fixed, what was skipped, and confirm whether
  the changeset is now clean.

## Avoid

- Launching reviewers sequentially.
- Arguing with a reviewer in the synthesis instead of fixing or skipping.
- Rewriting shared plugins from a single overlay finding — promote the fix to
  the shared base once, then re-install shims.
- Overriding model, temperature, or provider choice inline to "simplify" —
  that belongs to the `model-registry` plugin.
- Expanding the review scope beyond the identified changeset.
