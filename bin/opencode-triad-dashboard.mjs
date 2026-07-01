#!/home/mhugo/.nix-profile/bin/node

import http from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3012;
const STATUS_TIMEOUT_MS = 6000;
const API_TIMEOUT_MS = 8000;
const LLM_STATS_CACHE_TTL_MS = 30000;
const MODEL_CANARY_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_CANARY_TIMEOUT_MS = 25000;
const LLM_STATS_FETCH_BATCH_SIZE = 4;
const SESSION_STATUS_CACHE_TTL_MS = 30000;
const ACTIVE_SESSION_WINDOW_MS = 45 * 60 * 1000;
const RECENT_SESSION_WINDOW_MS = 72 * 60 * 60 * 1000;
const STALLED_SESSION_WINDOW_MS = 20 * 60 * 1000;
const COMPLETED_SUBAGENT_REPORT_WINDOW_MS = 30 * 60 * 1000;
const EMPTY_STRING = "";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const NO_STORE_CACHE_CONTROL = "no-store, max-age=0";
const execFile = promisify(execFileCallback);
const MODEL_CANARY_PROMPT = "reply with exactly OK";
const OPENCODE_CLI_PATH = process.env.OPENCODE_CLI_PATH?.trim() || "/home/mhugo/.npm-global/bin/opencode";
const MODEL_CANARY_ENV = {
  ...process.env,
  HOME: process.env.HOME || "/home/mhugo",
  USER: process.env.USER || "mhugo",
  LOGNAME: process.env.LOGNAME || "mhugo",
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || "/home/mhugo/.config",
  XDG_DATA_HOME: process.env.XDG_DATA_HOME || "/home/mhugo/.local/share",
  PATH:
    process.env.PATH ||
    "/home/mhugo/.npm-global/bin:/home/mhugo/.nix-profile/bin:/usr/local/bin:/usr/bin:/bin",
};
const BACKENDS = [
  {
    id: "aicoder",
    title: "aicoder-opencode",
    origin: "http://127.0.0.1:8080",
    role: "shared maintenance",
    directory: "/home/mhugo/code/aicoder-opencode",
  },
  {
    id: "dr",
    title: "dr-repo",
    origin: "http://127.0.0.1:8082",
    role: "product repo",
    directory: "/home/mhugo/code/dr-repo",
  },
  {
    id: "letta",
    title: "letta-workspace",
    origin: "http://127.0.0.1:8084",
    role: "product repo",
    directory: "/home/mhugo/code/letta-workspace",
  },
];
const MAINTENANCE_TIMER_WHITELIST = [
  "aicoder-opencode-maintenance.timer",
  "dr-repo-maintenance.timer",
  "letta-workspace-maintenance.timer",
];
const MAIN_SERVICE_BY_BACKEND_ID = {
  aicoder: "aicoder-opencode-main.service",
  dr: "dr-repo-main.service",
  letta: "letta-workspace-main.service",
};
const MODEL_CANARY_ROUTES = [
  { route: "xiaomi-token-plan-ams/mimo-v2-pro", title: "mimo lead", lane: "primary" },
  { route: "kimi-for-coding/kimi-k2-thinking", title: "kimi planner", lane: "primary" },
  { route: "zai-coding-plan/glm-4.7", title: "glm implementor", lane: "primary" },
  { route: "zai-coding-plan/glm-5.1", title: "glm architect", lane: "primary" },
  { route: "minimax/MiniMax-M2.7", title: "minimax reader", lane: "primary" },
  { route: "ollama-cloud/qwen3-coder:480b", title: "qwen reviewer", lane: "primary" },
  { route: "ollama-cloud/qwen3-coder-next", title: "qwen verifier", lane: "primary" },
  { route: "qwen/qwen-3.6-plus", title: "qwen direct", lane: "experimental" },
];
const BACKEND_PORT_BY_ID = {
  aicoder: 8080,
  dr: 8082,
  letta: 8084,
};
const ROOT_SESSION_TITLE_BY_BACKEND_ID = {
  aicoder: "aicoder-opencode",
  dr: "dr-repo",
  letta: "letta-workspace",
};
// LW6 supervision projection: letta-server (not the OpenCode listener on 8084)
// exposes GET /v1/runs/<run_id>/slices returning RunSliceRecord[]. The matrix
// backend proxies that through /api/letta/runs/:runId/slices so the browser
// can stay on the same origin as the rest of the matrix API.
const LETTA_SERVER_BASE_URL = process.env.LETTA_SERVER_BASE_URL ?? "http://127.0.0.1:8283";
// LW8 quota collector — llm-gateway-sidecar publishes a batch /quota endpoint
// on port 4001 with one row per provider (vendor billing URL or subprocess CLI
// probe). The matrix backend proxies it through /api/quota so the dashboard
// can stay on the same origin as the rest of the matrix API.
const SIDECAR_QUOTA_BASE_URL = process.env.SIDECAR_QUOTA_BASE_URL ?? "http://127.0.0.1:4001";
const COMMIT_SESSION_TITLE_PATTERN = /^\[COMMIT\]\s*/;
const ANALYZED_SESSION_TITLE_PATTERN = /^\[ANALYZED\]\s*/;
const STALE_SESSION_TITLE_PATTERN = /^\[STALE\]\s*/;
const GENERATED_SESSION_TITLE_PATTERNS = [
  /^New session - /,
  /^probe-/,
  /^verify-/,
  /^OK$/,
  /^AutoLetta$/,
];
const READ_ONLY_AGENT_NAMES = new Set([
  "architecture_consultant",
  "codebase_explorer",
  "consumer_advocate",
  "critical_reviewer",
  "documentation_researcher",
  "long_context_reader",
  "oracle",
  "planning_analyst",
  "reliability_consultant",
  "roadmap_keeper",
  "security_reviewer",
  "verifier",
]);
const SUBAGENT_TITLE_AGENT_PATTERN = /\(@([^)]+)\s+subagent\)$/;
const READ_TOOL_NAMES = new Set(["read", "glob", "grep", "find"]);
const DISPATCH_TOOL_NAMES = new Set(["task"]);
const PLANNING_TOOL_NAMES = new Set(["todowrite"]);
const PATCH_PART_TYPE = "patch";
const BRANCH_DISPOSITION_PENDING = "pending";
const BRANCH_DISPOSITION_USED = "used";
const BRANCH_DISPOSITION_DISCARDED = "discarded";
const PARENT_PROGRESS_PHASES = new Set(["editing", "verifying", "committed", "waiting"]);
const NON_ACTIONABLE_BRANCH_ARTIFACT_LABELS = new Set([
  "invalid read-only write",
  "run failed",
  "run stalled",
  "session read failed",
]);
const VERIFICATION_HINT_PATTERN =
  /\b(verify|verification|verifier|pytest|pyright|ruff|golangci-lint|go test|bun run build|npm test)\b/i;
const FAILURE_HINT_PATTERN =
  /\b(APIError|HTTP \d{3}|timed out|timeout|failed|error|exception|traceback)\b/i;
const SYSTEMCTL_TIMER_PROPERTIES = [
  "ActiveState",
  "UnitFileState",
  "Result",
  "LastTriggerUSec",
  "NextElapseUSecRealtime",
  "NextElapseUSecMonotonic",
  "LastTriggerUSecMonotonic",
].join(",");
// Monotonic duration tokens from `systemctl show` look like:
//   "2d 23h 57min 17.216520s" · "3min 5s" · "17.216520s" · "1h 2min"
// Realtime units supported: d, h, min, s, ms, us.
const SYSTEMCTL_MONOTONIC_TOKEN_PATTERN = /(\d+(?:\.\d+)?)(d|h|min|ms|us|s)/g;
const MONOTONIC_UNIT_TO_SECONDS = {
  d: 86400,
  h: 3600,
  min: 60,
  s: 1,
  ms: 1 / 1000,
  us: 1 / 1_000_000,
};

const bindHost = process.env.OPENCODE_TRIAD_DASHBOARD_HOST?.trim() || DEFAULT_HOST;
const parsedPort = Number.parseInt(process.env.OPENCODE_TRIAD_DASHBOARD_PORT ?? EMPTY_STRING, 10);
const bindPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
let llmStatsCacheValue = null;
let llmStatsCacheExpiresAt = 0;
let llmStatsCacheInFlight = null;
let modelCanaryCacheValue = null;
let modelCanaryCacheExpiresAt = 0;
let modelCanaryCacheInFlight = null;
const sessionStatusCacheByKey = new Map();

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function backendById(backendID) {
  return BACKENDS.find((backend) => backend.id === backendID) ?? null;
}

function sessionActivityTimestamp(session) {
  const updated = session?.time?.updated;
  if (typeof updated === "number" && Number.isFinite(updated)) {
    return updated;
  }
  const created = session?.time?.created;
  if (typeof created === "number" && Number.isFinite(created)) {
    return created;
  }
  return 0;
}

function sessionIsArchivedByTitle(session) {
  const title = typeof session?.title === "string" ? session.title.trim() : EMPTY_STRING;
  if (title === EMPTY_STRING) {
    return false;
  }
  return (
    STALE_SESSION_TITLE_PATTERN.test(title) ||
    COMMIT_SESSION_TITLE_PATTERN.test(title) ||
    ANALYZED_SESSION_TITLE_PATTERN.test(title) ||
    GENERATED_SESSION_TITLE_PATTERNS.some((pattern) => pattern.test(title))
  );
}

function sessionHasCodeArtifact(session) {
  const summary = session?.summary;
  const fileCount = typeof summary?.files === "number" && Number.isFinite(summary.files) ? summary.files : 0;
  const additions = typeof summary?.additions === "number" && Number.isFinite(summary.additions) ? summary.additions : 0;
  const deletions = typeof summary?.deletions === "number" && Number.isFinite(summary.deletions) ? summary.deletions : 0;
  return fileCount > 0 || additions > 0 || deletions > 0;
}

function sessionHasPatchArtifact(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if (part?.type === PATCH_PART_TYPE) {
        return true;
      }
    }
  }
  return false;
}

function extractSessionAgentName(session, messages) {
  const orderedMessages = normalizeMessages(messages);
  for (let index = orderedMessages.length - 1; index >= 0; index -= 1) {
    const agentName = orderedMessages[index]?.info?.agent;
    if (typeof agentName === "string" && agentName.trim() !== EMPTY_STRING) {
      return agentName.trim();
    }
  }

  const title = typeof session?.title === "string" ? session.title.trim() : EMPTY_STRING;
  const titleMatch = SUBAGENT_TITLE_AGENT_PATTERN.exec(title);
  if (titleMatch?.[1]) {
    return titleMatch[1].trim();
  }

  return null;
}

function detectReadOnlyWriteViolation(session, messages) {
  const agentName = extractSessionAgentName(session, messages);
  if (!agentName || !READ_ONLY_AGENT_NAMES.has(agentName)) {
    return null;
  }

  const hasPatchArtifact = sessionHasPatchArtifact(messages);
  const hasCodeArtifact = sessionHasCodeArtifact(session);
  if (!hasPatchArtifact && !hasCodeArtifact) {
    return null;
  }

  return {
    agentName,
    hasPatchArtifact,
    hasCodeArtifact,
  };
}

function sessionShouldArchiveAsCompletedReport(session, sessionStatus) {
  if (!session?.parentID) {
    return false;
  }
  if (sessionStatus?.status !== "completed") {
    return false;
  }
  if (sessionHasCodeArtifact(session)) {
    return false;
  }
  const activityTimestamp = sessionActivityTimestamp(session);
  if (activityTimestamp <= 0) {
    return true;
  }
  return Date.now() - activityTimestamp > COMPLETED_SUBAGENT_REPORT_WINDOW_MS;
}

function deriveSessionState(session, sessionStatus = null) {
  if (sessionIsArchivedByTitle(session)) {
    return "archived";
  }
  if (sessionShouldArchiveAsCompletedReport(session, sessionStatus)) {
    return "archived";
  }
  const now = Date.now();
  const activityTimestamp = sessionActivityTimestamp(session);
  if (activityTimestamp <= 0) {
    return "archived";
  }
  const idleMs = Math.max(0, now - activityTimestamp);
  if (idleMs <= ACTIVE_SESSION_WINDOW_MS) {
    return "active";
  }
  if (idleMs <= RECENT_SESSION_WINDOW_MS) {
    return "recent";
  }
  return "archived";
}

function displaySessionTitle(session, backendID) {
  const rawTitle = typeof session?.title === "string" ? session.title.trim() : EMPTY_STRING;
  if (!rawTitle) {
    return rawTitle;
  }

  const sessionState = deriveSessionState(session);

  if (
    backendID === "aicoder" &&
    (
      rawTitle === "aicoder-maintenance" ||
      rawTitle === "aicoder-control-plane" ||
      rawTitle === "aicoder-opencode / main / control-plane"
    ) &&
    sessionState === "active"
  ) {
    return ROOT_SESSION_TITLE_BY_BACKEND_ID.aicoder;
  }
  if (
    backendID === "dr" &&
    (
      rawTitle === "dr-repo-maintenance" ||
      rawTitle === "dr-repo-delivery" ||
      rawTitle === "dr-repo / main / delivery" ||
      rawTitle === "dr-repo / main / product"
    ) &&
    sessionState === "active"
  ) {
    return ROOT_SESSION_TITLE_BY_BACKEND_ID.dr;
  }
  if (
    backendID === "letta" &&
    (
      rawTitle === "letta-workspace-maintenance" ||
      rawTitle === "letta-platform" ||
      rawTitle === "letta-workspace / main / platform"
    ) &&
    sessionState === "active"
  ) {
    return ROOT_SESSION_TITLE_BY_BACKEND_ID.letta;
  }

  return rawTitle;
}

function latestMessageTimestamp(message) {
  const completed = message?.info?.time?.completed;
  if (typeof completed === "number" && Number.isFinite(completed)) {
    return completed;
  }
  const created = message?.info?.time?.created;
  if (typeof created === "number" && Number.isFinite(created)) {
    return created;
  }
  return 0;
}

function extractTokenCount(message, tokenKey) {
  const tokenValue = message?.info?.tokens?.[tokenKey];
  return typeof tokenValue === "number" && Number.isFinite(tokenValue) ? tokenValue : null;
}

function normalizeMessages(messages) {
  return [...(Array.isArray(messages) ? messages : [])].sort(
    (leftMessage, rightMessage) => latestMessageTimestamp(leftMessage) - latestMessageTimestamp(rightMessage),
  );
}

function findLatestAssistantMessage(messages) {
  const orderedMessages = normalizeMessages(messages);
  for (let index = orderedMessages.length - 1; index >= 0; index -= 1) {
    const message = orderedMessages[index];
    if (message?.info?.role === "assistant") {
      return message;
    }
  }
  return null;
}

function listToolNames(message) {
  const toolNames = [];
  for (const part of Array.isArray(message?.parts) ? message.parts : []) {
    if (part?.type === "tool" && typeof part.tool === "string" && part.tool.trim() !== EMPTY_STRING) {
      toolNames.push(part.tool.trim());
    }
  }
  return toolNames;
}

function extractMessageTextLines(message) {
  const textLines = [];
  for (const part of Array.isArray(message?.parts) ? message.parts : []) {
    if (typeof part?.text === "string" && part.text.trim() !== EMPTY_STRING) {
      textLines.push(part.text.trim());
    }
  }
  return textLines;
}

function extractLatestMessageSnippet(message) {
  const textLines = extractMessageTextLines(message);
  if (textLines.length === 0) {
    return null;
  }
  const prioritizedLine =
    textLines.find((textLine) => FAILURE_HINT_PATTERN.test(textLine)) ?? textLines[textLines.length - 1];
  return prioritizedLine.replace(/\s+/g, " ").slice(0, 160);
}

function summarizeToolNames(message) {
  const toolNames = listToolNames(message);
  if (toolNames.length === 0) {
    return null;
  }

  const toolCountsByName = new Map();
  for (const toolName of toolNames) {
    toolCountsByName.set(toolName, (toolCountsByName.get(toolName) ?? 0) + 1);
  }

  return [...toolCountsByName.entries()]
    .sort((leftEntry, rightEntry) => {
      if (rightEntry[1] !== leftEntry[1]) {
        return rightEntry[1] - leftEntry[1];
      }
      return leftEntry[0].localeCompare(rightEntry[0]);
    })
    .slice(0, 3)
    .map(([toolName, count]) => (count > 1 ? `${toolName}×${count}` : toolName))
    .join(" · ");
}

function extractLatestRouteLabel(messages) {
  const orderedMessages = normalizeMessages(messages);
  for (let index = orderedMessages.length - 1; index >= 0; index -= 1) {
    const message = orderedMessages[index];
    if (message?.info?.role !== "assistant") {
      continue;
    }

    const routeLabel = buildRouteLabel(message?.info?.providerID, message?.info?.modelID);
    if (routeLabel !== "none yet") {
      return routeLabel;
    }
  }

  return null;
}

function sessionSummaryHasCodeArtifact(session) {
  const fileCount = typeof session?.summary?.files === "number" ? session.summary.files : 0;
  const additions = typeof session?.summary?.additions === "number" ? session.summary.additions : 0;
  const deletions = typeof session?.summary?.deletions === "number" ? session.summary.deletions : 0;
  return fileCount > 0 || additions > 0 || deletions > 0;
}

function sessionSummaryHasUsableBranchOutput(session) {
  if (sessionSummaryHasCodeArtifact(session)) {
    return true;
  }
  const artifactLabel = typeof session?.artifactLabel === "string" ? session.artifactLabel : null;
  if (!artifactLabel) {
    return false;
  }
  return !NON_ACTIONABLE_BRANCH_ARTIFACT_LABELS.has(artifactLabel);
}

function deriveBranchDisposition(session, sessionsByID) {
  if (!session?.parentID) {
    return {
      branchDisposition: null,
      branchDispositionReason: null,
    };
  }

  const parentSession = sessionsByID.get(session.parentID) ?? null;
  if (!parentSession) {
    return {
      branchDisposition: BRANCH_DISPOSITION_DISCARDED,
      branchDispositionReason: "missing parent session",
    };
  }

  const childUpdatedAt = sessionActivityTimestamp(session);
  const parentUpdatedAt = sessionActivityTimestamp(parentSession);
  const hasUsableOutput = sessionSummaryHasUsableBranchOutput(session);
  const artifactLabel = typeof session?.artifactLabel === "string" ? session.artifactLabel : null;

  if (artifactLabel === "invalid read-only write") {
    return {
      branchDisposition: BRANCH_DISPOSITION_DISCARDED,
      branchDispositionReason: "discarded invalid write",
    };
  }

  if (session?.status === "failed" || session?.status === "stalled") {
    return {
      branchDisposition: BRANCH_DISPOSITION_DISCARDED,
      branchDispositionReason: session.status === "failed" ? "discarded failed branch" : "discarded stalled branch",
    };
  }

  if (session?.status === "completed" && !hasUsableOutput) {
    return {
      branchDisposition: BRANCH_DISPOSITION_DISCARDED,
      branchDispositionReason: "discarded empty result",
    };
  }

  if (session?.state === "archived" && !hasUsableOutput) {
    return {
      branchDisposition: BRANCH_DISPOSITION_DISCARDED,
      branchDispositionReason: "discarded archived noise",
    };
  }

  if (
    hasUsableOutput &&
    parentUpdatedAt >= childUpdatedAt &&
    PARENT_PROGRESS_PHASES.has(parentSession?.phase ?? EMPTY_STRING)
  ) {
    return {
      branchDisposition: BRANCH_DISPOSITION_USED,
      branchDispositionReason: "parent advanced after branch output",
    };
  }

  return {
    branchDisposition: BRANCH_DISPOSITION_PENDING,
    branchDispositionReason: hasUsableOutput ? "awaiting parent synthesis" : "awaiting usable output",
  };
}

function buildChangeSummary(session) {
  const fileCount = typeof session?.summary?.files === "number" ? session.summary.files : 0;
  const additions = typeof session?.summary?.additions === "number" ? session.summary.additions : 0;
  const deletions = typeof session?.summary?.deletions === "number" ? session.summary.deletions : 0;

  if (fileCount <= 0 && additions <= 0 && deletions <= 0) {
    return {
      label: null,
      detail: null,
    };
  }

  const fileLabel = `${fileCount} ${fileCount === 1 ? "file" : "files"} changed`;
  const deltaLabel =
    additions > 0 || deletions > 0 ? `+${additions} -${deletions}` : null;

  return {
    label: fileLabel,
    detail: deltaLabel,
  };
}

function deriveSessionPhaseAndArtifact(session, messages, sessionStatus) {
  const title = typeof session?.title === "string" ? session.title.trim() : EMPTY_STRING;
  const latestAssistantMessage = findLatestAssistantMessage(messages);
  const toolNames = listToolNames(latestAssistantMessage);
  const toolSummary = summarizeToolNames(latestAssistantMessage);
  const latestSnippet = extractLatestMessageSnippet(latestAssistantMessage);
  const latestAssistantHasPatch = Array.isArray(latestAssistantMessage?.parts)
    ? latestAssistantMessage.parts.some((part) => part?.type === PATCH_PART_TYPE)
    : false;
  const changeSummary = buildChangeSummary(session);
  const dispatchCount = toolNames.filter((toolName) => DISPATCH_TOOL_NAMES.has(toolName)).length;
  const planningCount = toolNames.filter((toolName) => PLANNING_TOOL_NAMES.has(toolName)).length;
  const readCount = toolNames.filter((toolName) => READ_TOOL_NAMES.has(toolName)).length;
  const verificationHint = latestSnippet ? VERIFICATION_HINT_PATTERN.test(latestSnippet) : false;

  if (sessionStatus.readOnlyWriteViolation) {
    return {
      phase: "blocked",
      artifactLabel: "invalid read-only write",
      artifactDetail:
        `${sessionStatus.readOnlyWriteViolation.agentName} emitted ${
          sessionStatus.readOnlyWriteViolation.hasPatchArtifact ? "patch output" : "file-change summary"
        }`,
    };
  }

  if (COMMIT_SESSION_TITLE_PATTERN.test(title)) {
    return {
      phase: "committed",
      artifactLabel: "commit recorded",
      artifactDetail: title.replace(COMMIT_SESSION_TITLE_PATTERN, EMPTY_STRING).trim() || null,
    };
  }

  if (sessionIsArchivedByTitle(session)) {
    return {
      phase: "waiting",
      artifactLabel: changeSummary.label ?? "archived session",
      artifactDetail: changeSummary.detail ?? latestSnippet ?? toolSummary,
    };
  }

  if (sessionStatus.status === "failed" || sessionStatus.status === "stalled") {
    return {
      phase: "blocked",
      artifactLabel: sessionStatus.status === "failed" ? "run failed" : "run stalled",
      artifactDetail:
        sessionStatus.error ?? latestSnippet ?? changeSummary.label ?? toolSummary ?? "needs operator attention",
    };
  }

  if (latestAssistantHasPatch || changeSummary.label) {
    return {
      phase: "editing",
      artifactLabel: changeSummary.label ?? "patch emitted",
      artifactDetail: changeSummary.detail ?? toolSummary,
    };
  }

  if (verificationHint) {
    return {
      phase: "verifying",
      artifactLabel: "verification running",
      artifactDetail: latestSnippet ?? toolSummary,
    };
  }

  if (dispatchCount > 0) {
    return {
      phase: "dispatching",
      artifactLabel: `${dispatchCount} ${dispatchCount === 1 ? "subagent request" : "subagent requests"}`,
      artifactDetail: toolSummary,
    };
  }

  if (readCount > 0 || planningCount > 0) {
    return {
      phase: "gathering",
      artifactLabel: planningCount > 0 ? "slice planning" : "reading context",
      artifactDetail: toolSummary,
    };
  }

  if (sessionStatus.status === "completed") {
    if (session?.parentID && !sessionHasCodeArtifact(session)) {
      return {
        phase: "gathering",
        artifactLabel: "report complete",
        artifactDetail: latestSnippet ?? toolSummary,
      };
    }
    return {
      phase: "waiting",
      artifactLabel: changeSummary.label,
      artifactDetail: changeSummary.detail,
    };
  }

  return {
    phase: "waiting",
    artifactLabel: toolSummary,
    artifactDetail: latestSnippet,
  };
}

function deriveSessionStatus(session, messages) {
  const orderedMessages = [...(Array.isArray(messages) ? messages : [])].sort(
    (leftMessage, rightMessage) => latestMessageTimestamp(leftMessage) - latestMessageTimestamp(rightMessage),
  );
  const latestMessage = orderedMessages[orderedMessages.length - 1] ?? null;
  const latestMessageRole = latestMessage?.info?.role ?? null;
  const latestFinish = typeof latestMessage?.info?.finish === "string" ? latestMessage.info.finish : null;
  const latestUpdatedAt = sessionActivityTimestamp(session);
  const idleMs = latestUpdatedAt > 0 ? Math.max(0, Date.now() - latestUpdatedAt) : Number.POSITIVE_INFINITY;
  const outputTokens = extractTokenCount(latestMessage, "output");
  const readOnlyWriteViolation = detectReadOnlyWriteViolation(session, messages);
  const selectedAgent = extractSessionAgentName(session, messages);
  const selectedModelRoute = extractLatestRouteLabel(messages);
  const completedAt =
    typeof latestMessage?.info?.time?.completed === "number" && Number.isFinite(latestMessage.info.time.completed)
      ? latestMessage.info.time.completed
      : null;

  if (!latestMessage) {
    return {
      status: "waiting",
      needsAttention: false,
      lastFinish: null,
      selectedAgent,
      selectedModelRoute,
      completedAt,
    };
  }

  if (sessionIsArchivedByTitle(session)) {
    return {
      status: "completed",
      needsAttention: false,
      lastFinish: latestFinish,
      selectedAgent,
      selectedModelRoute,
      completedAt,
    };
  }

  if (readOnlyWriteViolation) {
    return {
      status: "failed",
      needsAttention: true,
      lastFinish: latestFinish,
      error: `${readOnlyWriteViolation.agentName} attempted to write despite read-only role`,
      readOnlyWriteViolation,
      selectedAgent,
      selectedModelRoute,
      completedAt,
    };
  }

  if (latestMessageRole === "user") {
    return {
      status: idleMs > STALLED_SESSION_WINDOW_MS ? "stalled" : "waiting",
      needsAttention: idleMs > STALLED_SESSION_WINDOW_MS,
      lastFinish: null,
      selectedAgent,
      selectedModelRoute,
      completedAt,
    };
  }

  if (latestMessageRole !== "assistant") {
    return {
      status: idleMs > STALLED_SESSION_WINDOW_MS ? "stalled" : "waiting",
      needsAttention: idleMs > STALLED_SESSION_WINDOW_MS,
      lastFinish: latestFinish,
      selectedAgent,
      selectedModelRoute,
      completedAt,
    };
  }

  if (latestMessage?.info?.time?.completed == null) {
    return {
      status: idleMs > STALLED_SESSION_WINDOW_MS ? "stalled" : "running",
      needsAttention: idleMs > STALLED_SESSION_WINDOW_MS,
      lastFinish: latestFinish,
      selectedAgent,
      selectedModelRoute,
      completedAt,
    };
  }

  if (outputTokens === 0) {
    return {
      status: "failed",
      needsAttention: true,
      lastFinish: latestFinish,
      selectedAgent,
      selectedModelRoute,
      completedAt,
    };
  }

  if (latestFinish === "stop") {
    return {
      status: "completed",
      needsAttention: false,
      lastFinish: latestFinish,
      selectedAgent,
      selectedModelRoute,
      completedAt,
    };
  }

  if (latestFinish === "tool-calls") {
    return {
      status: idleMs > STALLED_SESSION_WINDOW_MS ? "stalled" : "running",
      needsAttention: idleMs > STALLED_SESSION_WINDOW_MS,
      lastFinish: latestFinish,
      selectedAgent,
      selectedModelRoute,
      completedAt,
    };
  }

  return {
    status: "failed",
    needsAttention: true,
    lastFinish: latestFinish,
    selectedAgent,
    selectedModelRoute,
    completedAt,
  };
}
async function readSessionStatus(backend, session) {
  const cacheKey = `${backend.id}:${session.id}:${sessionActivityTimestamp(session)}`;
  const cachedStatus = sessionStatusCacheByKey.get(cacheKey);
  if (cachedStatus && cachedStatus.expiresAt > Date.now()) {
    return cachedStatus.value;
  }

  let nextValue;
  try {
    const messages = await readBackendMessages(backend, session.id);
    const sessionStatus = deriveSessionStatus(session, messages);
    nextValue = {
      ...sessionStatus,
      ...deriveSessionPhaseAndArtifact(session, messages, sessionStatus),
    };
  } catch (error) {
    nextValue = {
      status: "failed",
      phase: "blocked",
      needsAttention: true,
      lastFinish: null,
      artifactLabel: "session read failed",
      artifactDetail: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  sessionStatusCacheByKey.set(cacheKey, {
    expiresAt: Date.now() + SESSION_STATUS_CACHE_TTL_MS,
    value: nextValue,
  });
  return nextValue;
}

function normalizeSessionList(sessions) {
  return [...(Array.isArray(sessions) ? sessions : [])]
    .sort(
      (leftSession, rightSession) =>
        sessionActivityTimestamp(rightSession) - sessionActivityTimestamp(leftSession),
    );
}

function createEmptyLlmStats() {
  return {
    loadedSessionCount: 0,
    assistantMessageCount: 0,
    providerCount: 0,
    modelCount: 0,
    toolPartCount: 0,
    reasoningPartCount: 0,
    latestRouteLabel: "none yet",
    topRouteLabel: "none yet",
  };
}

function buildRouteLabel(providerID, modelID) {
  const rawRouteLabel = [providerID, modelID].filter(Boolean).join("/");
  return rawRouteLabel || "none yet";
}

function parseJsonLines(rawOutput) {
  return String(rawOutput ?? EMPTY_STRING)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function summarizeCanaryEvents(events) {
  let finishReason = null;
  let tokens = null;
  const textParts = [];

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const part = event.part;
    if (event.type === "text" && part && typeof part.text === "string") {
      textParts.push(part.text.trim());
      continue;
    }
    if (event.type === "step_finish" && part && typeof part === "object") {
      finishReason = typeof part.reason === "string" ? part.reason : null;
      tokens = part.tokens && typeof part.tokens === "object" ? part.tokens : null;
    }
  }

  return {
    text: textParts.filter(Boolean).join("\n").trim(),
    finishReason,
    tokens,
  };
}

async function runModelCanaryProbe(modelCanary) {
  const startedAt = Date.now();
  const commandArguments = [
    "run",
    "--format",
    "json",
    "-m",
    modelCanary.route,
    MODEL_CANARY_PROMPT,
  ];

  try {
    const { stdout, stderr } = await execFile(OPENCODE_CLI_PATH, commandArguments, {
      cwd: "/tmp",
      env: MODEL_CANARY_ENV,
      timeout: MODEL_CANARY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const { text, finishReason, tokens } = summarizeCanaryEvents(parseJsonLines(stdout));
    return {
      route: modelCanary.route,
      title: modelCanary.title,
      lane: modelCanary.lane,
      ok:
        text === "OK" &&
        finishReason === "stop" &&
        tokens &&
        typeof tokens.output === "number" &&
        tokens.output > 0,
      text,
      finishReason,
      tokens,
      durationMs: Date.now() - startedAt,
      stderr: String(stderr ?? EMPTY_STRING).trim() || null,
      error: null,
    };
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : EMPTY_STRING;
    const stderr = typeof error?.stderr === "string" ? error.stderr : EMPTY_STRING;
    const { text, finishReason, tokens } = summarizeCanaryEvents(parseJsonLines(stdout));
    return {
      route: modelCanary.route,
      title: modelCanary.title,
      lane: modelCanary.lane,
      ok: false,
      text,
      finishReason,
      tokens,
      durationMs: Date.now() - startedAt,
      stderr: stderr.trim() || null,
      error:
        error && typeof error === "object" && error.killed
          ? `timeout after ${MODEL_CANARY_TIMEOUT_MS}ms`
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

function mergeRouteCounts(targetRouteCounts, sourceRouteCounts) {
  for (const [routeLabel, routeCount] of sourceRouteCounts.entries()) {
    targetRouteCounts.set(routeLabel, (targetRouteCounts.get(routeLabel) ?? 0) + routeCount);
  }
}

function summarizeMessages(messages, loadedSessionCount) {
  const providerIDs = new Set();
  const modelIDs = new Set();
  const routeCountsByLabel = new Map();
  let assistantMessageCount = 0;
  let toolPartCount = 0;
  let reasoningPartCount = 0;
  let latestRouteLabel = "none yet";
  let latestRouteTimestamp = 0;

  for (const message of Array.isArray(messages) ? messages : []) {
    const info = message?.info ?? {};
    const parts = Array.isArray(message?.parts) ? message.parts : [];

    for (const part of parts) {
      if (part?.type === "tool") {
        toolPartCount += 1;
      }
      if (part?.type === "reasoning") {
        reasoningPartCount += 1;
      }
    }

    if (info.role !== "assistant") {
      continue;
    }

    assistantMessageCount += 1;
    if (typeof info.providerID === "string" && info.providerID.trim() !== EMPTY_STRING) {
      providerIDs.add(info.providerID);
    }
    if (typeof info.modelID === "string" && info.modelID.trim() !== EMPTY_STRING) {
      modelIDs.add(info.modelID);
    }

    const routeLabel = buildRouteLabel(info.providerID, info.modelID);
    // Track chronological latest instead of iteration-order latest — otherwise
    // whichever session happens to land last in the flattened stream wins,
    // and a long-abandoned session can freeze `latestRouteLabel` forever.
    const messageTimestamp =
      (typeof info.time?.completed === "number" ? info.time.completed : 0) ||
      (typeof info.time?.created === "number" ? info.time.created : 0);
    if (messageTimestamp >= latestRouteTimestamp) {
      latestRouteTimestamp = messageTimestamp;
      latestRouteLabel = routeLabel;
    }
    routeCountsByLabel.set(routeLabel, (routeCountsByLabel.get(routeLabel) ?? 0) + 1);
  }

  let topRouteLabel = "none yet";
  let topRouteCount = 0;
  for (const [routeLabel, routeCount] of routeCountsByLabel.entries()) {
    if (routeCount > topRouteCount) {
      topRouteLabel = routeLabel;
      topRouteCount = routeCount;
    }
  }

  return {
    loadedSessionCount,
    assistantMessageCount,
    providerCount: providerIDs.size,
    modelCount: modelIDs.size,
    toolPartCount,
    reasoningPartCount,
    latestRouteLabel,
    latestRouteTimestamp,
    topRouteLabel,
    routeCountsByLabel,
    providerIDs,
    modelIDs,
  };
}

function makePublicLlmStats(stats) {
  return {
    loadedSessionCount: stats.loadedSessionCount,
    assistantMessageCount: stats.assistantMessageCount,
    providerCount: stats.providerCount,
    modelCount: stats.modelCount,
    toolPartCount: stats.toolPartCount,
    reasoningPartCount: stats.reasoningPartCount,
    latestRouteLabel: stats.latestRouteLabel,
    topRouteLabel: stats.topRouteLabel,
  };
}

async function mapInBatches(items, batchSize, worker) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const batchResults = await Promise.all(batch.map(worker));
    results.push(...batchResults);
  }
  return results;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonRequest(request) {
  const text = await readRequestBody(request);
  if (text.trim() === EMPTY_STRING) {
    return {};
  }
  return JSON.parse(text);
}

async function fetchBackend(backend, requestPath, options = {}) {
  const response = await fetch(`${backend.origin}${requestPath}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
    ...options,
  });
  return response;
}

async function fetchBackendJson(backend, requestPath, options = {}) {
  const response = await fetchBackend(backend, requestPath, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function probeBackend(backend) {
  try {
    const response = await fetchBackend(backend, "/app", { method: "GET", timeoutMs: STATUS_TIMEOUT_MS });
    return {
      id: backend.id,
      title: backend.title,
      role: backend.role,
      origin: backend.origin,
      directory: backend.directory,
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      id: backend.id,
      title: backend.title,
      role: backend.role,
      origin: backend.origin,
      directory: backend.directory,
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Parse `systemctl --user show <unit> --property=X,Y,Z` output.
 * Returns an object of Property -> Value strings.
 */
function parseSystemctlShowOutput(stdout) {
  const properties = {};
  for (const line of stdout.split("\n")) {
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex);
    const value = line.slice(equalsIndex + 1);
    properties[key] = value;
  }
  return properties;
}

/**
 * Convert systemd timestamp strings like "Mon 2026-04-13 10:00:16 CEST"
 * (the default `systemctl show` format) to ISO string or null.
 * V8's Date.parse does not accept the weekday prefix or most TZ abbreviations,
 * so we extract the YYYY-MM-DD HH:MM:SS portion and parse it as local time.
 */
const SYSTEMCTL_TIMESTAMP_PATTERN = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/;

function parseSystemctlTimestamp(value) {
  if (!value || value === "n/a" || value === "0") return null;
  const match = value.match(SYSTEMCTL_TIMESTAMP_PATTERN);
  if (!match) return null;
  const [, year, month, day, hours, minutes, seconds] = match;
  const localDate = new Date(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hours, 10),
    Number.parseInt(minutes, 10),
    Number.parseInt(seconds, 10),
  );
  const timestamp = localDate.getTime();
  if (Number.isNaN(timestamp)) return null;
  return localDate.toISOString();
}

/**
 * Parse a systemctl monotonic duration string like "2d 23h 57min 17.216520s"
 * into a total number of seconds (float). Returns null when no tokens match.
 */
function parseSystemctlMonotonicDuration(value) {
  if (!value || value.trim() === EMPTY_STRING) return null;
  let totalSeconds = 0;
  let matched = false;
  for (const match of value.matchAll(SYSTEMCTL_MONOTONIC_TOKEN_PATTERN)) {
    const amount = Number.parseFloat(match[1]);
    const unit = match[2];
    const multiplier = MONOTONIC_UNIT_TO_SECONDS[unit];
    if (!Number.isFinite(amount) || multiplier === undefined) continue;
    totalSeconds += amount * multiplier;
    matched = true;
  }
  return matched ? totalSeconds : null;
}

/**
 * Read CLOCK_BOOTTIME epoch seconds from /proc/stat once. systemd reports
 * monotonic timestamps as "time since boot", so wall-clock next-fire =
 * btime + monotonic_seconds. Returns null if /proc/stat is unreadable.
 *
 * NOTE: does not correct for suspend/resume drift — monotonic clock freezes
 * during S3 suspend but btime does not, so a post-resume read can drift by
 * the suspended duration. For an always-on workstation this is fine.
 */
let cachedBootTimeEpochSeconds = null;
function readBootTimeEpochSeconds() {
  if (cachedBootTimeEpochSeconds !== null) return cachedBootTimeEpochSeconds;
  try {
    const statText = readFileSync("/proc/stat", "utf8");
    const match = statText.match(/^btime (\d+)/m);
    if (!match) return null;
    cachedBootTimeEpochSeconds = Number.parseInt(match[1], 10);
    return cachedBootTimeEpochSeconds;
  } catch {
    return null;
  }
}

/**
 * Convert a systemd monotonic duration + /proc/stat btime into an ISO string.
 * Used as a fallback when `NextElapseUSecRealtime` is empty — which happens
 * for timers defined with `OnBootSec=`/`OnUnitActiveSec=` rather than
 * `OnCalendar=`, because systemd stores their schedule in monotonic time only.
 */
function convertMonotonicDurationToIsoString(monotonicValue) {
  const bootTimeEpochSeconds = readBootTimeEpochSeconds();
  if (bootTimeEpochSeconds === null) return null;
  const monotonicSeconds = parseSystemctlMonotonicDuration(monotonicValue);
  if (monotonicSeconds === null) return null;
  const epochMilliseconds = Math.round((bootTimeEpochSeconds + monotonicSeconds) * 1000);
  if (!Number.isFinite(epochMilliseconds)) return null;
  return new Date(epochMilliseconds).toISOString();
}

async function readMaintenanceTimerStatus(unit) {
  try {
    const { stdout } = await execFile("systemctl", [
      "--user",
      "show",
      unit,
      `--property=${SYSTEMCTL_TIMER_PROPERTIES}`,
    ]);
    const props = parseSystemctlShowOutput(stdout);
    // Monotonic timers (OnBootSec/OnUnitActiveSec) leave NextElapseUSecRealtime
    // empty and only populate NextElapseUSecMonotonic — fall back to that so
    // the sidebar stops rendering "next: never" for healthy periodic timers.
    const nextFireAt =
      parseSystemctlTimestamp(props.NextElapseUSecRealtime) ??
      convertMonotonicDurationToIsoString(props.NextElapseUSecMonotonic);
    return {
      unit,
      enabled: props.UnitFileState === "enabled",
      active: props.ActiveState === "active",
      activeState: props.ActiveState ?? "unknown",
      lastResult: props.Result ?? "unknown",
      lastFireAt: parseSystemctlTimestamp(props.LastTriggerUSec),
      nextFireAt,
    };
  } catch (error) {
    return {
      unit,
      enabled: false,
      active: false,
      activeState: "error",
      lastResult: "error",
      lastFireAt: null,
      nextFireAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readMainServicePid(serviceName) {
  try {
    const { stdout } = await execFile("systemctl", ["--user", "show", serviceName, "--property=MainPID"]);
    const props = parseSystemctlShowOutput(stdout);
    const pid = Number.parseInt(props.MainPID ?? "0", 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Read the parent PID of a process via `ps -o ppid= -p <pid>`.
 * Returns null when the process is missing or ps is unavailable.
 */
async function readProcessParentPid(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFile("ps", ["-o", "ppid=", "-p", String(pid)]);
    const parsedPid = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(parsedPid) && parsedPid > 0 ? parsedPid : null;
  } catch {
    return null;
  }
}

/**
 * Read listening TCP ports owned by `.opencode` processes via `ss -tlnp`.
 * Returns a Map of port -> pid (primary pid, the first one).
 */
async function readListeningOpencodePorts() {
  const portToPid = new Map();
  try {
    const { stdout } = await execFile("ss", ["-tlnp"]);
    for (const line of stdout.split("\n")) {
      if (!line.includes(".opencode")) continue;
      // Example:
      // LISTEN 0 512 127.0.0.1:8082 0.0.0.0:* users:((".opencode",pid=73710,fd=18))
      const portMatch = line.match(/127\.0\.0\.1:(\d+)/);
      const pidMatch = line.match(/pid=(\d+)/);
      if (portMatch && pidMatch) {
        const port = Number.parseInt(portMatch[1], 10);
        const pid = Number.parseInt(pidMatch[1], 10);
        if (Number.isFinite(port) && Number.isFinite(pid)) {
          portToPid.set(port, pid);
        }
      }
    }
  } catch {
    // ss not available — return empty map
  }
  return portToPid;
}

/**
 * Compute latest session activity (ISO) and session count for a backend,
 * reusing the session list already fetched by listBackendSessions.
 */
function computeBackendActivity(sessions) {
  let latest = 0;
  for (const session of sessions) {
    const updated = session?.time?.updated ?? 0;
    if (typeof updated === "number" && updated > latest) latest = updated;
  }
  return {
    sessionCount: sessions.length,
    lastActivityAt: latest > 0 ? new Date(latest).toISOString() : null,
    idleSeconds: latest > 0 ? Math.floor((Date.now() - latest) / 1000) : null,
  };
}

async function readBackendOpsSessionState(backend) {
  try {
    const sessions = await listBackendSessions(backend);
    return {
      sessions,
      error: null,
    };
  } catch (error) {
    return {
      sessions: [],
      error: error instanceof Error ? error.message : "session list failed",
    };
  }
}

async function collectOpsStatus() {
  const [timerStatuses, listeningPorts, ...mainPidsAndSessions] = await Promise.all([
    Promise.all(MAINTENANCE_TIMER_WHITELIST.map(readMaintenanceTimerStatus)),
    readListeningOpencodePorts(),
    ...BACKENDS.map(async (backend) => {
      const [mainPid, sessionState] = await Promise.all([
        readMainServicePid(MAIN_SERVICE_BY_BACKEND_ID[backend.id]),
        readBackendOpsSessionState(backend),
      ]);
      return { backend, mainPid, sessionState };
    }),
  ]);

  const listeningParentPidEntries = await Promise.all(
    Array.from(listeningPorts.entries()).map(async ([port, pid]) => [port, await readProcessParentPid(pid)]),
  );
  const listeningParentPidByPort = new Map(listeningParentPidEntries);
  const managedServicePids = new Set(
    mainPidsAndSessions.map(({ mainPid }) => mainPid).filter((mainPid) => mainPid != null),
  );

  const backendOps = mainPidsAndSessions.map(({ backend, mainPid, sessionState }) => {
    const port = BACKEND_PORT_BY_ID[backend.id] ?? null;
    const listeningPid = port != null ? listeningPorts.get(port) ?? null : null;
    const listeningParentPid = port != null ? listeningParentPidByPort.get(port) ?? null : null;
    const isManagedByService =
      mainPid != null &&
      listeningPid != null &&
      (listeningPid === mainPid || listeningParentPid === mainPid);
    const activity = computeBackendActivity(sessionState.sessions);
    return {
      id: backend.id,
      title: backend.title,
      port,
      listening: listeningPid != null,
      listeningPid,
      managedPid: mainPid,
      managed: isManagedByService,
      sessionCount: activity.sessionCount,
      lastActivityAt: activity.lastActivityAt,
      idleSeconds: activity.idleSeconds,
      error: sessionState.error,
    };
  });

  const knownBackendPorts = new Set(Object.values(BACKEND_PORT_BY_ID));
  const strayServers = [];
  for (const [port, pid] of listeningPorts.entries()) {
    const parentPid = listeningParentPidByPort.get(port) ?? null;
    const managed =
      managedServicePids.has(pid) || (parentPid != null && managedServicePids.has(parentPid));
    if (knownBackendPorts.has(port) && managed) continue;
    if (!managed) {
      strayServers.push({ port, pid, managed: false });
    }
  }

  return {
    generatedAt: Date.now(),
    backends: backendOps,
    timers: timerStatuses,
    strayServers,
  };
}

async function runMaintenanceTimerAction(unit, action) {
  if (!MAINTENANCE_TIMER_WHITELIST.includes(unit)) {
    throw new Error(`unit not in whitelist: ${unit}`);
  }
  if (action !== "start" && action !== "stop") {
    throw new Error(`unsupported action: ${action}`);
  }
  await execFile("systemctl", ["--user", action, unit]);
  return readMaintenanceTimerStatus(unit);
}

async function runBackendServiceAction(backendId, action) {
  const serviceName = MAIN_SERVICE_BY_BACKEND_ID[backendId];
  if (!serviceName) {
    throw new Error(`unknown backend: ${backendId}`);
  }
  if (action !== "start" && action !== "stop" && action !== "restart") {
    throw new Error(`unsupported action: ${action}`);
  }

  if (action === "restart") {
    // Sequential stop + start so failure is explicit and mid-state is observable
    await execFile("systemctl", ["--user", "stop", serviceName]);
    await execFile("systemctl", ["--user", "start", serviceName]);
  } else {
    await execFile("systemctl", ["--user", action, serviceName]);
  }

  const mainPid = await readMainServicePid(serviceName);
  return {
    service: serviceName,
    backendId,
    action,
    mainPid,
    running: mainPid != null,
  };
}

async function readBackendConfig(backend) {
  return fetchBackendJson(backend, "/config");
}

async function listBackendSessions(backend) {
  const encodedDirectory = encodeURIComponent(backend.directory);
  return fetchBackendJson(backend, `/session?directory=${encodedDirectory}`);
}

async function createBackendSession(backend, title) {
  const encodedDirectory = encodeURIComponent(backend.directory);
  const response = await fetchBackend(backend, `/session?directory=${encodedDirectory}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function deleteBackendSession(backend, sessionID) {
  const encodedSessionID = encodeURIComponent(sessionID);
  const response = await fetchBackend(backend, `/session/${encodedSessionID}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

async function readBackendMessages(backend, sessionID) {
  const encodedDirectory = encodeURIComponent(backend.directory);
  const encodedSessionID = encodeURIComponent(sessionID);
  return fetchBackendJson(backend, `/session/${encodedSessionID}/message?directory=${encodedDirectory}`);
}

async function sendBackendMessage(backend, sessionID, text, agentName) {
  const encodedDirectory = encodeURIComponent(backend.directory);
  const encodedSessionID = encodeURIComponent(sessionID);
  const body = {
    parts: [
      {
        type: "text",
        text,
      },
    ],
  };

  if (agentName && agentName.trim() !== EMPTY_STRING) {
    body.agent = agentName.trim();
  }

  const response = await fetchBackend(backend, `/session/${encodedSessionID}/message?directory=${encodedDirectory}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    timeoutMs: 30000,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  await response.body?.cancel().catch(() => {});
  return {
    accepted: true,
    status: response.status,
    sessionID,
    agent: body.agent ?? null,
  };
}

async function collectBackendSummary() {
  return Promise.all(
    BACKENDS.map(async (backend) => {
      const status = await probeBackend(backend);
      if (!status.ok) {
        return { ...status, sessions: [], defaultAgent: null, agentNames: [] };
      }

      try {
        const [config, sessions] = await Promise.all([readBackendConfig(backend), listBackendSessions(backend)]);
        const normalizedSessions = normalizeSessionList(sessions);
        const sessionsWithStatus = await mapInBatches(
          normalizedSessions,
          LLM_STATS_FETCH_BATCH_SIZE,
          async (session) => {
            const sessionStatus = await readSessionStatus(backend, session);
            const sessionState = deriveSessionState(session, sessionStatus);
            return {
              ...session,
              title: displaySessionTitle(session, backend.id),
              state: sessionState,
              status: sessionStatus.status,
              phase: sessionStatus.phase,
              needsAttention: sessionState === "archived" ? false : sessionStatus.needsAttention,
              lastFinish: sessionStatus.lastFinish,
              artifactLabel: sessionStatus.artifactLabel,
              artifactDetail: sessionStatus.artifactDetail,
              selectedAgent: sessionStatus.selectedAgent ?? null,
              selectedModelRoute: sessionStatus.selectedModelRoute ?? null,
              completedAt: sessionStatus.completedAt ?? null,
            };
          },
        );
        const sessionsByID = new Map(sessionsWithStatus.map((session) => [session.id, session]));
        const sessionsWithDisposition = sessionsWithStatus.map((session) => {
          const branchDisposition = deriveBranchDisposition(session, sessionsByID);
          const branchNeedsAttention = branchDisposition.branchDisposition === BRANCH_DISPOSITION_DISCARDED
            ? false
            : session.needsAttention;
          return {
            ...session,
            ...branchDisposition,
            needsAttention: branchNeedsAttention,
          };
        });
        return {
          ...status,
          defaultAgent: config.default_agent ?? null,
          agentNames: Object.keys(config.agent ?? {}),
          sessions: sessionsWithDisposition,
        };
      } catch (error) {
        return {
          ...status,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          sessions: [],
          defaultAgent: null,
          agentNames: [],
        };
      }
    }),
  );
}

function summarizeRunBranches(branchSessions) {
  const branchCounts = {
    total: 0,
    pending: 0,
    used: 0,
    discarded: 0,
    attention: 0,
  };

  for (const branchSession of branchSessions) {
    branchCounts.total += 1;

    if (branchSession.branchDisposition === BRANCH_DISPOSITION_PENDING) {
      branchCounts.pending += 1;
    } else if (branchSession.branchDisposition === BRANCH_DISPOSITION_USED) {
      branchCounts.used += 1;
    } else if (branchSession.branchDisposition === BRANCH_DISPOSITION_DISCARDED) {
      branchCounts.discarded += 1;
    }

    if (branchSession.needsAttention) {
      branchCounts.attention += 1;
    }
  }

  return branchCounts;
}

function buildRunSummary(backend, rootSession, branchSessions) {
  return {
    id: rootSession.id,
    sessionID: rootSession.id,
    backendID: backend.id,
    projectID: backend.id,
    title: rootSession.title ?? rootSession.id,
    directory: rootSession.directory ?? backend.directory,
    state: rootSession.state,
    status: rootSession.status,
    phase: rootSession.phase,
    needsAttention: rootSession.needsAttention,
    artifactLabel: rootSession.artifactLabel ?? null,
    artifactDetail: rootSession.artifactDetail ?? null,
    selectedAgent: rootSession.selectedAgent ?? null,
    selectedModelRoute: rootSession.selectedModelRoute ?? null,
    branchCounts: summarizeRunBranches(branchSessions),
    time: rootSession.time ?? {},
    completedAt: rootSession.completedAt ?? null,
  };
}

async function collectRunsSummary() {
  const backends = await collectBackendSummary();
  return {
    generatedAt: Date.now(),
    backends: backends.map((backend) => {
      const branchSessionsByParentID = new Map();
      for (const session of backend.sessions) {
        if (!session.parentID) {
          continue;
        }

        const branchSessions = branchSessionsByParentID.get(session.parentID) ?? [];
        branchSessions.push(session);
        branchSessionsByParentID.set(session.parentID, branchSessions);
      }

      return {
        id: backend.id,
        title: backend.title,
        role: backend.role,
        ok: backend.ok,
        status: backend.status,
        error: backend.error ?? null,
        runs: backend.sessions
          .filter((session) => !session.parentID)
          .map((rootSession) => buildRunSummary(backend, rootSession, branchSessionsByParentID.get(rootSession.id) ?? [])),
      };
    }),
  };
}

async function collectBackendLlmStats(backend) {
  const status = await probeBackend(backend);
  if (!status.ok) {
    return {
      id: backend.id,
      title: backend.title,
      role: backend.role,
      ok: false,
      status: status.status,
      error: status.error ?? "backend unavailable",
      stats: createEmptyLlmStats(),
    };
  }

  try {
    const listedSessions = await listBackendSessions(backend);
    const sessions = Array.isArray(listedSessions) ? listedSessions : [];
    // Wrap per-session reads so a single failing session (e.g. mid-write race,
    // transient 500) no longer tanks the entire backend's stats via Promise.all
    // rejection — a failed read just contributes zero messages.
    const sessionMessages = await mapInBatches(
      sessions,
      LLM_STATS_FETCH_BATCH_SIZE,
      async (session) => {
        try {
          return await readBackendMessages(backend, session.id);
        } catch {
          return [];
        }
      },
    );
    const flattenedMessages = sessionMessages.flatMap((messages) => (Array.isArray(messages) ? messages : []));
    const stats = summarizeMessages(flattenedMessages, sessions.length);
    return {
      id: backend.id,
      title: backend.title,
      role: backend.role,
      ok: true,
      status: status.status,
      stats: makePublicLlmStats(stats),
      _providerIDs: stats.providerIDs,
      _modelIDs: stats.modelIDs,
      _routeCountsByLabel: stats.routeCountsByLabel,
      _latestRouteTimestamp: stats.latestRouteTimestamp,
    };
  } catch (error) {
    return {
      id: backend.id,
      title: backend.title,
      role: backend.role,
      ok: false,
      status: status.status,
      error: error instanceof Error ? error.message : String(error),
      stats: createEmptyLlmStats(),
    };
  }
}

async function collectLlmStatsSummary() {
  const currentTimestamp = Date.now();
  if (llmStatsCacheValue && currentTimestamp < llmStatsCacheExpiresAt) {
    return llmStatsCacheValue;
  }
  if (llmStatsCacheInFlight) {
    return llmStatsCacheInFlight;
  }

  llmStatsCacheInFlight = (async () => {
    const backends = await Promise.all(BACKENDS.map((backend) => collectBackendLlmStats(backend)));
    const providerIDs = new Set();
    const modelIDs = new Set();
    const routeCountsByLabel = new Map();
    let assistantMessageCount = 0;
    let loadedSessionCount = 0;
    let toolPartCount = 0;
    let reasoningPartCount = 0;
    let latestRouteLabel = "none yet";
    let latestRouteTimestamp = 0;

    for (const backend of backends) {
      assistantMessageCount += backend.stats.assistantMessageCount;
      loadedSessionCount += backend.stats.loadedSessionCount;
      toolPartCount += backend.stats.toolPartCount;
      reasoningPartCount += backend.stats.reasoningPartCount;

      // Compare by chronological timestamp — otherwise the last backend
      // iterated silently overwrites the true most-recent route label.
      const backendLatestTimestamp = backend._latestRouteTimestamp ?? 0;
      if (
        backend.stats.latestRouteLabel !== "none yet" &&
        backendLatestTimestamp >= latestRouteTimestamp
      ) {
        latestRouteLabel = backend.stats.latestRouteLabel;
        latestRouteTimestamp = backendLatestTimestamp;
      }

      for (const providerID of backend._providerIDs ?? []) {
        providerIDs.add(providerID);
      }
      for (const modelID of backend._modelIDs ?? []) {
        modelIDs.add(modelID);
      }
      mergeRouteCounts(routeCountsByLabel, backend._routeCountsByLabel ?? new Map());

      delete backend._providerIDs;
      delete backend._modelIDs;
      delete backend._routeCountsByLabel;
      delete backend._latestRouteTimestamp;
    }

    let topRouteLabel = "none yet";
    let topRouteCount = 0;
    for (const [routeLabel, routeCount] of routeCountsByLabel.entries()) {
      if (routeCount > topRouteCount) {
        topRouteLabel = routeLabel;
        topRouteCount = routeCount;
      }
    }

    const payload = {
      generatedAt: currentTimestamp,
      cacheTtlMs: LLM_STATS_CACHE_TTL_MS,
      backends,
      total: {
        loadedSessionCount,
        assistantMessageCount,
        providerCount: providerIDs.size,
        modelCount: modelIDs.size,
        toolPartCount,
        reasoningPartCount,
        latestRouteLabel,
        topRouteLabel,
      },
    };

    llmStatsCacheValue = payload;
    llmStatsCacheExpiresAt = Date.now() + LLM_STATS_CACHE_TTL_MS;
    return payload;
  })();

  try {
    return await llmStatsCacheInFlight;
  } finally {
    llmStatsCacheInFlight = null;
  }
}

async function collectModelCanaryStatus({ forceRefresh = false } = {}) {
  const currentTimestamp = Date.now();
  if (!forceRefresh && modelCanaryCacheValue && currentTimestamp < modelCanaryCacheExpiresAt) {
    return modelCanaryCacheValue;
  }
  if (!forceRefresh && modelCanaryCacheInFlight) {
    return modelCanaryCacheInFlight;
  }

  modelCanaryCacheInFlight = (async () => {
    const probes = [];
    for (const modelCanary of MODEL_CANARY_ROUTES) {
      probes.push(await runModelCanaryProbe(modelCanary));
    }

    const okCount = probes.filter((probe) => probe.ok).length;
    const payload = {
      generatedAt: currentTimestamp,
      cacheTtlMs: MODEL_CANARY_CACHE_TTL_MS,
      prompt: MODEL_CANARY_PROMPT,
      probes,
      total: {
        okCount,
        failCount: probes.length - okCount,
      },
    };

    modelCanaryCacheValue = payload;
    modelCanaryCacheExpiresAt = Date.now() + MODEL_CANARY_CACHE_TTL_MS;
    return payload;
  })();

  try {
    return await modelCanaryCacheInFlight;
  } finally {
    modelCanaryCacheInFlight = null;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...JSON_HEADERS,
    "cache-control": NO_STORE_CACHE_CONTROL,
  });
  response.end(JSON.stringify(payload, null, 2));
}

function renderDashboard() {
  const backendLiteral = JSON.stringify(BACKENDS, null, 2);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Singularity Matrix</title>
    <style>
      :root {
        --bg: #101112;
        --panel: #17191b;
        --panel-2: #1f2327;
        --line: #2e3338;
        --text: #f2f3f5;
        --muted: #9aa3ad;
        --accent: #c85a17;
        --accent-2: #e37b40;
        --ok: #7ddc7a;
        --bad: #ff7575;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(200,90,23,.18), transparent 30%),
          linear-gradient(180deg, #0c0d0e 0%, var(--bg) 100%);
        color: var(--text);
        font: 14px/1.4 "JetBrainsMono Nerd Font", "JetBrains Mono", monospace;
      }
      button, input, textarea, select, a {
        font: inherit;
      }
      .shell {
        min-height: 100vh;
        display: grid;
        grid-template-rows: auto 1fr;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        padding: 0.9rem 1rem;
        border-bottom: 1px solid var(--line);
        background: rgba(16, 17, 18, 0.9);
        backdrop-filter: blur(10px);
        position: sticky;
        top: 0;
        z-index: 20;
      }
      .topbar h1 {
        margin: 0;
        font-size: 1rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .topbar p {
        margin: 0.2rem 0 0;
        color: var(--muted);
      }
      .toolbar {
        display: flex;
        gap: 0.6rem;
      }
      button, .link-button, select, textarea, input {
        border: 1px solid var(--line);
        background: var(--panel-2);
        color: var(--text);
        padding: 0.55rem 0.8rem;
        text-decoration: none;
        border-radius: 0.5rem;
      }
      button, .link-button {
        cursor: pointer;
      }
      button:hover, .link-button:hover {
        border-color: var(--accent);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.9rem;
        padding: 0.9rem;
      }
      .card {
        display: grid;
        grid-template-rows: auto auto auto 1fr auto;
        min-height: calc(100vh - 5rem);
        background: linear-gradient(180deg, rgba(31,35,39,.95), rgba(23,25,27,.95));
        border: 1px solid var(--line);
        border-radius: 0.9rem;
        overflow: hidden;
        box-shadow: 0 14px 40px rgba(0,0,0,.28);
      }
      .card.up { border-color: rgba(125,220,122,.28); }
      .card.down { border-color: rgba(255,117,117,.28); }
      .card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 0.8rem;
        padding: 0.9rem;
        border-bottom: 1px solid var(--line);
      }
      .card-header h2 {
        margin: 0;
        font-size: 0.95rem;
      }
      .card-header p {
        margin: 0.2rem 0 0;
        color: var(--muted);
      }
      .status {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        white-space: nowrap;
        color: var(--muted);
      }
      .dot {
        width: 0.65rem;
        height: 0.65rem;
        border-radius: 50%;
        background: var(--line);
      }
      .dot.up { background: var(--ok); box-shadow: 0 0 14px rgba(125,220,122,.6); }
      .dot.down { background: var(--bad); box-shadow: 0 0 14px rgba(255,117,117,.5); }
      .card-actions,
      .composer {
        display: flex;
        gap: 0.55rem;
        padding: 0.75rem 0.9rem;
        border-bottom: 1px solid var(--line);
      }
      .composer {
        border-top: 1px solid var(--line);
        border-bottom: 0;
        flex-direction: column;
      }
      .composer-row {
        display: flex;
        gap: 0.55rem;
      }
      .composer textarea {
        width: 100%;
        min-height: 6rem;
        resize: vertical;
      }
      .body {
        display: grid;
        grid-template-columns: 18rem 1fr;
        min-height: 0;
      }
      .sessions {
        border-right: 1px solid var(--line);
        overflow: auto;
        min-height: 0;
      }
      .session-row {
        width: 100%;
        text-align: left;
        border: 0;
        border-bottom: 1px solid rgba(46,51,56,.65);
        border-radius: 0;
        background: transparent;
        padding: 0.8rem 0.9rem;
      }
      .session-row.active {
        background: rgba(200,90,23,.12);
      }
      .session-row strong {
        display: block;
      }
      .session-row small {
        display: block;
        color: var(--muted);
        margin-top: 0.25rem;
      }
      .session-tree {
        padding: 0.35rem 0;
      }
      .session-group {
        border-bottom: 1px solid rgba(46,51,56,.45);
      }
      .session-children {
        padding-left: 1rem;
        border-left: 1px solid rgba(46,51,56,.45);
        margin-left: 0.9rem;
      }
      .session-row.child {
        background: rgba(16,17,18,.35);
      }
      .session-label-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .session-kind {
        color: var(--accent-2);
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .messages {
        overflow: auto;
        min-height: 0;
        padding: 0.9rem;
      }
      .message {
        padding: 0.7rem 0.8rem;
        border: 1px solid var(--line);
        border-radius: 0.75rem;
        background: rgba(16,17,18,.6);
        margin-bottom: 0.75rem;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.55rem;
        margin-bottom: 0.5rem;
        color: var(--muted);
        font-size: 0.85rem;
      }
      .message pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font: inherit;
      }
      .empty {
        color: var(--muted);
        padding: 1rem;
      }
      .pill {
        display: inline-block;
        padding: 0.1rem 0.45rem;
        border: 1px solid var(--line);
        border-radius: 999px;
      }
      .error {
        color: var(--bad);
      }
      @media (max-width: 1400px) {
        .grid { grid-template-columns: 1fr; }
        .card { min-height: auto; }
        .body { grid-template-columns: 1fr; }
        .sessions { border-right: 0; border-bottom: 1px solid var(--line); max-height: 18rem; }
        .messages { max-height: 60vh; }
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      const BACKENDS = ${backendLiteral};
      const POLL_MS = 10000;
      const state = {
        backends: BACKENDS.map((backend) => ({ ...backend, ok: false, sessions: [] })),
        selectedSessions: {},
        messagesByBackend: {},
        draftsByBackend: {},
        errorsByBackend: {},
        sendingByBackend: {},
        creatingByBackend: {},
      };

      function formatTimestamp(value) {
        if (!value) return "";
        try {
          return new Date(Number(value)).toLocaleTimeString();
        } catch {
          return "";
        }
      }

      function summarizeParts(parts) {
        if (!Array.isArray(parts) || parts.length === 0) return "";
        return parts.map((part) => {
          if (!part || typeof part !== "object") return "";
          if (part.type === "text") return part.text || "";
          if (part.type === "tool") return "[tool " + (part.tool || part.name || "call") + "]";
          if (part.type === "reasoning") return "[reasoning]";
          return "[" + (part.type || "part") + "]";
        }).filter(Boolean).join("\\n");
      }

      async function readJson(url, options) {
        const response = await fetch(url, { credentials: "same-origin", ...options });
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.json();
      }

      function selectSession(backendID, sessionID) {
        state.selectedSessions[backendID] = sessionID;
        refreshMessages(backendID).catch((error) => {
          state.errorsByBackend[backendID] = error.message;
          render();
        });
        render();
      }

      async function refreshBackends() {
        const payload = await readJson("/api/backends");
        const nextBackends = Array.isArray(payload.backends) ? payload.backends : [];
        state.backends = nextBackends;
        for (const backend of nextBackends) {
          const selectedSessionID = state.selectedSessions[backend.id];
          if (!backend.sessions.some((session) => session.id === selectedSessionID)) {
            state.selectedSessions[backend.id] = backend.sessions[0]?.id || null;
          }
        }
        render();
        await Promise.all(nextBackends.map((backend) => refreshMessages(backend.id).catch(() => {})));
      }

      async function refreshMessages(backendID) {
        const selectedSessionID = state.selectedSessions[backendID];
        if (!selectedSessionID) {
          state.messagesByBackend[backendID] = [];
          render();
          return;
        }
        const payload = await readJson("/api/backends/" + backendID + "/sessions/" + selectedSessionID + "/messages");
        state.messagesByBackend[backendID] = Array.isArray(payload.messages) ? payload.messages.slice(-20) : [];
        render();
      }

      async function createSession(backendID) {
        state.creatingByBackend[backendID] = true;
        state.errorsByBackend[backendID] = "";
        render();
        try {
          const backend = state.backends.find((item) => item.id === backendID);
          const payload = await readJson("/api/backends/" + backendID + "/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: backend.title + " chat" }),
          });
          state.selectedSessions[backendID] = payload.session.id;
          await refreshBackends();
        } catch (error) {
          state.errorsByBackend[backendID] = error.message;
          render();
        } finally {
          state.creatingByBackend[backendID] = false;
          render();
        }
      }

      async function sendMessage(backendID) {
        const text = (state.draftsByBackend[backendID] || "").trim();
        const selectedSessionID = state.selectedSessions[backendID];
        if (!selectedSessionID || !text) return;
        state.sendingByBackend[backendID] = true;
        state.errorsByBackend[backendID] = "";
        render();
        try {
          const backend = state.backends.find((item) => item.id === backendID);
          await readJson("/api/backends/" + backendID + "/sessions/" + selectedSessionID + "/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, agent: backend.defaultAgent || "implementation_lead" }),
          });
          state.draftsByBackend[backendID] = "";
          await refreshBackends();
          await refreshMessages(backendID);
        } catch (error) {
          state.errorsByBackend[backendID] = error.message;
          render();
        } finally {
          state.sendingByBackend[backendID] = false;
          render();
        }
      }

      async function runServiceAction(backendID, action) {
        state.errorsByBackend[backendID] = "";
        render();
        try {
          await readJson("/api/ops/services/" + backendID + "/" + action, { method: "POST" });
          await refreshBackends();
        } catch (error) {
          state.errorsByBackend[backendID] = error.message;
          render();
        }
      }

      function renderSessionList(backend, selectedSessionID) {
        if (backend.sessions.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "no sessions";
          return empty;
        }

        const container = document.createElement("div");
        container.className = "session-tree";
        const sessionsByID = new Map(backend.sessions.map((session) => [session.id, session]));
        const childSessionsByParentID = new Map();
        const rootSessions = [];

        for (const session of backend.sessions) {
          const parentID = session.parentID || null;
          if (!parentID || !sessionsByID.has(parentID)) {
            rootSessions.push(session);
            continue;
          }

          const children = childSessionsByParentID.get(parentID) || [];
          children.push(session);
          childSessionsByParentID.set(parentID, children);
        }

        function createSessionButton(session, kind) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "session-row" + (selectedSessionID === session.id ? " active" : "") + (kind === "subagent" ? " child" : "");
          button.addEventListener("click", () => selectSession(backend.id, session.id));

          const labelRow = document.createElement("div");
          labelRow.className = "session-label-row";

          const title = document.createElement("strong");
          title.textContent = session.title || session.id;
          labelRow.appendChild(title);

          const kindBadge = document.createElement("span");
          kindBadge.className = "session-kind";
          kindBadge.textContent = kind;
          labelRow.appendChild(kindBadge);

          button.appendChild(labelRow);

          const id = document.createElement("small");
          id.textContent = session.id;
          button.appendChild(id);

          const updated = document.createElement("small");
          updated.textContent = formatTimestamp(session.time?.updated);
          button.appendChild(updated);
          return button;
        }

        for (const rootSession of rootSessions) {
          const group = document.createElement("div");
          group.className = "session-group";
          group.appendChild(createSessionButton(rootSession, "main"));

          const childSessions = childSessionsByParentID.get(rootSession.id) || [];
          if (childSessions.length > 0) {
            const childrenWrapper = document.createElement("div");
            childrenWrapper.className = "session-children";
            for (const childSession of childSessions) {
              childrenWrapper.appendChild(createSessionButton(childSession, "subagent"));
            }
            group.appendChild(childrenWrapper);
          }

          container.appendChild(group);
        }
        return container;
      }

      function renderMessages(backendID, selectedSessionID) {
        const messages = state.messagesByBackend[backendID] || [];
        const wrapper = document.createElement("div");
        if (!selectedSessionID) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "select a session";
          wrapper.appendChild(empty);
          return wrapper;
        }
        if (messages.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "no messages or still loading";
          wrapper.appendChild(empty);
          return wrapper;
        }

        for (const message of messages) {
          const info = message.info || {};
          const card = document.createElement("div");
          card.className = "message";

          const meta = document.createElement("div");
          meta.className = "meta";
          for (const value of [info.role || "unknown", info.agent, info.providerID, info.modelID, info.finish]) {
            if (!value) continue;
            const span = document.createElement("span");
            if (value === (info.role || "unknown")) span.className = "pill";
            span.textContent = value;
            meta.appendChild(span);
          }
          card.appendChild(meta);

          const pre = document.createElement("pre");
          pre.textContent = summarizeParts(message.parts);
          card.appendChild(pre);

          wrapper.appendChild(card);
        }
        return wrapper;
      }

      function render() {
        const root = document.getElementById("root");
        root.innerHTML = "";

        const shell = document.createElement("div");
        shell.className = "shell";

        const topbar = document.createElement("header");
        topbar.className = "topbar";
        topbar.innerHTML = '<div><h1>Singularity Matrix</h1><p>Local control surface on top of the OpenCode JSON API</p></div>';

        const toolbar = document.createElement("div");
        toolbar.className = "toolbar";

        const reloadButton = document.createElement("button");
        reloadButton.type = "button";
        reloadButton.textContent = "reload";
        reloadButton.addEventListener("click", () => window.location.reload());
        toolbar.appendChild(reloadButton);

        const apiLink = document.createElement("a");
        apiLink.className = "link-button";
        apiLink.href = "/api/backends";
        apiLink.target = "_blank";
        apiLink.rel = "noreferrer";
        apiLink.textContent = "api";
        toolbar.appendChild(apiLink);

        topbar.appendChild(toolbar);
        shell.appendChild(topbar);

        const grid = document.createElement("main");
        grid.className = "grid";

        for (const backend of state.backends) {
          const selectedSessionID = state.selectedSessions[backend.id] || null;
          const selectedSession = backend.sessions.find((session) => session.id === selectedSessionID) || null;
          const card = document.createElement("section");
          card.className = "card " + (backend.ok ? "up" : "down");

          const header = document.createElement("header");
          header.className = "card-header";
          header.innerHTML =
            "<div><h2>" + backend.title + "</h2><p>" + backend.role + "</p></div>" +
            '<div class="status"><span class="dot ' + (backend.ok ? "up" : "down") + '"></span><span>' +
            (backend.ok ? "up " + backend.status : "down " + (backend.error || backend.status || "unreachable")) +
            "</span></div>";
          card.appendChild(header);

          const actions = document.createElement("div");
          actions.className = "card-actions";

          const openLink = document.createElement("a");
          openLink.className = "link-button";
          openLink.href = backend.origin;
          openLink.target = "_blank";
          openLink.rel = "noreferrer";
          openLink.textContent = "open";
          actions.appendChild(openLink);

          const createButton = document.createElement("button");
          createButton.type = "button";
          createButton.disabled = !!state.creatingByBackend[backend.id];
          createButton.textContent = state.creatingByBackend[backend.id] ? "creating..." : "new session";
          createButton.addEventListener("click", () => createSession(backend.id));
          actions.appendChild(createButton);

          const count = document.createElement("span");
          count.className = "pill";
          count.textContent = backend.sessions.length + " sessions";
          actions.appendChild(count);

          // Service control buttons — start/stop/restart the backend's main systemd service
          const serviceActionsWrapper = document.createElement("div");
          serviceActionsWrapper.style.display = "flex";
          serviceActionsWrapper.style.gap = "0.4rem";
          serviceActionsWrapper.style.marginLeft = "auto";

          const restartServiceButton = document.createElement("button");
          restartServiceButton.type = "button";
          restartServiceButton.textContent = "restart";
          restartServiceButton.addEventListener("click", () => runServiceAction(backend.id, "restart"));
          serviceActionsWrapper.appendChild(restartServiceButton);

          const stopServiceButton = document.createElement("button");
          stopServiceButton.type = "button";
          stopServiceButton.textContent = "stop";
          stopServiceButton.addEventListener("click", () => runServiceAction(backend.id, "stop"));
          serviceActionsWrapper.appendChild(stopServiceButton);

          const startServiceButton = document.createElement("button");
          startServiceButton.type = "button";
          startServiceButton.textContent = "start";
          startServiceButton.addEventListener("click", () => runServiceAction(backend.id, "start"));
          serviceActionsWrapper.appendChild(startServiceButton);

          actions.appendChild(serviceActionsWrapper);

          card.appendChild(actions);

          const body = document.createElement("div");
          body.className = "body";

          const sessions = document.createElement("div");
          sessions.className = "sessions";
          sessions.appendChild(renderSessionList(backend, selectedSessionID));
          body.appendChild(sessions);

          const messages = document.createElement("div");
          messages.className = "messages";
          messages.appendChild(renderMessages(backend.id, selectedSession?.id || null));
          body.appendChild(messages);

          card.appendChild(body);

          const composer = document.createElement("div");
          composer.className = "composer";

          const row = document.createElement("div");
          row.className = "composer-row";
          const agentPill = document.createElement("span");
          agentPill.className = "pill";
          agentPill.textContent = backend.defaultAgent || "implementation_lead";
          row.appendChild(agentPill);
          if (state.errorsByBackend[backend.id]) {
            const error = document.createElement("span");
            error.className = "error";
            error.textContent = state.errorsByBackend[backend.id];
            row.appendChild(error);
          }
          composer.appendChild(row);

          const textarea = document.createElement("textarea");
          textarea.placeholder = "send a message into the selected session";
          textarea.value = state.draftsByBackend[backend.id] || "";
          textarea.addEventListener("input", (event) => {
            state.draftsByBackend[backend.id] = event.target.value;
          });
          composer.appendChild(textarea);

          const sendRow = document.createElement("div");
          sendRow.className = "composer-row";
          const sendButton = document.createElement("button");
          sendButton.type = "button";
          sendButton.disabled = !!state.sendingByBackend[backend.id] || !selectedSessionID || !(state.draftsByBackend[backend.id] || "").trim();
          sendButton.textContent = state.sendingByBackend[backend.id] ? "sending..." : "send";
          sendButton.addEventListener("click", () => sendMessage(backend.id));
          sendRow.appendChild(sendButton);
          composer.appendChild(sendRow);

          card.appendChild(composer);
          grid.appendChild(card);
        }

        shell.appendChild(grid);
        root.appendChild(shell);
      }

      async function boot() {
        render();
        try {
          await refreshBackends();
        } catch (error) {
          document.getElementById("root").innerHTML = '<div class="empty" style="padding:2rem">dashboard load failed: ' + error.message + "</div>";
          return;
        }
        window.setInterval(() => {
          refreshBackends().catch((error) => {
            console.error(error);
          });
        }, POLL_MS);
      }

      boot();
    </script>
  </body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? `${bindHost}:${bindPort}`}`);

  if (requestURL.pathname === "/api/status") {
    sendJson(response, 200, { backends: await Promise.all(BACKENDS.map((backend) => probeBackend(backend))) });
    return;
  }

  if (requestURL.pathname === "/api/backends") {
    sendJson(response, 200, { backends: await collectBackendSummary() });
    return;
  }

  if (requestURL.pathname === "/api/runs") {
    sendJson(response, 200, await collectRunsSummary());
    return;
  }

  if (requestURL.pathname === "/api/llm-stats") {
    sendJson(response, 200, await collectLlmStatsSummary());
    return;
  }

  // LW6 supervision projection — proxy GET /api/letta/runs/<run_id>/slices to
  // letta-server's authoritative GET /v1/runs/<run_id>/slices endpoint.
  const lettaRunSlicesMatch = requestURL.pathname.match(/^\/api\/letta\/runs\/([^/]+)\/slices$/);
  if (lettaRunSlicesMatch && request.method === "GET") {
    const runId = lettaRunSlicesMatch[1];
    try {
      const upstream = await fetch(`${LETTA_SERVER_BASE_URL}/v1/runs/${encodeURIComponent(runId)}/slices`, {
        headers: { Accept: "application/json" },
      });
      const body = await upstream.text();
      response.statusCode = upstream.status;
      response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
      response.end(body);
      return;
    } catch (error) {
      sendJson(response, 502, {
        error: "letta slices proxy failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  // LW10 Slice 4 — proxy GET /api/selfhost/status to letta-server's
  // authoritative GET /v1/selfhost/status. Returns aggregated effective
  // state (agents counts, memfs runtime health, repair surface metadata)
  // for the dashboard self-host tile.
  if (requestURL.pathname === "/api/selfhost/status" && request.method === "GET") {
    try {
      const upstream = await fetch(`${LETTA_SERVER_BASE_URL}/v1/selfhost/status`, {
        headers: { Accept: "application/json" },
      });
      const body = await upstream.text();
      response.statusCode = upstream.status;
      response.setHeader(
        "Content-Type",
        upstream.headers.get("content-type") ?? "application/json",
      );
      response.end(body);
      return;
    } catch (error) {
      sendJson(response, 502, {
        error: "letta selfhost status proxy failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  // LW8 quota collector — proxy GET /api/quota to the sidecar's batch
  // /quota endpoint so the dashboard can read provider quota in one shot.
  if (requestURL.pathname === "/api/quota" && request.method === "GET") {
    try {
      const upstream = await fetch(`${SIDECAR_QUOTA_BASE_URL}/quota`, {
        headers: { Accept: "application/json" },
      });
      const body = await upstream.text();
      response.statusCode = upstream.status;
      response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
      response.end(body);
      return;
    } catch (error) {
      sendJson(response, 502, {
        error: "sidecar quota proxy failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  if (requestURL.pathname === "/api/canary-status") {
    try {
      sendJson(
        response,
        200,
        await collectModelCanaryStatus({
          forceRefresh: requestURL.searchParams.get("refresh") === "1",
        }),
      );
      return;
    } catch (error) {
      sendJson(response, 500, {
        error: "canary status failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const createSessionMatch = requestURL.pathname.match(/^\/api\/backends\/([^/]+)\/sessions$/);
  if (createSessionMatch && request.method === "POST") {
    const backend = backendById(createSessionMatch[1]);
    if (!backend) {
      sendJson(response, 404, { error: "unknown backend" });
      return;
    }

    try {
      const body = await readJsonRequest(request);
      const title = typeof body.title === "string" && body.title.trim() !== EMPTY_STRING ? body.title.trim() : `${backend.title} chat`;
      const session = await createBackendSession(backend, title);
      sendJson(response, 200, { session });
      return;
    } catch (error) {
      sendJson(response, 502, {
        error: "session create failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const sessionMatch = requestURL.pathname.match(/^\/api\/backends\/([^/]+)\/sessions\/([^/]+)$/);
  if (sessionMatch && request.method === "DELETE") {
    const backend = backendById(sessionMatch[1]);
    if (!backend) {
      sendJson(response, 404, { error: "unknown backend" });
      return;
    }

    try {
      await deleteBackendSession(backend, sessionMatch[2]);
      sendJson(response, 200, { deleted: true });
      return;
    } catch (error) {
      sendJson(response, 502, {
        error: "session delete failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const messageMatch = requestURL.pathname.match(/^\/api\/backends\/([^/]+)\/sessions\/([^/]+)\/messages$/);
  if (messageMatch && request.method === "GET") {
    const backend = backendById(messageMatch[1]);
    if (!backend) {
      sendJson(response, 404, { error: "unknown backend" });
      return;
    }

    try {
      const messages = await readBackendMessages(backend, messageMatch[2]);
      sendJson(response, 200, { messages });
      return;
    } catch (error) {
      sendJson(response, 502, {
        error: "message fetch failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  if (messageMatch && request.method === "POST") {
    const backend = backendById(messageMatch[1]);
    if (!backend) {
      sendJson(response, 404, { error: "unknown backend" });
      return;
    }

    try {
      const body = await readJsonRequest(request);
      const text = typeof body.text === "string" ? body.text.trim() : EMPTY_STRING;
      if (text === EMPTY_STRING) {
        sendJson(response, 400, { error: "text is required" });
        return;
      }

      const payload = await sendBackendMessage(
        backend,
        messageMatch[2],
        text,
        typeof body.agent === "string" ? body.agent : null,
      );
      sendJson(response, 200, { accepted: true, payload });
      return;
    } catch (error) {
      sendJson(response, 502, {
        error: "message send failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  if (requestURL.pathname === "/api/ops/status") {
    try {
      sendJson(response, 200, await collectOpsStatus());
      return;
    } catch (error) {
      sendJson(response, 500, {
        error: "ops status failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const timerActionMatch = requestURL.pathname.match(/^\/api\/ops\/timers\/([^/]+)\/(start|stop)$/);
  if (timerActionMatch && request.method === "POST") {
    const unit = timerActionMatch[1];
    const action = timerActionMatch[2];
    try {
      const status = await runMaintenanceTimerAction(unit, action);
      sendJson(response, 200, { unit, action, status });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message.startsWith("unit not in whitelist") ? 400 : 502;
      sendJson(response, statusCode, { error: "timer action failed", detail: message });
      return;
    }
  }

  const serviceActionMatch = requestURL.pathname.match(/^\/api\/ops\/services\/([^/]+)\/(start|stop|restart)$/);
  if (serviceActionMatch && request.method === "POST") {
    const backendId = serviceActionMatch[1];
    const action = serviceActionMatch[2];
    try {
      const status = await runBackendServiceAction(backendId, action);
      sendJson(response, 200, { backendId, action, status });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message.startsWith("unknown backend") ? 400 : 502;
      sendJson(response, statusCode, { error: "service action failed", detail: message });
      return;
    }
  }

  sendJson(response, 404, {
    error: "unknown api route",
    path: requestURL.pathname,
  });
});

server.listen(bindPort, bindHost, () => {
  process.stdout.write(`opencode-triad-dashboard listening on http://${bindHost}:${bindPort}\n`);
});
