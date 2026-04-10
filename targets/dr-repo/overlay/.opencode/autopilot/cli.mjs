#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readlink,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AUTOPILOT_SERVICE_NAME,
  MAX_AGENT_FAILURE_EVENTS,
  AUTOPILOT_STALE_MILLISECONDS,
  AUTOPILOT_STALE_TASK_MILLISECONDS,
  AUTOPILOT_STATUS_PATH,
  AUTOPILOT_TIMER_NAME,
  activeSlicePathFromPlan,
  chooseAutopilotCheckpoint,
  parseActiveSliceSummary,
  renderAutopilotService,
  renderAutopilotTimer,
  sessionIsStale,
  taskStartedIsStale,
  trimAgentFailureEvents,
} from "./helpers.mjs";

const execFile = promisify(execFileCallback);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const AUTOPILOT_DIRECTORY = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(AUTOPILOT_DIRECTORY, "..", "..");
const REPO_OPENCODE = path.join(REPO_ROOT, ".opencode", "bin", "opencode");
const USER_SYSTEMD_DIRECTORY = path.join(os.homedir(), ".config", "systemd", "user");
const DEFAULT_OPENCODE_DATA_HOME = path.join(REPO_ROOT, ".opencode", "xdg-data");
const OPENCODE_DATA_HOME = process.env.XDG_DATA_HOME?.trim() || DEFAULT_OPENCODE_DATA_HOME;
const OPENCODE_DB_PATH = path.join(OPENCODE_DATA_HOME, "opencode", "opencode.db");
const COMMAND_TIMEOUT_MILLISECONDS = 60_000;
const STALE_TASK_KILL_WAIT_MILLISECONDS = 5_000;
const AGENT_HEALTH_DIRECTORY = path.join(REPO_ROOT, ".opencode", "state", "agent-health");
const MAINTENANCE_PASSWORD_PATH = "/home/mhugo/code/dr-repo/.opencode/state/maintenance-web/server-password";
const DEFAULT_MAINTENANCE_SERVER_URL = "http://127.0.0.1:8080";
const MAINTENANCE_AUTOMATION_USERNAME = "opencode";
const DEFAULT_AUTOPILOT_MODEL = process.env.DR_AUTOPILOT_MODEL?.trim() || "ollama-cloud/glm-5.1";

function checkpointDirectory() {
  return path.join(REPO_ROOT, ".opencode", "state", "checkpoints");
}

function autopilotStatusFile() {
  return path.join(REPO_ROOT, AUTOPILOT_STATUS_PATH);
}

function agentHealthFile(sessionID) {
  return path.join(AGENT_HEALTH_DIRECTORY, `${sessionID}.json`);
}

async function writeAutopilotStatus(status) {
  await mkdir(path.dirname(autopilotStatusFile()), { recursive: true });
  await writeFile(
    autopilotStatusFile(),
    `${JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

async function loadSessionAgentHealth(sessionID) {
  try {
    const raw = await readFile(agentHealthFile(sessionID), "utf8");
    return JSON.parse(raw);
  } catch {
    return { sessionID, failures: [] };
  }
}

async function recordStaleTaskFailures(staleTaskCalls) {
  const groupedTaskCalls = new Map();
  for (const staleTaskCall of staleTaskCalls) {
    if (!staleTaskCall.subagentType) {
      continue;
    }
    const taskCalls = groupedTaskCalls.get(staleTaskCall.sessionID) ?? [];
    taskCalls.push(staleTaskCall);
    groupedTaskCalls.set(staleTaskCall.sessionID, taskCalls);
  }

  for (const [sessionID, sessionTaskCalls] of groupedTaskCalls.entries()) {
    const existing = await loadSessionAgentHealth(sessionID);
    const failures = trimAgentFailureEvents([
      ...(existing.failures ?? []),
      ...sessionTaskCalls.map((taskCall) => ({
        agent: taskCall.subagentType,
        sessionID,
        detectedAt: new Date().toISOString(),
        reason: "task exceeded stale-task threshold and was reaped by dr-autopilot",
        taskDescription: taskCall.description ?? null,
        tool: "task",
      })),
    ]).slice(-MAX_AGENT_FAILURE_EVENTS);

    await mkdir(path.dirname(agentHealthFile(sessionID)), { recursive: true });
    await writeFile(
      agentHealthFile(sessionID),
      `${JSON.stringify({ sessionID, failures, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  }
}

async function runCommand(command, args, options = {}) {
  return execFile(command, args, {
    cwd: REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MILLISECONDS,
    ...options,
  });
}

async function runOpencode(args) {
  return runCommand(REPO_OPENCODE, args);
}

function maintenanceServerURL() {
  const baseURL = process.env.DR_MAINTENANCE_SERVER_URL?.trim() || DEFAULT_MAINTENANCE_SERVER_URL;
  
  try {
    if (!existsSync(MAINTENANCE_PASSWORD_PATH)) {
      return baseURL;
    }
    const password = readFileSync(MAINTENANCE_PASSWORD_PATH, "utf8")?.trim();
    if (!password) {
      return baseURL;
    }
    
    const url = new URL(baseURL);
    url.username = MAINTENANCE_AUTOMATION_USERNAME;
    url.password = password;
    return url.toString();
  } catch {
    return baseURL;
  }
}

function maintenanceServerBaseURL() {
  return process.env.DR_MAINTENANCE_SERVER_URL?.trim() || DEFAULT_MAINTENANCE_SERVER_URL;
}

function maintenanceServerPassword() {
  try {
    if (!existsSync(MAINTENANCE_PASSWORD_PATH)) {
      return "";
    }
    return readFileSync(MAINTENANCE_PASSWORD_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

function maintenanceServerAuthHeaders() {
  const password = maintenanceServerPassword();
  if (!password) {
    return {};
  }

  const token = Buffer.from(`${MAINTENANCE_AUTOMATION_USERNAME}:${password}`, "utf8").toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function maintenanceServerIsReachable(serverURL) {
  try {
    const response = await fetch(serverURL, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

async function runSystemctl(args) {
  return runCommand("systemctl", ["--user", ...args]);
}

async function runSqlite(query) {
  return runCommand("sqlite3", [OPENCODE_DB_PATH, query]);
}

async function loadCheckpoint(fileName) {
  try {
    const raw = await readFile(path.join(checkpointDirectory(), fileName), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadActiveSliceSummary(planPath) {
  const activeSlicePath = activeSlicePathFromPlan(planPath);
  if (!activeSlicePath) {
    return null;
  }

  try {
    const raw = await readFile(path.join(REPO_ROOT, activeSlicePath), "utf8");
    return parseActiveSliceSummary(raw);
  } catch {
    return null;
  }
}

async function listCheckpoints() {
  try {
    const entries = await readdir(checkpointDirectory());
    const checkpoints = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => loadCheckpoint(entry)),
    );
    return checkpoints.filter(Boolean);
  } catch {
    return [];
  }
}

async function listSessions() {
  try {
    const response = await fetch(new URL("/session", maintenanceServerBaseURL()), {
      headers: maintenanceServerAuthHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const sessions = await response.json();
      return sessions.map((session) => ({
        id: session.id,
        title: session.title,
        updated: session.time?.updated ?? 0,
        created: session.time?.created ?? 0,
        projectId: session.projectID ?? session.projectId ?? null,
        directory: session.directory,
      }));
    }
  } catch {
    // Fall back to the local CLI when the maintenance server is unavailable.
  }

  const { stdout } = await runOpencode(["session", "list", "--format", "json"]);
  const trimmedOutput = stdout.trim();
  if (!trimmedOutput) {
    return [];
  }
  return JSON.parse(trimmedOutput);
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function listStaleRunningTaskCalls(sessionIDs, staleMilliseconds = AUTOPILOT_STALE_TASK_MILLISECONDS) {
  if (!sessionIDs.length) {
    return [];
  }

  const query = [
    "select session_id, time_created,",
    "json_extract(data, '$.state.input.description'),",
    "json_extract(data, '$.state.input.subagent_type')",
    "from part",
    "where json_extract(data, '$.type') = 'tool'",
    "and json_extract(data, '$.tool') = 'task'",
    "and json_extract(data, '$.state.status') = 'running'",
    `and session_id in (${sessionIDs.map(quoteSqlString).join(", ")})`,
    "order by time_created desc;",
  ].join(" ");

  try {
    const { stdout } = await runSqlite(query);
    const nowMilliseconds = Date.now();
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sessionID, timeCreatedText, description, subagentType] = line.split("|");
        const timeCreated = Number(timeCreatedText);
        return {
          sessionID,
          timeCreated,
          description: description || null,
          subagentType: subagentType || null,
          minutesRunning: Math.floor((nowMilliseconds - timeCreated) / (60 * 1000)),
        };
      })
      .filter((taskCall) => taskStartedIsStale(taskCall.timeCreated, nowMilliseconds, staleMilliseconds));
  } catch (error) {
    await writeAutopilotStatus({
      action: "degraded",
      reason: `SQLite query failed: ${error?.code ?? error?.message ?? "unknown error"}. Stale-task reaping is disabled for this run.`,
    });
    return [];
  }
}

async function listRepoPureOpencodeProcesses() {
  const { stdout } = await runCommand("ps", ["-eo", "pid=,args="]);
  const processLines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const processes = [];
  for (const processLine of processLines) {
    const pidMatch = processLine.match(/^(\d+)\s+(.+)$/);
    if (!pidMatch) {
      continue;
    }

    const pid = Number(pidMatch[1]);
    const command = pidMatch[2];
    if (!command.includes("opencode") || !command.includes("--pure")) {
      continue;
    }

    if (
      command.includes(" --pure web") ||
      command.includes(" --pure serve") ||
      /\bopencode\b.*\bweb\b/.test(command)
    ) {
      continue;
    }

    try {
      const cwd = await readlink(`/proc/${pid}/cwd`);
      if (cwd !== REPO_ROOT) {
        continue;
      }
      processes.push({ pid, command });
    } catch {
      continue;
    }
  }

  return processes;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reapStaleRunningTasks(sessions) {
  const staleTaskCalls = await listStaleRunningTaskCalls(
    sessions.map((session) => session.id),
  );
  if (!staleTaskCalls.length) {
    return { reaped: false, staleTaskCalls: [] };
  }

  const repoProcesses = await listRepoPureOpencodeProcesses();
  if (!repoProcesses.length) {
    await recordStaleTaskFailures(staleTaskCalls);
    await writeAutopilotStatus({
      action: "stale-task-detected",
      reason: "Stale task calls were detected, but no repo-local --pure OpenCode process was found to reap.",
      staleTaskCalls,
    });
    return { reaped: false, staleTaskCalls };
  }

  for (const repoProcess of repoProcesses) {
    try {
      process.kill(repoProcess.pid, "SIGTERM");
    } catch {
      // ignore
    }
  }

  await sleep(STALE_TASK_KILL_WAIT_MILLISECONDS);

  for (const repoProcess of repoProcesses) {
    try {
      process.kill(repoProcess.pid, 0);
      process.kill(repoProcess.pid, "SIGKILL");
    } catch {
      // process already exited
    }
  }

  await writeAutopilotStatus({
    action: "reaped-stale-task",
    reason: "Reaped repo-local OpenCode processes because a task call was still running after the stale-task threshold.",
    staleTaskCalls,
    killedProcessIDs: repoProcesses.map((repoProcess) => repoProcess.pid),
  });

  await recordStaleTaskFailures(staleTaskCalls);

  return { reaped: true, staleTaskCalls };
}

async function findAutopilotTarget() {
  const checkpoints = await listCheckpoints();
  const activeSliceBySessionID = new Map();

  for (const checkpoint of checkpoints) {
    activeSliceBySessionID.set(
      checkpoint.sessionID,
      await loadActiveSliceSummary(checkpoint.planPath),
    );
  }

  return chooseAutopilotCheckpoint(checkpoints, activeSliceBySessionID);
}

async function installSystemdUnits() {
  await mkdir(USER_SYSTEMD_DIRECTORY, { recursive: true });
  await writeFile(
    path.join(USER_SYSTEMD_DIRECTORY, AUTOPILOT_SERVICE_NAME),
    `${renderAutopilotService(REPO_ROOT)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(USER_SYSTEMD_DIRECTORY, AUTOPILOT_TIMER_NAME),
    renderAutopilotTimer(),
    "utf8",
  );
  await runSystemctl(["daemon-reload"]);
}

async function querySystemdState() {
  const readState = async (args) => {
    try {
      const { stdout } = await runSystemctl(args);
      return stdout.trim();
    } catch (error) {
      if (error && typeof error === "object" && "stdout" in error) {
        const state = String(error.stdout ?? "").trim();
        if (state) {
          return state;
        }
      }
      return "unknown";
    }
  };

  return {
    enabled: await readState(["is-enabled", AUTOPILOT_TIMER_NAME]),
    active: await readState(["is-active", AUTOPILOT_TIMER_NAME]),
  };
}

async function runAutopilotOnce() {
  const sessions = await listSessions();
  const staleTaskReap = await reapStaleRunningTasks(sessions);
  if (staleTaskReap.reaped) {
    console.log("dr-autopilot: reaped stale task call after 30 minute threshold");
    return;
  }

  const candidate = await findAutopilotTarget();
  if (!candidate) {
    await writeAutopilotStatus({
      action: "skip",
      reason: "No autonomous checkpoint needs work.",
    });
    console.log("dr-autopilot: no autonomous checkpoint needs work");
    return;
  }

  const session = sessions.find((item) => item.id === candidate.sessionID);
  if (!session) {
    await writeAutopilotStatus({
      action: "skip",
      reason: `Checkpoint session ${candidate.sessionID} is not present in OpenCode sessions.`,
      sessionID: candidate.sessionID,
    });
    console.log(`dr-autopilot: checkpoint session ${candidate.sessionID} is missing`);
    return;
  }

  const nowMilliseconds = Date.now();
  if (!sessionIsStale(session, nowMilliseconds, AUTOPILOT_STALE_MILLISECONDS)) {
    await writeAutopilotStatus({
      action: "skip",
      reason: `Session ${candidate.sessionID} updated recently; assuming it is still active.`,
      sessionID: candidate.sessionID,
    });
    console.log(`dr-autopilot: session ${candidate.sessionID} updated recently; skipping`);
    return;
  }

  await writeAutopilotStatus({
    action: "resume",
    reason: "Autonomous checkpoint is stale and needs a resume cycle.",
    sessionID: candidate.sessionID,
    currentSlice: candidate.currentSlice ?? null,
    nextStep: candidate.nextStep ?? null,
  });

  const agentHealth = await loadSessionAgentHealth(candidate.sessionID);
  const recentFailures = (agentHealth.failures ?? []).slice(-3);
  const failureDigest = recentFailures.length > 0
    ? `\n\nRecent failure context (last ${recentFailures.length} reaped task${recentFailures.length === 1 ? "" : "s"}):\n${recentFailures.map((f) => `- ${f.agent ?? "unknown"} agent: ${f.reason ?? "no reason"} (detected ${f.detectedAt ?? "unknown time"})`).join("\n")}`
    : "";

  const attachURL = maintenanceServerBaseURL();
  const maintenancePassword = maintenanceServerPassword();
  const shouldAttach = await maintenanceServerIsReachable(attachURL);
  const runArguments = [
    "run",
    "--session",
    candidate.sessionID,
    "--command",
    `autopilot${failureDigest}`,
    "--agent",
    "implementation_lead",
    "--model",
    DEFAULT_AUTOPILOT_MODEL,
    ...(shouldAttach ? ["--attach", attachURL, ...(maintenancePassword ? ["--password", maintenancePassword] : [])] : []),
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(
      REPO_OPENCODE,
      runArguments,
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
      },
    );

    child.on("exit", async (code) => {
      await writeAutopilotStatus({
        action: code === 0 ? "completed" : "failed",
        reason: code === 0 ? "Autopilot resume cycle completed." : `Autopilot resume exited with code ${code}.`,
        sessionID: candidate.sessionID,
        exitCode: code ?? -1,
        attachedToServer: shouldAttach,
        attachURL: shouldAttach ? attachURL : null,
      });

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`dr-autopilot run exited with code ${code}`));
    });

    child.on("error", async (error) => {
      await writeAutopilotStatus({
        action: "degraded",
        reason: `Failed to launch opencode: ${error.code === "ENOENT" ? "binary not found at " + REPO_OPENCODE : error.message}`,
        sessionID: candidate.sessionID,
      });
      reject(error);
    });
  });
}

async function showStatus() {
  const target = await findAutopilotTarget();
  const systemdState = await querySystemdState();
  const sessions = await listSessions();
  const staleTaskCalls = await listStaleRunningTaskCalls(
    sessions.map((session) => session.id),
  );
  const attachURL = maintenanceServerURL();
  const maintenanceServerReachable = await maintenanceServerIsReachable(attachURL);
  let lastStatus = null;

  try {
    lastStatus = JSON.parse(await readFile(autopilotStatusFile(), "utf8"));
  } catch {
    lastStatus = null;
  }

  console.log(
    JSON.stringify(
      {
        timer: systemdState,
        maintenanceServer: {
          url: attachURL,
          reachable: maintenanceServerReachable,
        },
        target: target
          ? {
              sessionID: target.sessionID,
              status: target.status ?? null,
              currentSlice: target.currentSlice ?? null,
              nextStep: target.nextStep ?? null,
              updatedAt: target.updatedAt ?? null,
            }
          : null,
        staleTaskCalls,
        lastRun: lastStatus,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const command = process.argv[2] ?? "status";

  switch (command) {
    case "run-once":
      await runAutopilotOnce();
      return;
    case "reap-stuck":
      await reapStaleRunningTasks(await listSessions());
      console.log("dr-autopilot: stale-task reap check completed");
      return;
    case "install-systemd":
      await installSystemdUnits();
      console.log(`dr-autopilot: installed ${AUTOPILOT_SERVICE_NAME} and ${AUTOPILOT_TIMER_NAME}`);
      return;
    case "start":
      await installSystemdUnits();
      await runSystemctl(["enable", "--now", AUTOPILOT_TIMER_NAME]);
      console.log(`dr-autopilot: enabled ${AUTOPILOT_TIMER_NAME}`);
      return;
    case "stop":
      await runSystemctl(["disable", "--now", AUTOPILOT_TIMER_NAME]);
      console.log(`dr-autopilot: disabled ${AUTOPILOT_TIMER_NAME}`);
      return;
    case "status":
      await showStatus();
      return;
    default:
      console.error("usage: dr-autopilot [run-once|reap-stuck|install-systemd|start|stop|status]");
      process.exitCode = 2;
  }
}

await main();
