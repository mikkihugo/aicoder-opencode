import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import plugin from "./index.ts";

test("systemTransform_when_autonomous_iteration_is_active_prefers_default_over_question_tool", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "dr-session-continuation-test-"));
  const sessionID = "ses_autonomous";
  const checkpointDirectory = path.join(temporaryDirectory, ".opencode", "state", "checkpoints");
  const checkpointFilePath = path.join(checkpointDirectory, `${sessionID}.json`);

  await mkdir(checkpointDirectory, { recursive: true });
  await writeFile(
    checkpointFilePath,
    JSON.stringify(
      {
        sessionID,
        autonomousIteration: true,
        status: "in_progress",
      },
      null,
      2,
    ),
    "utf8",
  );

  const hooks = await plugin({ directory: temporaryDirectory } as any);
  const output = { system: [] as string[] };

  await hooks["experimental.chat.system.transform"]?.({ sessionID } as any, output as any);

  assert.equal(output.system.length, 1);
  assert.match(output.system[0], /Do not use multi-choice or paged user-question tools/);
  assert.match(output.system[0], /choose the safest evidence-backed default/i);
  assert.match(output.system[0], /park the blocked plan or slice explicitly/i);
  assert.doesNotMatch(output.system[0], /Ask the user only when the missing decision remains unsafe to infer/);
});

test("toolExecuteBefore_when_non_trivial_autonomous_slice_is_missing_partner_and_combatant_blocks_mutation", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "dr-session-continuation-test-"));
  const sessionID = "ses_gate";
  const checkpointDirectory = path.join(temporaryDirectory, ".opencode", "state", "checkpoints");
  const checkpointFilePath = path.join(checkpointDirectory, `${sessionID}.json`);
  const activeSliceDirectory = path.join(
    temporaryDirectory,
    "docs",
    "plans",
    "2026-04-09-test-slice",
  );

  await mkdir(checkpointDirectory, { recursive: true });
  await mkdir(activeSliceDirectory, { recursive: true });
  await writeFile(
    checkpointFilePath,
    JSON.stringify(
      {
        sessionID,
        autonomousIteration: true,
        status: "in_progress",
        planPath: "docs/plans/2026-04-09-test-slice/proposal.md",
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(activeSliceDirectory, "active-slice.md"),
    [
      "# Active Slice",
      "",
      "**Purpose:** tighten CI reliability",
      "**Status:** in_progress",
      "**Contract Test:** go test ./...",
      "**Next Step:** fix the failing tests",
    ].join("\n"),
    "utf8",
  );

  const hooks = await plugin({ directory: temporaryDirectory } as any);
  const toolExecuteBefore = hooks["tool.execute.before"];

  if (!toolExecuteBefore) {
    throw new Error("tool.execute.before hook is missing");
  }

  await assert.rejects(
    () =>
      toolExecuteBefore(
        {
          sessionID,
          tool: "write",
          args: { path: "portal/file.go", text: "package portal" },
        } as any,
        {} as any,
      ),
    /pre-edit autonomous gate blocked implementation.*supportive helper pass.*adversarial helper pass/i,
  );
});
