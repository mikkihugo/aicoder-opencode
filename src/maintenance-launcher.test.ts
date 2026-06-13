import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const MAINTENANCE_LAUNCHER_PATHS = [
  ".opencode/bin/aicoder-maintenance-autonomous-start",
  "targets/dr-repo/overlay/.opencode/bin/dr-maintenance-autonomous-start",
  "targets/letta-workspace/overlay/.opencode/bin/letta-workspace-maintenance-start",
] as const;
const SAFE_HEREDOC_PATTERN = /START_MESSAGE(?:_TEMPLATE)?=\$?\((?:\n)?cat <<'PROMPT'[\s\S]*?PROMPT\n\)?/;
const DANGEROUS_INLINE_START_MESSAGE_PATTERN =
  /START_MESSAGE="\$\{1:-[^$]*[\r\n][\s\S]*?"/;

async function readLauncher(relativePath: string): Promise<string> {
  const absolutePath = path.resolve(relativePath);
  return readFile(absolutePath, "utf8");
}

function extractPromptText(launcherSource: string): string {
  const promptMatch = launcherSource.match(/cat <<\'PROMPT\'\n([\s\S]*?)\nPROMPT/);
  assert.ok(promptMatch, "launcher must embed a PROMPT heredoc");
  return promptMatch[1];
}

test("maintenance launchers pass bash syntax validation", async () => {
  for (const relativePath of MAINTENANCE_LAUNCHER_PATHS) {
    await execFileAsync("bash", ["-n", relativePath], {
      cwd: path.resolve("."),
    });
  }

  assert.ok(true);
});

test("maintenance launchers pass shellcheck", async () => {
  for (const relativePath of MAINTENANCE_LAUNCHER_PATHS) {
    await execFileAsync("shellcheck", [relativePath], {
      cwd: path.resolve("."),
    });
  }

  assert.ok(true);
});

test("maintenance launchers define prompt defaults with quoted heredocs", async () => {
  for (const relativePath of MAINTENANCE_LAUNCHER_PATHS) {
    const launcherSource = await readLauncher(relativePath);
    assert.match(launcherSource, SAFE_HEREDOC_PATTERN);
    assert.doesNotMatch(launcherSource, DANGEROUS_INLINE_START_MESSAGE_PATTERN);
  }
});

test("maintenance launchers send prompt text as START_MESSAGE data", async () => {
  for (const relativePath of MAINTENANCE_LAUNCHER_PATHS) {
    const launcherSource = await readLauncher(relativePath);
    assert.match(
      launcherSource,
      /send_remote_prompt "[^"]+" "[^"]+" "\$START_MESSAGE"/,
    );
  }
});


test("maintenance launcher prompts keep unique ordered step numbers", async () => {
  for (const relativePath of MAINTENANCE_LAUNCHER_PATHS) {
    const launcherSource = await readLauncher(relativePath);
    const promptText = extractPromptText(launcherSource);
    const stepNumbers = [...promptText.matchAll(/^(\d+)\. /gm)].map((match) => Number.parseInt(match[1], 10));
    assert.deepEqual(stepNumbers, Array.from({ length: stepNumbers.length }, (_, index) => index + 1));
  }
});

test("maintenance launchers preserve resumable canonical sessions", async () => {
  const aicoderLauncherSource = await readLauncher(
    ".opencode/bin/aicoder-maintenance-autonomous-start",
  );
  const drLauncherSource = await readLauncher(
    "targets/dr-repo/overlay/.opencode/bin/dr-maintenance-autonomous-start",
  );
  const lettaLauncherSource = await readLauncher(
    "targets/letta-workspace/overlay/.opencode/bin/letta-workspace-maintenance-start",
  );

  assert.doesNotMatch(
    aicoderLauncherSource,
    /cleanup_session_ids_except_selected "\$CANDIDATE_SESSION_IDS"/,
  );
  assert.doesNotMatch(
    drLauncherSource,
    /cleanup_session_ids "\$DUPLICATE_SESSION_IDS"/,
  );
  assert.doesNotMatch(
    lettaLauncherSource,
    /cleanup_session_ids_except_selected "\$CANDIDATE_SESSION_IDS"/,
  );

  assert.match(
    aicoderLauncherSource,
    /cleanup_session_ids_except_selected "\$GENERIC_CONFLICT_SESSION_IDS"/,
  );
  assert.match(
    drLauncherSource,
    /cleanup_session_ids "\$GENERIC_CONFLICT_SESSION_IDS"/,
  );
  assert.match(
    lettaLauncherSource,
    /cleanup_session_ids_except_selected "\$GENERIC_CONFLICT_SESSION_IDS"/,
  );

  assert.doesNotMatch(
    aicoderLauncherSource,
    /rotating blocked session|rotating stale active session/,
  );
  assert.doesNotMatch(
    drLauncherSource,
    /rotating blocked session|rotating stale active session/,
  );
  assert.doesNotMatch(
    lettaLauncherSource,
    /rotating blocked session|rotating stale active session/,
  );

  assert.match(aicoderLauncherSource, /resuming blocked session|resuming stale session/);
  assert.match(drLauncherSource, /resuming blocked session|resuming stale session/);
  assert.match(lettaLauncherSource, /resuming blocked session|resuming stale session/);
});
