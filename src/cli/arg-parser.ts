/**
 * Pure argument parsing for the aicoder-opencode CLI.
 *
 * Extracted from cli.ts main() so that argument routing logic is unit-testable
 * without spawning child processes or touching the filesystem.
 */

const ARGUMENT_SEPARATOR = "--";

export type ParsedCommand =
  | { command: "list-targets" }
  | { command: "show-target"; targetName: string }
  | { command: "show-target-instructions"; targetName: string }
  | { command: "validate-target"; targetName: string }
  | { command: "print-product-launch"; targetName: string; launcherArguments: string[] }
  | { command: "launch-product"; targetName: string; launcherArguments: string[] }
  | { command: "debug-product-sandbox"; targetName: string; debugCommand: string[] }
  | { command: "check-doom-loop"; targetName: string; stallThreshold: number }
  | { command: "list-models"; rawArgs: string[] }
  | { command: "list-model-families"; rawArgs: string[] }
  | { command: "select-models"; roleName: string; rawArgs: string[] }
  | { command: "manage-models" }
  | { command: "opencode-database-maintenance"; targetName: string | null; allTargets: boolean; mode: string | undefined }
  | { command: "help" };

/**
 * Quote one shell argument for safe interpolation into a shell command string.
 *
 * Args:
 *   argumentValue: Raw argument value.
 *
 * Returns:
 *   Shell-safe quoted string.
 */
export function quoteShellArgument(argumentValue: string): string {
  if (argumentValue === "") {
    return "''";
  }
  return `'${argumentValue.replaceAll("'", `'\"'\"'`)}'`;
}

/**
 * Render a command array as a shell-safe command string.
 *
 * Args:
 *   commandParts: Array of command parts.
 *
 * Returns:
 *   Shell-interpolatable command string with each part quoted.
 */
export function renderShellCommand(commandParts: string[]): string {
  return commandParts.map((commandPart) => quoteShellArgument(commandPart)).join(" ");
}

/**
 * Find the index of the "--" argument separator in argv.
 *
 * Args:
 *   argv: Full process.argv (including "node" and script path).
 *
 * Returns:
 *   Index of the separator, or -1 if not present.
 */
export function findArgumentSeparatorIndex(argv: string[]): number {
  return argv.indexOf(ARGUMENT_SEPARATOR);
}

/**
 * Extract arguments after the "--" separator.
 *
 * Args:
 *   argv: Full process.argv.
 *   separatorIndex: Index of "--" as returned by findArgumentSeparatorIndex.
 *
 * Returns:
 *   Arguments after the separator, or empty array if no separator.
 */
export function extractSeparatorArguments(argv: string[], separatorIndex: number): string[] {
  return separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
}

/**
 * Validate that a target name was provided (argv[pos] exists and is non-empty).
 *
 * Args:
 *   argv: Full process.argv.
 *   position: Expected position of the target name.
 *
 * Returns:
 *   The target name, or null if missing.
 */
export function requireTargetName(argv: string[], position: number): string | null {
  const targetName = argv[position];
  return targetName && targetName.length > 0 ? targetName : null;
}

/**
 * Parse stall threshold from argv, validating it is a positive integer.
 *
 * Args:
 *   argv: Full process.argv.
 *   position: Expected position of the threshold value.
 *   defaultValue: Default threshold when not provided.
 *
 * Returns:
 *   Parsed positive integer threshold.
 *
 * Raises:
 *   Error: When the value is present but not a positive integer.
 */
export function parseStallThreshold(argv: string[], position: number, defaultValue: number): number {
  const rawValue = argv[position] ?? String(defaultValue);
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`stall threshold must be a positive integer: ${rawValue}`);
  }
  return parsed;
}

/**
 * Parse the database maintenance arguments including --target and --all-targets flags.
 *
 * Args:
 *   argv: Full process.argv (starting at index 3).
 *
 * Returns:
 *   Object with optional targetName, allTargets flag, and mode string.
 *
 * Raises:
 *   Error: When both --target and --all-targets are specified.
 */
export function parseDatabaseMaintenanceArgs(argv: string[]): {
  targetName: string | null;
  allTargets: boolean;
  mode: string | undefined;
} {
  const hasTargetFlag = argv[3] === "--target";
  const hasAllTargetsFlag = argv[3] === "--all-targets";

  if (hasTargetFlag && hasAllTargetsFlag) {
    throw new Error("--target and --all-targets are mutually exclusive");
  }

  if (hasTargetFlag) {
    return {
      targetName: argv[4] ?? null,
      allTargets: false,
      mode: argv[5],
    };
  }

  if (hasAllTargetsFlag) {
    return {
      targetName: null,
      allTargets: true,
      mode: argv[4],
    };
  }

  return {
    targetName: null,
    allTargets: false,
    mode: argv[3],
  };
}

/**
 * Parse process.argv into a structured command descriptor.
 *
 * Args:
 *   argv: Full process.argv (including "node" and script path at indices 0, 1).
 *
 * Returns:
 *   A ParsedCommand variant describing the requested operation, or null for help.
 */
export function parseCommand(argv: string[]): ParsedCommand {
  const commandName = argv[2] ?? "list-targets";

  switch (commandName) {
    case "list-targets":
      return { command: "list-targets" };

    case "show-target": {
      const targetName = requireTargetName(argv, 3);
      if (!targetName) return { command: "help" };
      return { command: "show-target", targetName };
    }

    case "show-target-instructions": {
      const targetName = requireTargetName(argv, 3);
      if (!targetName) return { command: "help" };
      return { command: "show-target-instructions", targetName };
    }

    case "validate-target": {
      const targetName = requireTargetName(argv, 3);
      if (!targetName) return { command: "help" };
      return { command: "validate-target", targetName };
    }

    case "print-product-launch": {
      const targetName = requireTargetName(argv, 3);
      if (!targetName) return { command: "help" };
      const separatorIndex = findArgumentSeparatorIndex(argv);
      const launcherArguments = extractSeparatorArguments(argv, separatorIndex);
      return { command: "print-product-launch", targetName, launcherArguments };
    }

    case "launch-product": {
      const targetName = requireTargetName(argv, 3);
      if (!targetName) return { command: "help" };
      const separatorIndex = findArgumentSeparatorIndex(argv);
      const launcherArguments = extractSeparatorArguments(argv, separatorIndex);
      return { command: "launch-product", targetName, launcherArguments };
    }

    case "debug-product-sandbox": {
      const targetName = requireTargetName(argv, 3);
      if (!targetName) return { command: "help" };
      const separatorIndex = findArgumentSeparatorIndex(argv);
      const debugCommand = separatorIndex === -1
        ? ["/usr/bin/env", "bash", "-lc", "pwd && ls -a"]
        : argv.slice(separatorIndex + 1);
      return { command: "debug-product-sandbox", targetName, debugCommand };
    }

    case "check-doom-loop": {
      const targetName = requireTargetName(argv, 3);
      if (!targetName) return { command: "help" };
      try {
        const stallThreshold = parseStallThreshold(argv, 4, 3);
        return { command: "check-doom-loop", targetName, stallThreshold };
      } catch {
        return { command: "help" };
      }
    }

    case "list-models":
      return { command: "list-models", rawArgs: argv.slice(3) };

    case "list-model-families":
      return { command: "list-model-families", rawArgs: argv.slice(3) };

    case "select-models": {
      const roleName = requireTargetName(argv, 3);
      if (!roleName) return { command: "help" };
      return { command: "select-models", roleName, rawArgs: argv.slice(4) };
    }

    case "manage-models":
      return { command: "manage-models" };

    case "opencode-database-maintenance": {
      const { targetName, allTargets, mode } = parseDatabaseMaintenanceArgs(argv);
      return { command: "opencode-database-maintenance", targetName, allTargets, mode };
    }

    default:
      return { command: "help" };
  }
}
