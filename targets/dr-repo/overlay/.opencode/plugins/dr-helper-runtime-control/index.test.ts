import test from "node:test";
import assert from "node:assert/strict";

import { canLaunchHelperTask } from "../shared/helper-parallel-policy.ts";
import {
  extractTaskSessionIDFromOutput,
  helperTaskKey,
  isHelperTaskTerminalStatus,
  latestTaskByKey,
  normalizeHelperOutputBlockTimeout,
  normalizeHelperOutputMessageLimit,
  normalizeHelperSessionLimit,
  parseHelperSessionTitle,
  type HelperTaskState,
} from "./library.ts";

test("normalizeHelperSessionLimit_when_limit_is_too_large_clamps_limit", () => {
  assert.equal(normalizeHelperSessionLimit(100), 20);
});

test("normalizeHelperOutputMessageLimit_when_limit_is_too_large_clamps_limit", () => {
  assert.equal(normalizeHelperOutputMessageLimit(100), 50);
});

test("normalizeHelperOutputBlockTimeout_when_timeout_is_too_small_clamps_timeout", () => {
  assert.equal(normalizeHelperOutputBlockTimeout(200), 1000);
});

test("extractTaskSessionIDFromOutput_when_task_output_contains_session_id_returns_session_id", () => {
  assert.equal(
    extractTaskSessionIDFromOutput("task_id: ses_123ABC (for resuming)\n\n<task_result>done</task_result>"),
    "ses_123ABC",
  );
});

test("extractTaskSessionIDFromOutput_when_task_metadata_contains_session_id_returns_session_id", () => {
  assert.equal(
    extractTaskSessionIDFromOutput(
      [
        "Background task launched.",
        "",
        "<task_metadata>",
        "session_id: ses_28ddfc46affeXUnrM0DfU2sp8t",
        "task_id: bg_8c170215",
        "background_task_id: bg_8c170215",
        "</task_metadata>",
      ].join("\n"),
    ),
    "ses_28ddfc46affeXUnrM0DfU2sp8t",
  );
});

test("parseHelperSessionTitle_when_subagent_title_exists_extracts_description_and_agent", () => {
  assert.deepEqual(parseHelperSessionTitle("Explore portal codebase issues (@codebase_explorer subagent)"), {
    description: "Explore portal codebase issues",
    agent: "codebase_explorer",
  });
});

test("isHelperTaskTerminalStatus_when_status_is_completed_returns_true", () => {
  assert.equal(isHelperTaskTerminalStatus("completed"), true);
});

test("isHelperTaskTerminalStatus_when_status_is_running_returns_false", () => {
  assert.equal(isHelperTaskTerminalStatus("running"), false);
});

test("latestTaskByKey_when_multiple_same_tasks_exist_keeps_latest_entry", () => {
  const latestTask = {
    callID: "call_2",
    status: "completed",
    description: "Explore portal",
    agent: "codebase_explorer",
    startedAtMilliseconds: 2,
    taskOutput: null,
  };
  const tasksByKey = latestTaskByKey([
    latestTask,
    {
      callID: "call_1",
      status: "running",
      description: "Explore portal",
      agent: "codebase_explorer",
      startedAtMilliseconds: 1,
      taskOutput: null,
    },
  ] satisfies HelperTaskState[]);

  assert.equal(tasksByKey.get(helperTaskKey("codebase_explorer", "Explore portal"))?.callID, "call_2");
});

test("canLaunchHelperTask_when_heavy_reader_cap_hit_blocks_new_heavy_reader", () => {
  const launchDecision = canLaunchHelperTask("consumer_advocate", [
    {
      id: "act_1",
      agent: "long_context_reader",
      sessionID: "ses_123",
      startedAt: "2026-04-09T18:00:00.000Z",
      updatedAt: "2026-04-09T18:00:00.000Z",
      taskDescription: "Read subsystem broadly",
      tool: "task",
      status: "running",
      outputSnippet: null,
      blockerReason: null,
      ageSeconds: 5,
    },
  ]);

  assert.deepEqual(launchDecision, {
    allowed: false,
    reason: "heavy_reader cap already hit (1/1)",
    parallelClass: "heavy_reader",
    counts: {
      totalRunning: 1,
      byClass: {
        heavy_reader: 1,
        light_reader: 0,
        reviewer: 0,
        worker: 0,
        owner: 0,
      },
    },
  });
});

test("canLaunchHelperTask_when_same_helper_is_already_running_blocks_duplicate_launch", () => {
  const launchDecision = canLaunchHelperTask("codebase_explorer", [
    {
      id: "act_dup",
      agent: "codebase_explorer",
      sessionID: "ses_dup",
      startedAt: "2026-04-09T18:00:00.000Z",
      updatedAt: "2026-04-09T18:00:00.000Z",
      taskDescription: "Map portal ownership",
      tool: "task",
      status: "running",
      outputSnippet: null,
      blockerReason: null,
      ageSeconds: 10,
    },
  ]);

  assert.deepEqual(launchDecision, {
    allowed: false,
    reason: "codebase_explorer is already running for this session",
    parallelClass: "light_reader",
    counts: {
      totalRunning: 1,
      byClass: {
        heavy_reader: 0,
        light_reader: 1,
        reviewer: 0,
        worker: 0,
        owner: 0,
      },
    },
  });
});
