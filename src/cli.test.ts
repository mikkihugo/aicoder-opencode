import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import {
  quoteShellArgument,
  renderShellCommand,
  findArgumentSeparatorIndex,
  extractSeparatorArguments,
  requireTargetName,
  parseStallThreshold,
  parseDatabaseMaintenanceArgs,
  parseCommand,
} from "./cli/arg-parser.js";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.resolve("src/cli.ts");

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync("npx", ["tsx", CLI_ENTRY, ...args], {
      timeout: 15_000,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? "",
      exitCode: execError.code ?? 1,
    };
  }
}

// ─── quoteShellArgument ────────────────────────────────────────────────

test("quoteShellArgument_whenEmptyString_returnsSingleQuotes", () => {
  assert.equal(quoteShellArgument(""), "''");
});

test("quoteShellArgument_whenSimpleString_wrapsInSingleQuotes", () => {
  assert.equal(quoteShellArgument("hello"), "'hello'");
});

test("quoteShellArgument_whenContainsSingleQuote_escapesCorrectly", () => {
  const result = quoteShellArgument("it's");
  assert.equal(result, `'it'\"'\"'s'`);
});

test("quoteShellArgument_whenContainsSpaces_preservesInQuotes", () => {
  assert.equal(quoteShellArgument("hello world"), "'hello world'");
});

test("quoteShellArgument_whenContainsSpecialChars_preservesInQuotes", () => {
  assert.equal(quoteShellArgument("$PATH;rm -rf"), "'$PATH;rm -rf'");
});

test("quoteShellArgument_whenMultipleSingleQuotes_escapesEach", () => {
  const result = quoteShellArgument("a'b'c");
  assert.equal(result, `'a'\"'\"'b'\"'\"'c'`);
});

// ─── renderShellCommand ────────────────────────────────────────────────

test("renderShellCommand_whenEmptyArray_returnsEmptyString", () => {
  assert.equal(renderShellCommand([]), "");
});

test("renderShellCommand_whenSingleArg_quotesIt", () => {
  assert.equal(renderShellCommand(["hello"]), "'hello'");
});

test("renderShellCommand_whenMultipleArgs_joinsWithSpace", () => {
  assert.equal(renderShellCommand(["ls", "-la", "/tmp"]), "'ls' '-la' '/tmp'");
});

test("renderShellCommand_whenArgsHaveSpecialChars_quotesEach", () => {
  assert.equal(renderShellCommand(["echo", "hello world"]), "'echo' 'hello world'");
});

// ─── findArgumentSeparatorIndex ────────────────────────────────────────

test("findArgumentSeparatorIndex_whenSeparatorPresent_returnsIndex", () => {
  assert.equal(findArgumentSeparatorIndex(["node", "cli.js", "cmd", "--", "arg"]), 3);
});

test("findArgumentSeparatorIndex_whenNoSeparator_returnsNegativeOne", () => {
  assert.equal(findArgumentSeparatorIndex(["node", "cli.js", "cmd"]), -1);
});

test("findArgumentSeparatorIndex_whenSeparatorIsFirst_returnsIndex", () => {
  assert.equal(findArgumentSeparatorIndex(["--", "arg"]), 0);
});

// ─── extractSeparatorArguments ─────────────────────────────────────────

test("extractSeparatorArguments_whenSeparatorPresent_returnsArgsAfter", () => {
  const argv = ["node", "cli.js", "cmd", "--", "a", "b"];
  assert.deepEqual(extractSeparatorArguments(argv, 3), ["a", "b"]);
});

test("extractSeparatorArguments_whenNoSeparator_returnsEmpty", () => {
  assert.deepEqual(extractSeparatorArguments(["node", "cli.js"], -1), []);
});

test("extractSeparatorArguments_whenSeparatorIsLast_returnsEmpty", () => {
  const argv = ["node", "cli.js", "cmd", "--"];
  assert.deepEqual(extractSeparatorArguments(argv, 3), []);
});

// ─── requireTargetName ─────────────────────────────────────────────────

test("requireTargetName_whenTargetPresent_returnsTarget", () => {
  assert.equal(requireTargetName(["node", "cli.js", "cmd", "dr-repo"], 3), "dr-repo");
});

test("requireTargetName_whenPositionOutOfBounds_returnsNull", () => {
  assert.equal(requireTargetName(["node", "cli.js", "cmd"], 3), null);
});

test("requireTargetName_whenTargetIsEmpty_returnsNull", () => {
  assert.equal(requireTargetName(["node", "cli.js", "cmd", ""], 3), null);
});

// ─── parseStallThreshold ───────────────────────────────────────────────

test("parseStallThreshold_whenValid_returnsParsed", () => {
  assert.equal(parseStallThreshold(["node", "cli.js", "cmd", "target", "5"], 4, 3), 5);
});

test("parseStallThreshold_whenMissing_returnsDefault", () => {
  assert.equal(parseStallThreshold(["node", "cli.js", "cmd", "target"], 4, 3), 3);
});

test("parseStallThreshold_whenNegative_throws", () => {
  assert.throws(
    () => parseStallThreshold(["node", "cli.js", "cmd", "target", "-1"], 4, 3),
    /stall threshold must be a positive integer/,
  );
});

test("parseStallThreshold_whenFractional_throws", () => {
  assert.throws(
    () => parseStallThreshold(["node", "cli.js", "cmd", "target", "2.5"], 4, 3),
    /stall threshold must be a positive integer/,
  );
});

test("parseStallThreshold_whenNonNumeric_throws", () => {
  assert.throws(
    () => parseStallThreshold(["node", "cli.js", "cmd", "target", "abc"], 4, 3),
    /stall threshold must be a positive integer/,
  );
});

test("parseStallThreshold_whenZero_throws", () => {
  assert.throws(
    () => parseStallThreshold(["node", "cli.js", "cmd", "target", "0"], 4, 3),
    /stall threshold must be a positive integer/,
  );
});

// ─── parseDatabaseMaintenanceArgs ──────────────────────────────────────

test("parseDatabaseMaintenanceArgs_whenNoTarget_returnsMode", () => {
  const result = parseDatabaseMaintenanceArgs(["node", "cli.js", "cmd", "checkpoint"]);
  assert.deepEqual(result, { targetName: null, allTargets: false, mode: "checkpoint" });
});

test("parseDatabaseMaintenanceArgs_whenTargetProvided_returnsTargetAndMode", () => {
  const result = parseDatabaseMaintenanceArgs(["node", "cli.js", "cmd", "--target", "dr-repo", "backup"]);
  assert.deepEqual(result, { targetName: "dr-repo", allTargets: false, mode: "backup" });
});

test("parseDatabaseMaintenanceArgs_whenTargetMissingName_returnsNullTarget", () => {
  const result = parseDatabaseMaintenanceArgs(["node", "cli.js", "cmd", "--target"]);
  assert.deepEqual(result, { targetName: null, allTargets: false, mode: undefined });
});

test("parseDatabaseMaintenanceArgs_whenNoArgs_returnsUndefined", () => {
  const result = parseDatabaseMaintenanceArgs(["node", "cli.js", "cmd"]);
  assert.deepEqual(result, { targetName: null, allTargets: false, mode: undefined });
});

test("parseDatabaseMaintenanceArgs_whenTargetWithNoMode_returnsTarget", () => {
  const result = parseDatabaseMaintenanceArgs(["node", "cli.js", "cmd", "--target", "dr-repo"]);
  assert.deepEqual(result, { targetName: "dr-repo", allTargets: false, mode: undefined });
});

test("parseDatabaseMaintenanceArgs_whenAllTargets_returnsAllTargetsTrue", () => {
  const result = parseDatabaseMaintenanceArgs(["node", "cli.js", "cmd", "--all-targets", "checkpoint"]);
  assert.deepEqual(result, { targetName: null, allTargets: true, mode: "checkpoint" });
});

test("parseDatabaseMaintenanceArgs_whenAllTargetsNoMode_returnsAllTargetsTrue", () => {
  const result = parseDatabaseMaintenanceArgs(["node", "cli.js", "cmd", "--all-targets"]);
  assert.deepEqual(result, { targetName: null, allTargets: true, mode: undefined });
});

test("parseDatabaseMaintenanceArgs_whenAllTargetsBackup_returnsAllTargetsAndBackup", () => {
  const result = parseDatabaseMaintenanceArgs(["node", "cli.js", "cmd", "--all-targets", "backup"]);
  assert.deepEqual(result, { targetName: null, allTargets: true, mode: "backup" });
});

// ─── parseCommand ──────────────────────────────────────────────────────

test("parseCommand_whenNoCommand_defaultsToListTargets", () => {
  const result = parseCommand(["node", "cli.js"]);
  assert.deepEqual(result, { command: "list-targets" });
});

test("parseCommand_whenListTargets_returnsListTargets", () => {
  const result = parseCommand(["node", "cli.js", "list-targets"]);
  assert.deepEqual(result, { command: "list-targets" });
});

test("parseCommand_whenShowTarget_returnsShowTarget", () => {
  const result = parseCommand(["node", "cli.js", "show-target", "dr-repo"]);
  assert.deepEqual(result, { command: "show-target", targetName: "dr-repo" });
});

test("parseCommand_whenShowTargetMissingName_returnsHelp", () => {
  const result = parseCommand(["node", "cli.js", "show-target"]);
  assert.deepEqual(result, { command: "help" });
});

test("parseCommand_whenValidateTarget_returnsValidateTarget", () => {
  const result = parseCommand(["node", "cli.js", "validate-target", "dr-repo"]);
  assert.deepEqual(result, { command: "validate-target", targetName: "dr-repo" });
});

test("parseCommand_whenPrintProductLaunch_returnsWithArgs", () => {
  const result = parseCommand(["node", "cli.js", "print-product-launch", "dr-repo", "--", "--help"]);
  assert.deepEqual(result, {
    command: "print-product-launch",
    targetName: "dr-repo",
    launcherArguments: ["--help"],
  });
});

test("parseCommand_whenPrintProductLaunchNoSeparator_returnsEmptyArgs", () => {
  const result = parseCommand(["node", "cli.js", "print-product-launch", "dr-repo"]);
  assert.deepEqual(result, {
    command: "print-product-launch",
    targetName: "dr-repo",
    launcherArguments: [],
  });
});

test("parseCommand_whenCheckDoomLoop_returnsWithThreshold", () => {
  const result = parseCommand(["node", "cli.js", "check-doom-loop", "dr-repo", "5"]);
  assert.deepEqual(result, {
    command: "check-doom-loop",
    targetName: "dr-repo",
    stallThreshold: 5,
  });
});

test("parseCommand_whenCheckDoomLoopDefault_returnsDefaultThreshold", () => {
  const result = parseCommand(["node", "cli.js", "check-doom-loop", "dr-repo"]);
  assert.deepEqual(result, {
    command: "check-doom-loop",
    targetName: "dr-repo",
    stallThreshold: 3,
  });
});

test("parseCommand_whenCheckDoomLoopInvalidThreshold_returnsHelp", () => {
  const result = parseCommand(["node", "cli.js", "check-doom-loop", "dr-repo", "abc"]);
  assert.deepEqual(result, { command: "help" });
});

test("parseCommand_whenListModels_returnsWithRawArgs", () => {
  const result = parseCommand(["node", "cli.js", "list-models", "--free"]);
  assert.deepEqual(result, { command: "list-models", rawArgs: ["--free"] });
});

test("parseCommand_whenSelectModels_returnsWithRole", () => {
  const result = parseCommand(["node", "cli.js", "select-models", "architect", "--free"]);
  assert.deepEqual(result, {
    command: "select-models",
    roleName: "architect",
    rawArgs: ["--free"],
  });
});

test("parseCommand_whenSelectModelsNoRole_returnsHelp", () => {
  const result = parseCommand(["node", "cli.js", "select-models"]);
  assert.deepEqual(result, { command: "help" });
});

test("parseCommand_whenManageModels_returnsManageModels", () => {
  const result = parseCommand(["node", "cli.js", "manage-models"]);
  assert.deepEqual(result, { command: "manage-models" });
});

test("parseCommand_whenDbMaintenanceNoTarget_returnsNullTarget", () => {
  const result = parseCommand(["node", "cli.js", "opencode-database-maintenance", "checkpoint"]);
  assert.deepEqual(result, {
    command: "opencode-database-maintenance",
    targetName: null,
    allTargets: false,
    mode: "checkpoint",
  });
});

test("parseCommand_whenDbMaintenanceWithTarget_returnsTargetAndMode", () => {
  const result = parseCommand([
    "node", "cli.js", "opencode-database-maintenance", "--target", "dr-repo", "backup",
  ]);
  assert.deepEqual(result, {
    command: "opencode-database-maintenance",
    targetName: "dr-repo",
    allTargets: false,
    mode: "backup",
  });
});

test("parseCommand_whenDbMaintenanceAllTargets_returnsAllTargetsAndMode", () => {
  const result = parseCommand([
    "node", "cli.js", "opencode-database-maintenance", "--all-targets", "checkpoint",
  ]);
  assert.deepEqual(result, {
    command: "opencode-database-maintenance",
    targetName: null,
    allTargets: true,
    mode: "checkpoint",
  });
});

test("parseCommand_whenUnknownCommand_returnsHelp", () => {
  const result = parseCommand(["node", "cli.js", "nonexistent-command"]);
  assert.deepEqual(result, { command: "help" });
});

test("parseCommand_whenDebugProductSandbox_returnsDefaultCommand", () => {
  const result = parseCommand(["node", "cli.js", "debug-product-sandbox", "dr-repo"]);
  assert.deepEqual(result, {
    command: "debug-product-sandbox",
    targetName: "dr-repo",
    debugCommand: ["/usr/bin/env", "bash", "-lc", "pwd && ls -a"],
  });
});

test("parseCommand_whenDebugProductSandboxWithCommand_returnsCustomCommand", () => {
  const result = parseCommand([
    "node", "cli.js", "debug-product-sandbox", "dr-repo", "--", "ls", "-la",
  ]);
  assert.deepEqual(result, {
    command: "debug-product-sandbox",
    targetName: "dr-repo",
    debugCommand: ["ls", "-la"],
  });
});

test("parseCommand_whenLaunchProduct_returnsWithArgs", () => {
  const result = parseCommand([
    "node", "cli.js", "launch-product", "dr-repo", "--", "--session", "abc123",
  ]);
  assert.deepEqual(result, {
    command: "launch-product",
    targetName: "dr-repo",
    launcherArguments: ["--session", "abc123"],
  });
});

test("parseCommand_whenShowTargetInstructions_returnsWithTarget", () => {
  const result = parseCommand(["node", "cli.js", "show-target-instructions", "dr-repo"]);
  assert.deepEqual(result, {
    command: "show-target-instructions",
    targetName: "dr-repo",
  });
});

// ─── Integration tests ─────────────────────────────────────────────────

test("integration_listTargets_writesTargetNames", async () => {
  const { stdout, exitCode } = await runCli("list-targets");
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("dr-repo"), "should list dr-repo");
  assert.ok(stdout.includes("letta-workspace"), "should list letta-workspace");
  assert.ok(stdout.includes("aicoder-opencode"), "should list aicoder-opencode");
});

test("integration_showTarget_drRepo_writesTargetDetails", async () => {
  const { stdout, exitCode } = await runCli("show-target", "dr-repo");
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("name: dr-repo"));
  assert.ok(stdout.includes("kind: repo"));
  assert.ok(stdout.includes("root:"));
});

test("integration_showTarget_lettaWorkspace_writesMonorepoKind", async () => {
  const { stdout, exitCode } = await runCli("show-target", "letta-workspace");
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("kind: monorepo"));
  assert.ok(stdout.includes("subprojects:"));
});

test("integration_showTarget_nonexistent_exitsWithError", async () => {
  const { exitCode } = await runCli("show-target", "nonexistent-target-xyz");
  assert.notEqual(exitCode, 0);
});

test("integration_validateTarget_drRepo_writesOk", async () => {
  const { stdout, exitCode } = await runCli("validate-target", "dr-repo");
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("dr-repo: ok"));
});

test("integration_validateTarget_lettaWorkspace_writesOk", async () => {
  const { stdout, exitCode } = await runCli("validate-target", "letta-workspace");
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("letta-workspace: ok"));
});

test("integration_validateTarget_aicoderOpencode_writesOk", async () => {
  const { stdout, exitCode } = await runCli("validate-target", "aicoder-opencode");
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("aicoder-opencode: ok"));
});

test("integration_printProductLaunch_drRepo_writesShellCommand", async () => {
  const { stdout, exitCode } = await runCli("print-product-launch", "dr-repo", "--", "--help");
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("--help"));
  assert.ok(stdout.length > 0);
});

test("integration_noArgs_defaultsToListTargets", async () => {
  const { stdout, exitCode } = await runCli();
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("dr-repo"));
});

test("integration_dbMaintenance_checkpoint_runsSuccessfully", async () => {
  const { stdout, exitCode } = await runCli("opencode-database-maintenance", "checkpoint");
  assert.equal(exitCode, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "checkpoint");
  assert.ok(result.databasePath);
});

test("integration_dbMaintenance_withTarget_runsSuccessfully", async () => {
  const { stdout, exitCode } = await runCli(
    "opencode-database-maintenance", "--target", "dr-repo", "checkpoint",
  );
  assert.equal(exitCode, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "checkpoint");
  assert.ok(result.databasePath.includes("dr-repo"));
  assert.ok(result.databasePath.endsWith(path.join("opencode", "opencode.db")));
});

test("integration_dbMaintenance_invalidMode_exitsWithError", async () => {
  const { exitCode } = await runCli("opencode-database-maintenance", "invalid-mode");
  assert.notEqual(exitCode, 0);
});

test("integration_dbMaintenance_missingTargetName_exitsWithError", async () => {
  const { exitCode } = await runCli("opencode-database-maintenance", "--target");
  assert.notEqual(exitCode, 0);
});

test("integration_unknownCommand_exitsWithError", async () => {
  const { exitCode } = await runCli("nonexistent-command");
  assert.notEqual(exitCode, 0);
});

test("integration_dbMaintenance_allTargets_checkpoint_returnsBatchResult", async () => {
  const { stdout, exitCode } = await runCli(
    "opencode-database-maintenance", "--all-targets", "checkpoint",
  );
  assert.equal(exitCode, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "checkpoint");
  assert.ok(Array.isArray(result.targets));
  assert.ok(result.targets.length >= 2, "should have at least dr-repo and letta-workspace");
  assert.ok(result.summary);
  assert.equal(result.summary.total, result.targets.length);
  assert.equal(result.summary.succeeded + result.summary.failed, result.summary.total);

  const targetNames = result.targets.map((t: { targetName: string }) => t.targetName);
  assert.ok(targetNames.includes("dr-repo"));
  assert.ok(targetNames.includes("letta-workspace"));
});

test("integration_dbMaintenance_allTargets_includesSummaryCounts", async () => {
  const { stdout, exitCode } = await runCli(
    "opencode-database-maintenance", "--all-targets", "checkpoint",
  );
  assert.equal(exitCode, 0);
  const result = JSON.parse(stdout);
  assert.equal(typeof result.summary.succeeded, "number");
  assert.equal(typeof result.summary.failed, "number");
  assert.ok(result.summary.succeeded >= 0);
  assert.ok(result.summary.failed >= 0);
});
