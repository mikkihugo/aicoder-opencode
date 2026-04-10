import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BACKUP_FILE_EXTENSION,
  BACKUP_FILE_PREFIX,
  backupOpencodeDatabase,
  buildOpencodeDatabaseBackupPath,
  checkpointOpencodeDatabase,
  parseOpencodeDatabaseMaintenanceMode,
  pruneStaleOpencodeDatabaseBackups,
} from "./opencode-database-maintenance.js";

async function createFakeSqliteExecutable(
  executableDirectory: string,
): Promise<{ executablePath: string; logPath: string }> {
  const executablePath = path.join(executableDirectory, "sqlite3");
  const logPath = path.join(executableDirectory, "sqlite3.log");

  const fakeSqliteScript = `#!/usr/bin/env bash
set -euo pipefail

  {
  echo "sqlite3 invoked for $1"
  while IFS= read -r sqliteLine; do
    echo "$sqliteLine"
    if [[ "$sqliteLine" == ".backup "* ]]; then
      backupPath="$(printf '%s\n' \"$sqliteLine\" | sed 's/^\\.backup //')"
      mkdir -p "$(dirname "$backupPath")"
      : > "$backupPath"
    fi
  done
} >> "${logPath}"

exit 0
`;

  await writeFile(executablePath, fakeSqliteScript, { mode: 0o755 });
  return { executablePath, logPath };
}

async function createDatabaseFixture(databasePath: string): Promise<void> {
  await writeFile(databasePath, "SQLite format 3\0");
}

async function createBackedUpDatabaseFixture(
  databaseDirectory: string,
  fixtureName: string,
): Promise<string> {
  const databasePath = path.join(databaseDirectory, fixtureName);
  await createDatabaseFixture(databasePath);
  return databasePath;
}

async function setFixtureTimestamp(targetPath: string, timestamp: string): Promise<void> {
  const handle = await open(targetPath, "r+");
  await handle.utimes(new Date(timestamp), new Date(timestamp));
  await handle.close();
}

async function createBackedUpFixture(
  backupDirectory: string,
  fixtureName: string,
  timestamp: string,
): Promise<string> {
  const backupPath = path.join(backupDirectory, fixtureName);
  await writeFile(backupPath, "backup");
  await setFixtureTimestamp(backupPath, timestamp);
  return backupPath;
}

async function getSqliteInvocationLog(logPath: string): Promise<string> {
  return readFile(logPath, "utf8");
}

test("parseOpencodeDatabaseMaintenanceMode_whenModeIsKnown_returnsMode", () => {
  assert.equal(parseOpencodeDatabaseMaintenanceMode("backup"), "backup");
});

test("parseOpencodeDatabaseMaintenanceMode_whenModeIsUnknown_returnsNull", () => {
  assert.equal(parseOpencodeDatabaseMaintenanceMode("reindex"), null);
});

test("buildOpencodeDatabaseBackupPath_whenTimestampProvided_returnsSortableBackupName", () => {
  const backupPath = buildOpencodeDatabaseBackupPath(
    "/tmp/opencode-backups",
    new Date("2026-04-10T17:30:45.000Z"),
  );

  assert.equal(
    backupPath,
    "/tmp/opencode-backups/opencode-20260410T173045Z.sqlite3",
  );
});

test("checkpointOpencodeDatabase_whenWalCheckpointScriptRuns_returnsCheckpointMode", async () => {
  const sqliteDirectory = await mkdtemp(
    path.join(tmpdir(), "aicoder-opencode-checkpoint-"),
  );
  const { executablePath, logPath } = await createFakeSqliteExecutable(sqliteDirectory);
  const databasePath = await createBackedUpDatabaseFixture(sqliteDirectory, "opencode.db");

  const checkpointResult = await checkpointOpencodeDatabase({
    sqliteExecutablePath: executablePath,
    databasePath,
  });
  const sqliteInvocationLog = await getSqliteInvocationLog(logPath);

  assert.equal(checkpointResult.mode, "checkpoint");
  assert.equal(checkpointResult.databasePath, databasePath);
  assert.equal(checkpointResult.backupPath, null);
  assert.deepEqual(checkpointResult.prunedBackupPaths, []);
  assert.match(sqliteInvocationLog, /PRAGMA wal_checkpoint\(PASSIVE\);/);
});

test("backupOpencodeDatabase_whenDatabaseBackedUp_returnsBackupModeAndBackupPath", async () => {
  const sqliteDirectory = await mkdtemp(
    path.join(tmpdir(), "aicoder-opencode-backup-"),
  );
  const backupDirectory = await mkdtemp(
    path.join(tmpdir(), "aicoder-opencode-backup-output-"),
  );
  const { executablePath } = await createFakeSqliteExecutable(sqliteDirectory);
  const databasePath = await createBackedUpDatabaseFixture(sqliteDirectory, "opencode.db");
  const timestamp = new Date("2026-04-10T17:30:45.000Z");

  const backupResult = await backupOpencodeDatabase({
    sqliteExecutablePath: executablePath,
    databasePath,
    backupDirectory,
    backupRetentionCount: 5,
    timestamp,
  });
  const expectedBackupPath = buildOpencodeDatabaseBackupPath(backupDirectory, timestamp);

  assert.equal(backupResult.mode, "backup");
  assert.equal(backupResult.databasePath, databasePath);
  assert.equal(backupResult.backupPath, expectedBackupPath);
  assert.deepEqual(backupResult.prunedBackupPaths, []);
  assert.equal(await readFile(backupResult.backupPath, "utf8"), "");
});

test("backupOpencodeDatabase_whenRetentionCountExceeded_prunesOldBackups", async () => {
  const sqliteDirectory = await mkdtemp(
    path.join(tmpdir(), "aicoder-opencode-backup-retention-"),
  );
  const backupDirectory = await mkdtemp(
    path.join(tmpdir(), "aicoder-opencode-backup-retention-output-"),
  );
  const { executablePath } = await createFakeSqliteExecutable(sqliteDirectory);
  const databasePath = await createBackedUpDatabaseFixture(sqliteDirectory, "opencode.db");

  await createBackedUpFixture(
    backupDirectory,
    `${BACKUP_FILE_PREFIX}20260410T153045Z${BACKUP_FILE_EXTENSION}`,
    "2026-04-10T15:30:45.000Z",
  );
  await createBackedUpFixture(
    backupDirectory,
    `${BACKUP_FILE_PREFIX}20260410T163045Z${BACKUP_FILE_EXTENSION}`,
    "2026-04-10T16:30:45.000Z",
  );
  await createBackedUpFixture(
    backupDirectory,
    `${BACKUP_FILE_PREFIX}20260410T173045Z${BACKUP_FILE_EXTENSION}`,
    "2026-04-10T17:30:45.000Z",
  );

  const expectedBackupTimestamp = new Date("2026-04-10T18:30:00.000Z");
  const backupResult = await backupOpencodeDatabase({
    sqliteExecutablePath: executablePath,
    databasePath,
    backupDirectory,
    backupRetentionCount: 2,
    timestamp: expectedBackupTimestamp,
  });

  const expectedBackupPath = buildOpencodeDatabaseBackupPath(
    backupDirectory,
    expectedBackupTimestamp,
  );
  const retainedSecondBackupPath = path.join(
    backupDirectory,
    `${BACKUP_FILE_PREFIX}20260410T173045Z${BACKUP_FILE_EXTENSION}`,
  );
  const retainedNewestBackupPath = path.join(
    backupDirectory,
    `${BACKUP_FILE_PREFIX}20260410T183000Z${BACKUP_FILE_EXTENSION}`,
  );

  assert.equal(backupResult.mode, "backup");
  assert.equal(backupResult.backupPath, expectedBackupPath);
  assert.equal(backupResult.prunedBackupPaths.length, 2);
  assert.equal(backupResult.prunedBackupPaths[0], path.join(
    backupDirectory,
    `${BACKUP_FILE_PREFIX}20260410T163045Z${BACKUP_FILE_EXTENSION}`,
  ));
  assert.equal(backupResult.prunedBackupPaths[1], path.join(
    backupDirectory,
    `${BACKUP_FILE_PREFIX}20260410T153045Z${BACKUP_FILE_EXTENSION}`,
  ));
  await readFile(retainedSecondBackupPath, "utf8");
  await readFile(retainedNewestBackupPath, "utf8");
});

test("pruneStaleOpencodeDatabaseBackups_whenDirectoryHasExtraArtifacts_prunesOldestBackups", async () => {
  const backupDirectory = await mkdtemp(
    path.join(tmpdir(), "aicoder-opencode-backup-prune-"),
  );
  await mkdir(backupDirectory, { recursive: true });

  const newestBackupPath = path.join(
    backupDirectory,
    `${BACKUP_FILE_PREFIX}20260410T173045Z${BACKUP_FILE_EXTENSION}`,
  );
  const middleBackupPath = path.join(
    backupDirectory,
    `${BACKUP_FILE_PREFIX}20260410T163045Z${BACKUP_FILE_EXTENSION}`,
  );
  const oldestBackupPath = path.join(
    backupDirectory,
    `${BACKUP_FILE_PREFIX}20260410T153045Z${BACKUP_FILE_EXTENSION}`,
  );

  await writeFile(newestBackupPath, "newest");
  await writeFile(middleBackupPath, "middle");
  await writeFile(oldestBackupPath, "oldest");

  const staleHandle = await open(oldestBackupPath, "r+");
  await staleHandle.utimes(
    new Date("2026-04-10T15:30:45.000Z"),
    new Date("2026-04-10T15:30:45.000Z"),
  );
  await staleHandle.close();

  const middleHandle = await open(middleBackupPath, "r+");
  await middleHandle.utimes(
    new Date("2026-04-10T16:30:45.000Z"),
    new Date("2026-04-10T16:30:45.000Z"),
  );
  await middleHandle.close();

  const newestHandle = await open(newestBackupPath, "r+");
  await newestHandle.utimes(
    new Date("2026-04-10T17:30:45.000Z"),
    new Date("2026-04-10T17:30:45.000Z"),
  );
  await newestHandle.close();

  const prunedBackupPaths = await pruneStaleOpencodeDatabaseBackups(
    backupDirectory,
    2,
  );

  assert.deepEqual(prunedBackupPaths, [oldestBackupPath]);
});
