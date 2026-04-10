import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTOPILOT_STALE_MILLISECONDS,
  AUTOPILOT_STALE_TASK_MILLISECONDS,
  MAX_AGENT_FAILURE_EVENTS,
  activeSlicePathFromPlan,
  checkpointNeedsWork,
  chooseAutopilotCheckpoint,
  normalizeNextStep,
  parseActiveSliceSummary,
  renderAutopilotService,
  renderAutopilotTimer,
  sessionIsStale,
  taskStartedIsStale,
  trimAgentFailureEvents,
} from "./helpers.mjs";

test("normalizeNextStep_when_none_returns_empty_string", () => {
  assert.equal(normalizeNextStep("none"), "");
});

test("activeSlicePathFromPlan_when_nested_plan_returns_active_slice_path", () => {
  assert.equal(
    activeSlicePathFromPlan("docs/plans/2026-04-09-sample/design.md"),
    "docs/plans/2026-04-09-sample/active-slice.md",
  );
});

test("parseActiveSliceSummary_extracts_status_and_next_step", () => {
  const summary = parseActiveSliceSummary("**Status:** done\n**Next Step:** none\n");
  assert.equal(summary.status, "done");
  assert.equal(summary.nextStep, "none");
});

test("checkpointNeedsWork_when_autonomous_done_and_no_next_step_returns_false", () => {
  assert.equal(
    checkpointNeedsWork(
      { autonomousIteration: true, status: "done", nextStep: "none" },
      { status: "done", nextStep: "none" },
    ),
    false,
  );
});

test("chooseAutopilotCheckpoint_prefers_latest_checkpoint_that_needs_work", () => {
  const chosen = chooseAutopilotCheckpoint(
    [
      { sessionID: "older", autonomousIteration: true, updatedAt: "2026-04-09T10:00:00.000Z", status: "in_progress" },
      { sessionID: "newer", autonomousIteration: true, updatedAt: "2026-04-09T11:00:00.000Z", status: "planned" },
      { sessionID: "done", autonomousIteration: true, updatedAt: "2026-04-09T12:00:00.000Z", status: "done", nextStep: "none" },
    ],
    new Map([["done", { status: "done", nextStep: "none" }]]),
  );
  assert.equal(chosen?.sessionID, "newer");
});

test("sessionIsStale_when_recently_updated_returns_false", () => {
  const now = 1_000_000;
  assert.equal(
    sessionIsStale({ updated: now - AUTOPILOT_STALE_MILLISECONDS + 1 }, now),
    false,
  );
});

test("taskStartedIsStale_when_older_than_threshold_returns_true", () => {
  const now = 2_000_000;
  assert.equal(
    taskStartedIsStale(now - AUTOPILOT_STALE_TASK_MILLISECONDS, now),
    true,
  );
});

test("trimAgentFailureEvents_when_events_exceed_limit_keeps_latest_events", () => {
  const failures = Array.from({ length: MAX_AGENT_FAILURE_EVENTS + 2 }, (_value, index) => ({ index }));

  const trimmedFailures = trimAgentFailureEvents(failures);

  assert.equal(trimmedFailures[0]?.index, 2);
});

test("renderAutopilotService_contains_execstart", () => {
  assert.match(renderAutopilotService("/repo"), /ExecStart=\/repo\/\.opencode\/bin\/dr-autopilot run-once/);
  assert.match(renderAutopilotService("/repo"), /TimeoutStartSec=900/);
});

test("renderAutopilotTimer_contains_timer_unit_name", () => {
  assert.match(renderAutopilotTimer(), /Unit=dr-autopilot\.service/);
});
