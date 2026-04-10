import test from "node:test";
import assert from "node:assert/strict";

import { evaluateSliceCompletion, summarizeCheckpoint } from "./index.ts";

test("evaluateSliceCompletion_when_status_is_parked_reports_parked_state", () => {
  const completion = evaluateSliceCompletion(
    {
      sessionID: "ses_parked",
      status: "parked",
      parkedReason: "Missing shared auth foundation",
      blockedBy: "auth middleware parity",
      nextFeature: "portal login smoke hardening",
      updatedAt: "2026-04-09T20:00:00.000Z",
      verification: [],
    },
    null,
  );

  assert.equal(completion.likelyComplete, false);
  assert.equal(completion.isParked, true);
  assert.equal(completion.parkedReason, "Missing shared auth foundation");
  assert.match(completion.completionReason, /intentionally parked/i);
});

test("summarizeCheckpoint_when_parked_fields_are_present_includes_parking_metadata", () => {
  const summary = JSON.parse(
    summarizeCheckpoint(
      {
        sessionID: "ses_parked",
        status: "parked",
        parkedReason: "Missing shared auth foundation",
        blockedBy: "auth middleware parity",
        nextFeature: "portal login smoke hardening",
        updatedAt: "2026-04-09T20:00:00.000Z",
        verification: [],
      },
      null,
    ),
  );

  assert.equal(summary.isParked, true);
  assert.equal(summary.parkedReason, "Missing shared auth foundation");
  assert.equal(summary.blockedBy, "auth middleware parity");
  assert.equal(summary.nextFeature, "portal login smoke hardening");
});
