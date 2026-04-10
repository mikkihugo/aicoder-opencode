import test from "node:test";
import assert from "node:assert/strict";

import {
  listRecentAgentActivities,
  listUnstableAgents,
  resolveHelperLaunchFallback,
  type SessionAgentHealthRecord,
} from "../shared/session-agent-health.ts";

test("listUnstableAgents_when_agent_repeats_failures_marks_agent_unstable", () => {
  const health: SessionAgentHealthRecord = {
    sessionID: "ses_123",
    updatedAt: "2026-04-09T18:00:00.000Z",
    activities: [],
    failures: [
      {
        agent: "codebase_explorer",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T17:50:00.000Z",
        reason: "task hit a permission boundary",
        taskDescription: "Explore portal codebase issues",
        tool: "task",
      },
      {
        agent: "codebase_explorer",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T17:55:00.000Z",
        reason: "task returned an error",
        taskDescription: "Explore portal codebase issues again",
        tool: "task",
      },
    ],
  };

  const unstableAgents = listUnstableAgents(health, Date.parse("2026-04-09T18:00:00.000Z"));

  assert.deepEqual(unstableAgents, [
    {
      agent: "codebase_explorer",
      failureCount: 2,
      lastFailureAt: "2026-04-09T17:55:00.000Z",
      lastTaskDescription: "Explore portal codebase issues again",
      reasons: ["task hit a permission boundary", "task returned an error"],
      failureClasses: ["permission_boundary", "runtime_error"],
      fallbackAgent: "long_context_reader",
      recoveryHint: "Prefer long_context_reader for this blind spot in the current session.",
    },
  ]);
});

test("listUnstableAgents_when_failures_are_old_returns_empty_array", () => {
  const health: SessionAgentHealthRecord = {
    sessionID: "ses_123",
    updatedAt: "2026-04-09T18:00:00.000Z",
    activities: [],
    failures: [
      {
        agent: "codebase_explorer",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T16:00:00.000Z",
        reason: "task hit a permission boundary",
        taskDescription: "Explore portal codebase issues",
        tool: "task",
      },
      {
        agent: "codebase_explorer",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T16:05:00.000Z",
        reason: "task returned an error",
        taskDescription: "Explore portal codebase issues again",
        tool: "task",
      },
    ],
  };

  const unstableAgents = listUnstableAgents(health, Date.parse("2026-04-09T18:00:00.000Z"));

  assert.deepEqual(unstableAgents, []);
});

test("listRecentAgentActivities_when_running_activity_has_later_failure_marks_it_failed", () => {
  const health: SessionAgentHealthRecord = {
    sessionID: "ses_123",
    updatedAt: "2026-04-09T18:00:00.000Z",
    activities: [
      {
        id: "act_1",
        agent: "codebase_explorer",
        sessionID: "ses_123",
        startedAt: "2026-04-09T17:50:00.000Z",
        updatedAt: "2026-04-09T17:50:00.000Z",
        taskDescription: "Explore portal codebase issues",
        tool: "task",
        status: "running",
        outputSnippet: null,
        blockerReason: null,
      },
    ],
    failures: [
      {
        agent: "codebase_explorer",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T17:55:00.000Z",
        reason: "task exceeded stale-task threshold and was reaped by dr-autopilot",
        taskDescription: "Explore portal codebase issues",
        tool: "task",
      },
    ],
  };

  const activities = listRecentAgentActivities(health, Date.parse("2026-04-09T18:00:00.000Z"));

  assert.deepEqual(activities, [
    {
      id: "act_1",
      agent: "codebase_explorer",
      sessionID: "ses_123",
      startedAt: "2026-04-09T17:50:00.000Z",
      updatedAt: "2026-04-09T17:55:00.000Z",
      taskDescription: "Explore portal codebase issues",
      tool: "task",
      status: "failed",
      outputSnippet: null,
      blockerReason: "task exceeded stale-task threshold and was reaped by dr-autopilot",
      ageSeconds: 300,
    },
  ]);
});

test("listUnstableAgents_when_provider_runtime_errors_repeat_adds_recovery_hint", () => {
  const health: SessionAgentHealthRecord = {
    sessionID: "ses_123",
    updatedAt: "2026-04-09T18:00:00.000Z",
    activities: [],
    failures: [
      {
        agent: "oracle",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T17:50:00.000Z",
        reason: "task hit a provider or model runtime failure",
        taskDescription: "Need a second opinion on the tradeoff",
        tool: "task",
      },
      {
        agent: "oracle",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T17:55:00.000Z",
        reason: "task hit a provider or model runtime failure",
        taskDescription: "Need a second opinion on the tradeoff",
        tool: "task",
      },
    ],
  };

  const unstableAgents = listUnstableAgents(health, Date.parse("2026-04-09T18:00:00.000Z"));

  assert.deepEqual(unstableAgents, [
    {
      agent: "oracle",
      failureCount: 2,
      lastFailureAt: "2026-04-09T17:55:00.000Z",
      lastTaskDescription: "Need a second opinion on the tradeoff",
      reasons: ["task hit a provider or model runtime failure"],
      failureClasses: ["provider_runtime_error"],
      fallbackAgent: null,
      recoveryHint:
        "Keep the same blind spot, but retry later or switch to a different helper/model lineage than oracle.",
    },
  ]);
});

test("resolveHelperLaunchFallback_when_read_only_helper_has_fallback_prefers_fallback", () => {
  const health: SessionAgentHealthRecord = {
    sessionID: "ses_123",
    updatedAt: "2026-04-09T18:00:00.000Z",
    activities: [],
    failures: [
      {
        agent: "codebase_explorer",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T17:50:00.000Z",
        reason: "task hit a permission boundary",
        taskDescription: "Explore portal codebase issues",
        tool: "task",
      },
      {
        agent: "codebase_explorer",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T17:55:00.000Z",
        reason: "task returned an error",
        taskDescription: "Explore portal codebase issues again",
        tool: "task",
      },
    ],
  };

  const decision = resolveHelperLaunchFallback(
    "codebase_explorer",
    health,
    Date.parse("2026-04-09T18:00:00.000Z"),
  );

  assert.deepEqual(decision, {
    requestedAgent: "codebase_explorer",
    effectiveAgent: "long_context_reader",
    action: "prefer_fallback",
    fallbackAgent: "long_context_reader",
    reason: "task hit a permission boundary",
    recoveryHint: "Prefer long_context_reader for this blind spot in the current session.",
  });
});

test("resolveHelperLaunchFallback_when_provider_runtime_error_repeats_returns_retry_later", () => {
  const health: SessionAgentHealthRecord = {
    sessionID: "ses_123",
    updatedAt: "2026-04-09T18:00:00.000Z",
    activities: [],
    failures: [
      {
        agent: "oracle",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T17:50:00.000Z",
        reason: "task hit a provider or model runtime failure",
        taskDescription: "Need a second opinion on the tradeoff",
        tool: "task",
      },
      {
        agent: "oracle",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T17:55:00.000Z",
        reason: "task hit a provider or model runtime failure",
        taskDescription: "Need a second opinion on the tradeoff",
        tool: "task",
      },
    ],
  };

  const decision = resolveHelperLaunchFallback("oracle", health, Date.parse("2026-04-09T18:00:00.000Z"));

  assert.deepEqual(decision, {
    requestedAgent: "oracle",
    effectiveAgent: "oracle",
    action: "retry_later",
    fallbackAgent: null,
    reason: "task hit a provider or model runtime failure",
    recoveryHint:
      "Keep the same blind spot, but retry later or switch to a different helper/model lineage than oracle.",
  });
});

test("resolveHelperLaunchFallback_when_worker_helper_is_unstable_allows_same_agent", () => {
  const health: SessionAgentHealthRecord = {
    sessionID: "ses_123",
    updatedAt: "2026-04-09T18:00:00.000Z",
    activities: [],
    failures: [
      {
        agent: "implementation_worker",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T17:50:00.000Z",
        reason: "task returned an error",
        taskDescription: "Implement the refactor slice",
        tool: "task",
      },
      {
        agent: "implementation_worker",
        sessionID: "ses_123",
        detectedAt: "2026-04-09T17:55:00.000Z",
        reason: "task returned an error",
        taskDescription: "Implement the refactor slice",
        tool: "task",
      },
    ],
  };

  const decision = resolveHelperLaunchFallback(
    "implementation_worker",
    health,
    Date.parse("2026-04-09T18:00:00.000Z"),
  );

  assert.deepEqual(decision, {
    requestedAgent: "implementation_worker",
    effectiveAgent: "implementation_worker",
    action: "allow",
    fallbackAgent: null,
    reason: "task returned an error",
    recoveryHint: null,
  });
});

test("listRecentAgentActivities_when_completed_activity_exists_keeps_terminal_state", () => {
  const health: SessionAgentHealthRecord = {
    sessionID: "ses_123",
    updatedAt: "2026-04-09T18:00:00.000Z",
    activities: [
      {
        id: "act_1",
        agent: "long_context_reader",
        sessionID: "ses_123",
        startedAt: "2026-04-09T17:52:00.000Z",
        updatedAt: "2026-04-09T17:58:00.000Z",
        taskDescription: "Read subsystem broadly",
        tool: "task",
        status: "completed",
        outputSnippet: "Summarized the relevant subsystem evidence.",
        blockerReason: null,
      },
    ],
    failures: [],
  };

  const activities = listRecentAgentActivities(health, Date.parse("2026-04-09T18:00:00.000Z"));

  assert.deepEqual(activities, [
    {
      id: "act_1",
      agent: "long_context_reader",
      sessionID: "ses_123",
      startedAt: "2026-04-09T17:52:00.000Z",
      updatedAt: "2026-04-09T17:58:00.000Z",
      taskDescription: "Read subsystem broadly",
      tool: "task",
      status: "completed",
      outputSnippet: "Summarized the relevant subsystem evidence.",
      blockerReason: null,
      ageSeconds: 120,
    },
  ]);
});
