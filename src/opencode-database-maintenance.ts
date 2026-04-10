/**
 * OpenCode SQLite maintenance for the control-plane runtime.
 *
 * This module keeps the local OpenCode database healthy without introducing a
 * second database service. The automated path is intentionally non-destructive:
 * hourly checkpoints and a daily online backup. `VACUUM` stays manual because it
 * should only run during a quiet window.
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_SQLITE_EXECUTABLE_PATH = "/usr/bin/sqlite3";
export const DEFAULT_OPENCODE_DATABASE_PATH = path.join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "opencode.db",
);
export const DEFAULT_OPENCODE_BACKUP_DIRECTORY = path.join(
  homedir(),
  ".local",
  "state",
  "opencode",
  "backups",
);
export const DEFAULT_BACKUP_RETENTION_COUNT = 7;
export const SQLITE_BUSY_TIMEOUT_MILLISECONDS = 5000;
export const BACKUP_FILE_PREFIX = "opencode-";
export const BACKUP_FILE_EXTENSION = ".sqlite3";

const HOURLY_CHECKPOINT_MODE = "checkpoint";
const DAILY_BACKUP_MODE = "backup";
const MANUAL_VACUUM_MODE = "vacuum";

export type OpencodeDatabaseMaintenanceMode =
  | typeof HOURLY_CHECKPOINT_MODE
  | typeof DAILY_BACKUP_MODE
  | typeof MANUAL_VACUUM_MODE;

export type OpencodeDatabaseMaintenanceOptions = {
  sqliteExecutablePath?: string;
  databasePath?: string;
  backupDirectory?: string;
  backupRetentionCount?: number;
  timestamp?: Date;
};

export type OpencodeDatabaseMaintenanceResult = {
  mode: OpencodeDatabaseMaintenanceMode;
  databasePath: string;
  backupPath: string | null;
  prunedBackupPaths: string[];
};

type ResolvedMaintenanceOptions = {
  sqliteExecutablePath: string;
  databasePath: string;
  backupDirectory: string;
  backupRetentionCount: number;
  timestamp: Date;
};

type BackupArtifact = {
  name: string;
  path: string;
  modifiedAtMilliseconds: number;
};

/**
 * Parse one CLI/database-maintenance mode.
 *
 * Args:
 *   rawMode: Raw CLI token.
 *
 * Returns:
 *   A supported maintenance mode, or `null` when the token is unknown.
 */
export function parseOpencodeDatabaseMaintenanceMode(
  rawMode: string | undefined,
): OpencodeDatabaseMaintenanceMode | null {
  if (
    rawMode === HOURLY_CHECKPOINT_MODE
    || rawMode === DAILY_BACKUP_MODE
    || rawMode === MANUAL_VACUUM_MODE
  ) {
    return rawMode;
  }

  return null;
}

/**
 * Build the absolute backup file path for one maintenance run.
 *
 * Args:
 *   backupDirectory: Target directory for persisted backups.
 *   timestamp: UTC timestamp used in the backup artifact name.
 *
 * Returns:
 *   Absolute file path for the backup artifact.
 */
export function buildOpencodeDatabaseBackupPath(
  backupDirectory: string,
  timestamp: Date,
): string {
  return path.join(
    backupDirectory,
    `${BACKUP_FILE_PREFIX}${formatBackupTimestamp(timestamp)}${BACKUP_FILE_EXTENSION}`,
  );
}

/**
 * Remove stale OpenCode SQLite backups beyond the configured retention count.
 *
 * Args:
 *   backupDirectory: Directory that contains backup artifacts.
 *   backupRetentionCount: Number of newest backups to keep.
 *
 * Returns:
 *   Absolute paths removed during pruning.
 */
export async function pruneStaleOpencodeDatabaseBackups(
  backupDirectory: string,
  backupRetentionCount: number,
): Promise<string[]> {
  const backupArtifacts = await listOpencodeDatabaseBackups(backupDirectory);
  const staleArtifacts = backupArtifacts.slice(backupRetentionCount);

  for (const staleArtifact of staleArtifacts) {
    await rm(staleArtifact.path, { force: true });
  }

  return staleArtifacts.map((staleArtifact) => staleArtifact.path);
}

/**
 * Run one checkpoint-only maintenance pass.
 *
 * Args:
 *   options: Optional path overrides for sqlite, db, and backup retention.
 *
 * Returns:
 *   Result payload for logging/systemd status.
 */
export async function checkpointOpencodeDatabase(
  options: OpencodeDatabaseMaintenanceOptions = {},
): Promise<OpencodeDatabaseMaintenanceResult> {
  const resolvedOptions = resolveMaintenanceOptions(options);
  await runSqliteScript(resolvedOptions.sqliteExecutablePath, resolvedOptions.databasePath, [
    `.timeout ${SQLITE_BUSY_TIMEOUT_MILLISECONDS}`,
    "PRAGMA busy_timeout = 5000;",
    "PRAGMA optimize;",
    "PRAGMA wal_checkpoint(PASSIVE);",
  ]);

  return {
    mode: HOURLY_CHECKPOINT_MODE,
    databasePath: resolvedOptions.databasePath,
    backupPath: null,
    prunedBackupPaths: [],
  };
}

/**
 * Run one online backup pass with a lightweight checkpoint and retention prune.
 *
 * Args:
 *   options: Optional path overrides for sqlite, db, backup directory, and retention.
 *
 * Returns:
 *   Result payload including the created backup artifact.
 */
export async function backupOpencodeDatabase(
  options: OpencodeDatabaseMaintenanceOptions = {},
): Promise<OpencodeDatabaseMaintenanceResult> {
  const resolvedOptions = resolveMaintenanceOptions(options);
  const backupPath = buildOpencodeDatabaseBackupPath(
    resolvedOptions.backupDirectory,
    resolvedOptions.timestamp,
  );

  await mkdir(resolvedOptions.backupDirectory, { recursive: true });
  await checkpointOpencodeDatabase(resolvedOptions);
  await runSqliteScript(resolvedOptions.sqliteExecutablePath, resolvedOptions.databasePath, [
    `.timeout ${SQLITE_BUSY_TIMEOUT_MILLISECONDS}`,
    `.backup ${backupPath}`,
  ]);
  const prunedBackupPaths = await pruneStaleOpencodeDatabaseBackups(
    resolvedOptions.backupDirectory,
    resolvedOptions.backupRetentionCount,
  );

  return {
    mode: DAILY_BACKUP_MODE,
    databasePath: resolvedOptions.databasePath,
    backupPath,
    prunedBackupPaths,
  };
}

/**
 * Run a manual vacuum during a quiet maintenance window.
 *
 * Args:
 *   options: Optional path overrides for sqlite and db path.
 *
 * Returns:
 *   Result payload for logging/systemd status.
 */
export async function vacuumOpencodeDatabase(
  options: OpencodeDatabaseMaintenanceOptions = {},
): Promise<OpencodeDatabaseMaintenanceResult> {
  const resolvedOptions = resolveMaintenanceOptions(options);
  await runSqliteScript(resolvedOptions.sqliteExecutablePath, resolvedOptions.databasePath, [
    `.timeout ${SQLITE_BUSY_TIMEOUT_MILLISECONDS}`,
    "PRAGMA busy_timeout = 5000;",
    "VACUUM;",
    "PRAGMA optimize;",
    "PRAGMA wal_checkpoint(TRUNCATE);",
  ]);

  return {
    mode: MANUAL_VACUUM_MODE,
    databasePath: resolvedOptions.databasePath,
    backupPath: null,
    prunedBackupPaths: [],
  };
}

async function listOpencodeDatabaseBackups(
  backupDirectory: string,
): Promise<BackupArtifact[]> {
  let backupNames: string[];
  try {
    backupNames = await readdir(backupDirectory);
  } catch {
    return [];
  }

  const artifacts = await Promise.all(
    backupNames
      .filter((backupName) =>
        backupName.startsWith(BACKUP_FILE_PREFIX)
        && backupName.endsWith(BACKUP_FILE_EXTENSION))
      .map(async (backupName) => {
        const backupPath = path.join(backupDirectory, backupName);
        const backupStats = await stat(backupPath);
        return {
          name: backupName,
          path: backupPath,
          modifiedAtMilliseconds: backupStats.mtimeMs,
        } satisfies BackupArtifact;
      }),
  );

  return artifacts.sort(
    (leftArtifact, rightArtifact) =>
      rightArtifact.modifiedAtMilliseconds - leftArtifact.modifiedAtMilliseconds,
  );
}

function resolveMaintenanceOptions(
  options: OpencodeDatabaseMaintenanceOptions,
): ResolvedMaintenanceOptions {
  return {
    sqliteExecutablePath:
      options.sqliteExecutablePath ?? DEFAULT_SQLITE_EXECUTABLE_PATH,
    databasePath: options.databasePath ?? DEFAULT_OPENCODE_DATABASE_PATH,
    backupDirectory:
      options.backupDirectory ?? DEFAULT_OPENCODE_BACKUP_DIRECTORY,
    backupRetentionCount:
      options.backupRetentionCount ?? DEFAULT_BACKUP_RETENTION_COUNT,
    timestamp: options.timestamp ?? new Date(),
  };
}

function formatBackupTimestamp(timestamp: Date): string {
  const year = timestamp.getUTCFullYear();
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const day = String(timestamp.getUTCDate()).padStart(2, "0");
  const hour = String(timestamp.getUTCHours()).padStart(2, "0");
  const minute = String(timestamp.getUTCMinutes()).padStart(2, "0");
  const second = String(timestamp.getUTCSeconds()).padStart(2, "0");

  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

async function runSqliteScript(
  sqliteExecutablePath: string,
  databasePath: string,
  scriptLines: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sqliteProcess = spawn(sqliteExecutablePath, [databasePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let standardError = "";

    sqliteProcess.stderr.on("data", (chunk: Buffer) => {
      standardError += chunk.toString("utf8");
    });

    sqliteProcess.on("error", (error: Error) => {
      reject(error);
    });

    sqliteProcess.on("close", (exitCode: number | null) => {
      if (exitCode === 0) {
        resolve();
        return;
      }

      const trimmedStandardError = standardError.trim();
      reject(
        new Error(
          trimmedStandardError === ""
            ? `sqlite3 exited with code ${String(exitCode ?? 1)}`
            : trimmedStandardError,
        ),
      );
    });

    sqliteProcess.stdin.end(`${scriptLines.join("\n")}\n`);
  });
}
