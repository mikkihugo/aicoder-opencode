import path from "node:path";

export const AUTOPILOT_SERVICE_NAME = "dr-autopilot.service";
export const AUTOPILOT_TIMER_NAME = "dr-autopilot.timer";
export const AUTOPILOT_STATUS_PATH = path.join(".opencode", "state", "autopilot", "status.json");
export const AUTOPILOT_LOCK_PATH = path.join(".opencode", "state", "autopilot", "run.lock");
export const AUTOPILOT_TIMER_INTERVAL_MINUTES = 2;
export const AUTOPILOT_STALE_MILLISECONDS = 5 * 60 * 1000;
export const AUTOPILOT_STALE_TASK_MILLISECONDS = 30 * 60 * 1000;
export const AUTOPILOT_RUNTIME_MAX_SECONDS = 15 * 60;
export const MAX_AGENT_FAILURE_EVENTS = 100;

export function normalizeNextStep(nextStep) {
  if (!nextStep) {
    return "";
  }
  const normalizedNextStep = nextStep.trim();
  if (normalizedNextStep.toLowerCase() === "none") {
    return "";
  }
  return normalizedNextStep;
}

export function activeSlicePathFromPlan(planPath) {
  if (!planPath) {
    return null;
  }
  const directory = path.dirname(planPath);
  if (directory === "docs/plans" || directory === path.join("docs", "plans")) {
    return null;
  }
  return path.join(directory, "active-slice.md");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseInlineField(content, label) {
  const pattern = new RegExp(`\\*\\*${escapeRegex(label)}:\\*\\*\\s*(.+)$`, "mi");
  return content.match(pattern)?.[1]?.trim();
}

export function parseActiveSliceSummary(content) {
  return {
    status: parseInlineField(content, "Status"),
    currentSlice: parseInlineField(content, "Current Slice"),
    nextStep: parseInlineField(content, "Next Step"),
  };
}

export function checkpointNeedsWork(checkpoint, activeSliceSummary) {
  if (!checkpoint?.autonomousIteration) {
    return false;
  }

  const status = String(activeSliceSummary?.status ?? checkpoint.status ?? "").toLowerCase();
  const nextStep = normalizeNextStep(activeSliceSummary?.nextStep ?? checkpoint.nextStep);

  if (status === "done" && !nextStep) {
    return false;
  }

  return true;
}

export function checkpointUpdatedMilliseconds(checkpoint) {
  if (!checkpoint?.updatedAt) {
    return 0;
  }
  const timestamp = Date.parse(checkpoint.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function sessionIsStale(session, nowMilliseconds, staleMilliseconds = AUTOPILOT_STALE_MILLISECONDS) {
  if (!session?.updated) {
    return true;
  }
  return nowMilliseconds - session.updated >= staleMilliseconds;
}

export function taskStartedIsStale(timeCreatedMilliseconds, nowMilliseconds, staleMilliseconds = AUTOPILOT_STALE_TASK_MILLISECONDS) {
  if (!timeCreatedMilliseconds) {
    return false;
  }
  return nowMilliseconds - timeCreatedMilliseconds >= staleMilliseconds;
}

export function trimAgentFailureEvents(failures) {
  if (!Array.isArray(failures) || failures.length <= MAX_AGENT_FAILURE_EVENTS) {
    return Array.isArray(failures) ? failures : [];
  }
  return failures.slice(failures.length - MAX_AGENT_FAILURE_EVENTS);
}

export function chooseAutopilotCheckpoint(checkpoints, activeSliceBySessionID) {
  return [...checkpoints]
    .filter((checkpoint) => checkpointNeedsWork(checkpoint, activeSliceBySessionID.get(checkpoint.sessionID)))
    .sort((left, right) => checkpointUpdatedMilliseconds(right) - checkpointUpdatedMilliseconds(left))[0] ?? null;
}

export function renderAutopilotService(repoRoot) {
  const autopilotExecutable = path.join(repoRoot, ".opencode", "bin", "dr-autopilot");
  return [
    "[Unit]",
    "Description=DR repo autopilot runner",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${repoRoot}`,
    `ExecStart=${autopilotExecutable} run-once`,
    `TimeoutStartSec=${AUTOPILOT_RUNTIME_MAX_SECONDS}`,
    "Nice=10",
    "",
  ].join("\n");
}

export function renderAutopilotTimer() {
  return [
    "[Unit]",
    "Description=DR repo autopilot timer",
    "",
    "[Timer]",
    `OnBootSec=${AUTOPILOT_TIMER_INTERVAL_MINUTES}m`,
    `OnUnitActiveSec=${AUTOPILOT_TIMER_INTERVAL_MINUTES}m`,
    "AccuracySec=30s",
    "Persistent=true",
    `Unit=${AUTOPILOT_SERVICE_NAME}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}
