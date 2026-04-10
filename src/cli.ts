import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseModelSelectionOptions } from "./model-registry.js";
import {
  buildRoleRecommendations,
  DEFAULT_OPENCODE_EXECUTABLE_PATH,
  loadVisibleRuntimeModelFamilies,
  loadVisibleRuntimeModelIds,
  renderRuntimeModelFamily,
  runModelRegistryEditor,
} from "./cli/model-commands.js";
import {
  backupOpencodeDatabase,
  checkpointOpencodeDatabase,
  parseOpencodeDatabaseMaintenanceMode,
  vacuumOpencodeDatabase,
} from "./opencode-database-maintenance.js";

const CONTROL_PLANE_ROOT_DIRECTORY = process.cwd();
const TARGET_CONFIGURATION_DIRECTORY = path.join(
  CONTROL_PLANE_ROOT_DIRECTORY,
  "config",
  "targets",
);

const BUBBLEWRAP_SANDBOX_KIND = "bubblewrap";
const OPENCODE_LAUNCHER_TYPE = "opencode";
const PRODUCT_LAUNCHER_MODE = "product";
const MAINTENANCE_LAUNCHER_MODE = "maintenance";
const BUBBLEWRAP_EXECUTABLE_PATH = "/usr/bin/bwrap";
const HIDDEN_PATH_OVERLAY_DIRECTORY = "/tmp/aicoder-opencode-empty";
const STATE_DIRECTORY = path.join(CONTROL_PLANE_ROOT_DIRECTORY, ".state");
const LOOP_GUARD_DIRECTORY = path.join(STATE_DIRECTORY, "doom-loop");
const ARGUMENT_SEPARATOR = "--";
const DEFAULT_DOOM_LOOP_STALL_THRESHOLD = 3;

const launcherConfigurationSchema = z.object({
  type: z.literal(OPENCODE_LAUNCHER_TYPE),
  mode: z.enum([PRODUCT_LAUNCHER_MODE, MAINTENANCE_LAUNCHER_MODE]),
  executable_path: z.string().default(DEFAULT_OPENCODE_EXECUTABLE_PATH),
  sandbox_kind: z.enum([BUBBLEWRAP_SANDBOX_KIND]).optional(),
});

const subprojectConfigurationSchema = z.object({
  name: z.string(),
  root: z.string(),
});

const repoTargetConfigurationSchema = z.object({
  name: z.string(),
  kind: z.literal("repo"),
  root: z.string(),
  default_branch: z.string(),
  maintenance_owner: z.string(),
  instruction_path: z.string(),
  product_launcher: launcherConfigurationSchema.optional(),
  maintenance_launcher: launcherConfigurationSchema.optional(),
  hidden_paths: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
});

const monorepoTargetConfigurationSchema = z.object({
  name: z.string(),
  kind: z.literal("monorepo"),
  root: z.string(),
  default_branch: z.string(),
  maintenance_owner: z.string(),
  instruction_path: z.string(),
  subprojects: z.array(subprojectConfigurationSchema),
  notes: z.array(z.string()).optional(),
});

const targetConfigurationSchema = z.discriminatedUnion("kind", [
  repoTargetConfigurationSchema,
  monorepoTargetConfigurationSchema,
]);

type TargetConfiguration = z.infer<typeof targetConfigurationSchema>;

type LoopSnapshot = {
  targetName: string;
  checkpointNames: string[];
  activeSlicePaths: string[];
  checkpointDigest: string;
  activeSliceDigest: string;
};

type LoopGuardState = {
  targetName: string;
  consecutiveStableIterations: number;
  lastSnapshot: LoopSnapshot;
  updatedAt: string;
};

function resolveControlPlanePath(relativePath: string): string {
  return path.join(CONTROL_PLANE_ROOT_DIRECTORY, relativePath);
}

function hashText(inputText: string): string {
  return createHash("sha256").update(inputText).digest("hex");
}

function quoteShellArgument(argumentValue: string): string {
  if (argumentValue === "") {
    return "''";
  }
  return `'${argumentValue.replaceAll("'", `'\"'\"'`)}'`;
}

async function listTargetNames(): Promise<string[]> {
  const directoryEntries = await readdir(TARGET_CONFIGURATION_DIRECTORY, {
    withFileTypes: true,
  });
  return directoryEntries
    .filter((directoryEntry) => directoryEntry.isFile())
    .map((directoryEntry) => directoryEntry.name)
    .filter((fileName) => fileName.endsWith(".yaml"))
    .map((fileName) => fileName.replace(/\.yaml$/, ""))
    .sort();
}

/**
 * Load one target definition from the control-plane config directory.
 *
 * Args:
 *   targetName: Target slug without the `.yaml` suffix.
 *
 * Returns:
 *   The parsed and validated target configuration.
 *
 * Raises:
 *   ZodError: When the target file shape does not match the schema.
 *   Error: When the target file cannot be read.
 */
async function loadTargetConfiguration(targetName: string): Promise<TargetConfiguration> {
  if (targetName.includes("/") || targetName.includes("\\") || targetName.includes("..")) {
    throw new Error(`invalid target name: ${targetName}`);
  }
  const targetConfigurationPath = path.join(
    TARGET_CONFIGURATION_DIRECTORY,
    `${targetName}.yaml`,
  );
  const targetConfigurationContent = await readFile(targetConfigurationPath, "utf8");
  const parsedTargetConfiguration = parseYaml(targetConfigurationContent);
  return targetConfigurationSchema.parse(parsedTargetConfiguration);
}

/**
 * Fail fast when a required file-system path is missing.
 *
 * Args:
 *   pathToCheck: Absolute path that must exist.
 *   errorMessage: Error text to raise when the path is missing.
 *
 * Raises:
 *   Error: When the path does not exist.
 */
async function assertPathExists(pathToCheck: string, errorMessage: string): Promise<void> {
  try {
    await access(pathToCheck);
  } catch {
    throw new Error(errorMessage);
  }
}

/**
 * Validate one target configuration against the local machine state.
 *
 * Args:
 *   targetConfiguration: Parsed target configuration to validate.
 *
 * Raises:
 *   Error: When required roots, instructions, or executables are missing.
 */
async function validateTargetConfiguration(targetConfiguration: TargetConfiguration): Promise<void> {
  await assertPathExists(
    targetConfiguration.root,
    `target root does not exist: ${targetConfiguration.root}`,
  );

  const instructionPath = resolveControlPlanePath(targetConfiguration.instruction_path);
  await assertPathExists(
    instructionPath,
    `target instruction file does not exist: ${instructionPath}`,
  );

  if (targetConfiguration.kind === "repo") {
    if (targetConfiguration.product_launcher) {
      await assertPathExists(
        targetConfiguration.product_launcher.executable_path,
        `product launcher executable does not exist: ${targetConfiguration.product_launcher.executable_path}`,
      );
      if (targetConfiguration.product_launcher.sandbox_kind === BUBBLEWRAP_SANDBOX_KIND) {
        await assertPathExists(
          BUBBLEWRAP_EXECUTABLE_PATH,
          `bubblewrap executable does not exist: ${BUBBLEWRAP_EXECUTABLE_PATH}`,
        );
      }
    }

    if (targetConfiguration.maintenance_launcher) {
      await assertPathExists(
        targetConfiguration.maintenance_launcher.executable_path,
        `maintenance launcher executable does not exist: ${targetConfiguration.maintenance_launcher.executable_path}`,
      );
    }
  }

  if (targetConfiguration.kind === "monorepo") {
    for (const subprojectConfiguration of targetConfiguration.subprojects) {
      await assertPathExists(
        subprojectConfiguration.root,
        `subproject root does not exist: ${subprojectConfiguration.root}`,
      );
    }
  }
}

/**
 * Read the target-specific instruction document from the control plane.
 *
 * Args:
 *   targetConfiguration: Target whose instruction file should be read.
 *
 * Returns:
 *   The raw instruction text.
 */
async function loadTargetInstructions(targetConfiguration: TargetConfiguration): Promise<string> {
  const instructionPath = resolveControlPlanePath(targetConfiguration.instruction_path);
  return readFile(instructionPath, "utf8");
}

function checkpointDirectoryForTarget(targetConfiguration: TargetConfiguration): string | null {
  if (targetConfiguration.kind !== "repo") {
    return null;
  }

  return path.join(targetConfiguration.root, ".opencode", "state", "checkpoints");
}

/**
 * Locate checkpoint JSON files for a repo target.
 *
 * Args:
 *   targetConfiguration: Target whose repo checkpoints should be enumerated.
 *
 * Returns:
 *   Sorted checkpoint file names, or an empty list when checkpoints do not exist.
 */
async function listCheckpointFiles(targetConfiguration: TargetConfiguration): Promise<string[]> {
  const checkpointDirectory = checkpointDirectoryForTarget(targetConfiguration);
  if (!checkpointDirectory) {
    return [];
  }

  try {
    const fileNames = await readdir(checkpointDirectory);
    return fileNames.filter((fileName) => fileName.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

/**
 * Discover active-slice documents under `docs/plans` for a repo target.
 *
 * Args:
 *   targetConfiguration: Target whose active slice files should be discovered.
 *
 * Returns:
 *   Sorted absolute paths to `active-slice.md` files.
 */
async function listActiveSliceFiles(targetConfiguration: TargetConfiguration): Promise<string[]> {
  if (targetConfiguration.kind !== "repo") {
    return [];
  }

  const plansDirectory = path.join(targetConfiguration.root, "docs", "plans");
  const activeSlicePaths: string[] = [];
  const pendingDirectories = [plansDirectory];

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop()!;
    let directoryEntries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;

    try {
      directoryEntries = await readdir(currentDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const directoryEntry of directoryEntries) {
      const entryPath = path.join(currentDirectory, directoryEntry.name);
      if (directoryEntry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }

      if (directoryEntry.isFile() && directoryEntry.name === "active-slice.md") {
        activeSlicePaths.push(entryPath);
      }
    }
  }

  return activeSlicePaths.sort();
}

/**
 * Build the durable-state snapshot used by the doom-loop guard.
 *
 * Args:
 *   targetName: Logical target name used for persisted state.
 *   targetConfiguration: Repo target whose checkpoints and slices should be hashed.
 *
 * Returns:
 *   A digest-backed snapshot of checkpoints and active-slice state.
 */
async function buildLoopSnapshot(targetName: string, targetConfiguration: TargetConfiguration): Promise<LoopSnapshot> {
  const checkpointFileNames = await listCheckpointFiles(targetConfiguration);
  const activeSlicePaths = await listActiveSliceFiles(targetConfiguration);

  const checkpointDirectory = checkpointDirectoryForTarget(targetConfiguration);
  const checkpointPayload = await Promise.all(
    checkpointFileNames.map(async (fileName) => {
      // checkpointDirectory is guaranteed non-null here since we already have checkpointFileNames
      const checkpointPath = path.join(checkpointDirectory!, fileName);
      const checkpointContent = await readFile(checkpointPath, "utf8");
      return `${fileName}\n${checkpointContent}`;
    }),
  );

  const activeSlicePayload = await Promise.all(
    activeSlicePaths.map(async (activeSlicePath) => {
      const activeSliceContent = await readFile(activeSlicePath, "utf8");
      return `${path.relative(targetConfiguration.root, activeSlicePath)}\n${activeSliceContent}`;
    }),
  );

  return {
    targetName,
    checkpointNames: checkpointFileNames,
    activeSlicePaths: activeSlicePaths.map((activeSlicePath) => path.relative(targetConfiguration.root, activeSlicePath)),
    checkpointDigest: hashText(checkpointPayload.join("\n---\n")),
    activeSliceDigest: hashText(activeSlicePayload.join("\n---\n")),
  };
}

/**
 * Compute the persisted state path for one target's doom-loop guard.
 *
 * Args:
 *   targetName: Logical target name.
 *
 * Returns:
 *   Absolute JSON state path under `.state/doom-loop`.
 */
function loopGuardStatePath(targetName: string): string {
  return path.join(LOOP_GUARD_DIRECTORY, `${targetName}.json`);
}

/**
 * Load the previous doom-loop state for one target, if it exists.
 *
 * Args:
 *   targetName: Logical target name.
 *
 * Returns:
 *   Parsed loop-guard state, or `null` when no prior state exists.
 */
async function loadLoopGuardState(targetName: string): Promise<LoopGuardState | null> {
  try {
    const raw = await readFile(loopGuardStatePath(targetName), "utf8");
    return JSON.parse(raw) as LoopGuardState;
  } catch {
    return null;
  }
}

/**
 * Persist the current doom-loop state snapshot for one target.
 *
 * Args:
 *   targetName: Logical target name.
 *   loopGuardState: New state payload to persist.
 *
 * Returns:
 *   Nothing.
 */
async function writeLoopGuardState(targetName: string, loopGuardState: LoopGuardState): Promise<void> {
  await mkdir(LOOP_GUARD_DIRECTORY, { recursive: true });
  await writeFile(loopGuardStatePath(targetName), `${JSON.stringify(loopGuardState, null, 2)}\n`, "utf8");
}

function snapshotsMatch(leftSnapshot: LoopSnapshot, rightSnapshot: LoopSnapshot): boolean {
  return leftSnapshot.checkpointDigest === rightSnapshot.checkpointDigest
    && leftSnapshot.activeSliceDigest === rightSnapshot.activeSliceDigest;
}

async function evaluateLoopGuard(
  targetName: string,
  targetConfiguration: TargetConfiguration,
  stallThreshold: number,
): Promise<{ status: "ok" | "stalled"; stableIterations: number; snapshot: LoopSnapshot }> {
  const loopSnapshot = await buildLoopSnapshot(targetName, targetConfiguration);
  const previousLoopGuardState = await loadLoopGuardState(targetName);

  let consecutiveStableIterations = 0;
  if (previousLoopGuardState && snapshotsMatch(previousLoopGuardState.lastSnapshot, loopSnapshot)) {
    consecutiveStableIterations = previousLoopGuardState.consecutiveStableIterations + 1;
  }

  await writeLoopGuardState(targetName, {
    targetName,
    consecutiveStableIterations,
    lastSnapshot: loopSnapshot,
    updatedAt: new Date().toISOString(),
  });

  return {
    status: consecutiveStableIterations >= stallThreshold ? "stalled" : "ok",
    stableIterations: consecutiveStableIterations,
    snapshot: loopSnapshot,
  };
}

async function buildSandboxedCommand(
  repoRootDirectory: string,
  hiddenPaths: string[],
  executablePath: string,
  executableArguments: string[],
): Promise<string[]> {
  await mkdir(HIDDEN_PATH_OVERLAY_DIRECTORY, { recursive: true });

  const bubblewrapArguments = [
    "--die-with-parent",
    "--new-session",
    "--bind",
    "/",
    "/",
    "--dev-bind",
    "/dev",
    "/dev",
    "--proc",
    "/proc",
    "--chdir",
    repoRootDirectory,
  ];

  for (const hiddenPath of hiddenPaths) {
    if (path.isAbsolute(hiddenPath)) {
      throw new Error(`hidden_paths entries must be relative: ${hiddenPath}`);
    }
    bubblewrapArguments.push(
      "--bind",
      HIDDEN_PATH_OVERLAY_DIRECTORY,
      path.join(repoRootDirectory, hiddenPath),
    );
  }

  return [
    BUBBLEWRAP_EXECUTABLE_PATH,
    ...bubblewrapArguments,
    executablePath,
    ...executableArguments,
  ];
}

async function buildProductLaunchCommand(
  targetConfiguration: z.infer<typeof repoTargetConfigurationSchema>,
  launcherArguments: string[],
): Promise<string[]> {
  if (!targetConfiguration.product_launcher) {
    throw new Error(`target does not define a product launcher: ${targetConfiguration.name}`);
  }

  const launcherExecutablePath = targetConfiguration.product_launcher.executable_path;
  const repoRootDirectory = targetConfiguration.root;
  const hiddenPaths = targetConfiguration.hidden_paths ?? [];

  if (targetConfiguration.product_launcher.sandbox_kind !== BUBBLEWRAP_SANDBOX_KIND) {
    return [launcherExecutablePath, ...launcherArguments];
  }

  return buildSandboxedCommand(
    repoRootDirectory,
    hiddenPaths,
    launcherExecutablePath,
    launcherArguments,
  );
}

function renderShellCommand(commandParts: string[]): string {
  return commandParts.map((commandPart) => quoteShellArgument(commandPart)).join(" ");
}

async function runCommand(commandParts: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(commandParts[0]!, commandParts.slice(1), {
      stdio: "inherit",
    });

    childProcess.on("error", (error: Error) => {
      reject(error);
    });

    childProcess.on("exit", (exitCode: number | null) => {
      resolve(exitCode ?? 1);
    });
  });
}

function printUsageAndExit(): never {
  process.stdout.write(
    [
      "usage: aicoder-opencode [list-targets|show-target <name>|show-target-instructions <name>|validate-target <name>",
      "|print-product-launch <name> [-- <args...>]|launch-product <name> [-- <args...>]",
      "|debug-product-sandbox <name> [-- <command...>]|check-doom-loop <name> [threshold]",
      "|list-models [--free] [--provider <provider>] [--enabled]",
      "|list-model-families [--free] [--provider <provider>]",
      "|select-models <role> [--free] [--provider <provider>]",
      "|manage-models|opencode-database-maintenance <checkpoint|backup|vacuum>\n",
    ].join(""),
  );
  process.exit(1);
}

function renderTargetConfiguration(targetConfiguration: TargetConfiguration): string {
  const baseLines = [
    `name: ${targetConfiguration.name}`,
    `kind: ${targetConfiguration.kind}`,
    `root: ${targetConfiguration.root}`,
    `default_branch: ${targetConfiguration.default_branch}`,
    `maintenance_owner: ${targetConfiguration.maintenance_owner}`,
    `instruction_path: ${targetConfiguration.instruction_path}`,
  ];

  if (targetConfiguration.kind === "repo") {
    return [
      ...baseLines,
      `product_launcher: ${JSON.stringify(targetConfiguration.product_launcher ?? null)}`,
      `maintenance_launcher: ${JSON.stringify(targetConfiguration.maintenance_launcher ?? null)}`,
      `hidden_paths: ${JSON.stringify(targetConfiguration.hidden_paths ?? [])}`,
      `notes: ${JSON.stringify(targetConfiguration.notes ?? [])}`,
    ].join("\n");
  }

  return [
    ...baseLines,
    `subprojects: ${targetConfiguration.subprojects.length}`,
    `notes: ${JSON.stringify(targetConfiguration.notes ?? [])}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const commandName = process.argv[2] ?? "list-targets";

  if (commandName === "list-targets") {
    const targetNames = await listTargetNames();
    process.stdout.write(`${targetNames.join("\n")}\n`);
    return;
  }

  if (commandName === "show-target") {
    const targetName = process.argv[3];
    if (!targetName) {
      printUsageAndExit();
    }
    const targetConfiguration = await loadTargetConfiguration(targetName);
    process.stdout.write(`${renderTargetConfiguration(targetConfiguration)}\n`);
    return;
  }

  if (commandName === "show-target-instructions") {
    const targetName = process.argv[3];
    if (!targetName) {
      printUsageAndExit();
    }
    const targetConfiguration = await loadTargetConfiguration(targetName);
    const targetInstructions = await loadTargetInstructions(targetConfiguration);
    process.stdout.write(targetInstructions);
    if (!targetInstructions.endsWith("\n")) {
      process.stdout.write("\n");
    }
    return;
  }

  if (commandName === "validate-target") {
    const targetName = process.argv[3];
    if (!targetName) {
      printUsageAndExit();
    }
    const targetConfiguration = await loadTargetConfiguration(targetName);
    await validateTargetConfiguration(targetConfiguration);
    process.stdout.write(`${targetName}: ok\n`);
    return;
  }

  if (commandName === "print-product-launch") {
    const targetName = process.argv[3];
    if (!targetName) {
      printUsageAndExit();
    }
    const separatorIndex = process.argv.indexOf(ARGUMENT_SEPARATOR);
    const launcherArguments = separatorIndex === -1 ? [] : process.argv.slice(separatorIndex + 1);
    const targetConfiguration = await loadTargetConfiguration(targetName);
    if (targetConfiguration.kind !== "repo") {
      throw new Error(`product launch is only supported for repo targets: ${targetName}`);
    }
    const launchCommand = await buildProductLaunchCommand(targetConfiguration, launcherArguments);
    process.stdout.write(`${renderShellCommand(launchCommand)}\n`);
    return;
  }

  if (commandName === "launch-product") {
    const targetName = process.argv[3];
    if (!targetName) {
      printUsageAndExit();
    }
    const separatorIndex = process.argv.indexOf(ARGUMENT_SEPARATOR);
    const launcherArguments = separatorIndex === -1 ? [] : process.argv.slice(separatorIndex + 1);
    const targetConfiguration = await loadTargetConfiguration(targetName);
    if (targetConfiguration.kind !== "repo") {
      throw new Error(`product launch is only supported for repo targets: ${targetName}`);
    }
    const launchCommand = await buildProductLaunchCommand(targetConfiguration, launcherArguments);
    const exitCode = await runCommand(launchCommand);
    process.exit(exitCode);
  }

  if (commandName === "debug-product-sandbox") {
    const targetName = process.argv[3];
    if (!targetName) {
      printUsageAndExit();
    }
    const separatorIndex = process.argv.indexOf(ARGUMENT_SEPARATOR);
    const debugCommand = separatorIndex === -1
      ? ["/usr/bin/env", "bash", "-lc", "pwd && ls -a"]
      : process.argv.slice(separatorIndex + 1);
    const targetConfiguration = await loadTargetConfiguration(targetName);
    if (targetConfiguration.kind !== "repo") {
      throw new Error(`product sandbox debug is only supported for repo targets: ${targetName}`);
    }
    const hiddenPaths = targetConfiguration.hidden_paths ?? [];
    const sandboxedCommand = await buildSandboxedCommand(
      targetConfiguration.root,
      hiddenPaths,
      debugCommand[0]!,
      debugCommand.slice(1),
    );
    const exitCode = await runCommand(sandboxedCommand);
    process.exit(exitCode);
  }

  if (commandName === "check-doom-loop") {
    const targetName = process.argv[3];
    if (!targetName) {
      printUsageAndExit();
    }
    const stallThreshold = Number(process.argv[4] ?? DEFAULT_DOOM_LOOP_STALL_THRESHOLD);
    if (!Number.isInteger(stallThreshold) || stallThreshold < 1) {
      throw new Error(`stall threshold must be a positive integer: ${process.argv[4] ?? ""}`);
    }
    const targetConfiguration = await loadTargetConfiguration(targetName);
    if (targetConfiguration.kind !== "repo") {
      throw new Error(`doom-loop checks are only supported for repo targets: ${targetName}`);
    }
    const loopEvaluation = await evaluateLoopGuard(targetName, targetConfiguration, stallThreshold);
    process.stdout.write(`${JSON.stringify(loopEvaluation, null, 2)}\n`);
    process.exit(loopEvaluation.status === "stalled" ? 1 : 0);
  }

  if (commandName === "list-models") {
    const optionValues = parseModelSelectionOptions(process.argv.slice(3));
    const visibleModelIds = await loadVisibleRuntimeModelIds(
      CONTROL_PLANE_ROOT_DIRECTORY,
      {
        freeOnly: optionValues.freeOnly,
        providerFilter: optionValues.providerFilter,
      },
    );
    process.stdout.write(`${visibleModelIds.join("\n")}\n`);
    return;
  }

  if (commandName === "list-model-families") {
    const optionValues = parseModelSelectionOptions(process.argv.slice(3));
    const visibleRuntimeModelFamilies = await loadVisibleRuntimeModelFamilies(
      CONTROL_PLANE_ROOT_DIRECTORY,
      {
        freeOnly: optionValues.freeOnly,
        providerFilter: optionValues.providerFilter,
      },
    );
    process.stdout.write(`${visibleRuntimeModelFamilies.map(renderRuntimeModelFamily).join("\n")}\n`);
    return;
  }

  if (commandName === "select-models") {
    const roleName = process.argv[3];
    if (!roleName) {
      printUsageAndExit();
    }
    const optionValues = parseModelSelectionOptions(process.argv.slice(4));
    const recommendations = await buildRoleRecommendations(
      CONTROL_PLANE_ROOT_DIRECTORY,
      roleName,
      {
        freeOnly: optionValues.freeOnly,
        providerFilter: optionValues.providerFilter,
      },
    );
    process.stdout.write(`${recommendations.join("\n")}\n`);
    return;
  }

  if (commandName === "manage-models") {
    await runModelRegistryEditor(CONTROL_PLANE_ROOT_DIRECTORY);
    return;
  }

  if (commandName === "opencode-database-maintenance") {
    const maintenanceMode = parseOpencodeDatabaseMaintenanceMode(process.argv[3]);
    if (!maintenanceMode) {
      printUsageAndExit();
    }

    const maintenanceResult = maintenanceMode === "checkpoint"
      ? await checkpointOpencodeDatabase()
      : maintenanceMode === "backup"
        ? await backupOpencodeDatabase()
        : await vacuumOpencodeDatabase();

    process.stdout.write(`${JSON.stringify(maintenanceResult, null, 2)}\n`);
    return;
  }

  printUsageAndExit();
}

await main();
