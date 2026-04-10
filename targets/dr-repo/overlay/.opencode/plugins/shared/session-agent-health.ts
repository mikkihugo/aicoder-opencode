import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const AGENT_HEALTH_DIRECTORY = path.join(".opencode", "state", "agent-health");
export const MAX_AGENT_FAILURE_EVENTS = 100;
export const MAX_AGENT_ACTIVITY_EVENTS = 200;
export const UNSTABLE_AGENT_WINDOW_MILLISECONDS = 20 * 60 * 1000;
export const UNSTABLE_AGENT_FAILURE_THRESHOLD = 2;
export const MAX_AGENT_OUTPUT_SNIPPET_CHARACTERS = 240;

export type AgentFailureClass =
  | "permission_boundary"
  | "timeout_or_stall"
  | "provider_runtime_error"
  | "runtime_error"
  | "bad_fit_for_task";

export type AgentFailureEvent = {
  agent: string;
  sessionID: string;
  detectedAt: string;
  reason: string;
  taskDescription: string | null;
  tool: string;
};

export type AgentActivityStatus = "running" | "completed" | "failed";

export type AgentActivityRecord = {
  id: string;
  agent: string;
  sessionID: string;
  startedAt: string;
  updatedAt: string;
  taskDescription: string | null;
  tool: string;
  status: AgentActivityStatus;
  outputSnippet: string | null;
  blockerReason: string | null;
};

export type SessionAgentHealthRecord = {
  sessionID: string;
  failures: AgentFailureEvent[];
  activities: AgentActivityRecord[];
  updatedAt: string;
};

export type AgentInstability = {
  agent: string;
  failureCount: number;
  lastFailureAt: string;
  lastTaskDescription: string | null;
  reasons: string[];
  failureClasses: AgentFailureClass[];
  fallbackAgent: string | null;
  recoveryHint: string | null;
};

export type HelperLaunchFallbackAction = "allow" | "prefer_fallback" | "retry_later";

export type HelperLaunchFallbackDecision = {
  requestedAgent: string;
  effectiveAgent: string;
  action: HelperLaunchFallbackAction;
  fallbackAgent: string | null;
  reason: string | null;
  recoveryHint: string | null;
};

export type AgentActivityView = {
  id: string;
  agent: string;
  sessionID: string;
  startedAt: string;
  updatedAt: string;
  taskDescription: string | null;
  tool: string;
  status: AgentActivityStatus;
  outputSnippet: string | null;
  blockerReason: string | null;
  ageSeconds: number;
};

function agentHealthPath(directory: string, sessionID: string) {
  return path.join(directory, AGENT_HEALTH_DIRECTORY, `${sessionID}.json`);
}

function parseTimestamp(timestamp: string) {
  const parsedTimestamp = Date.parse(timestamp);
  return Number.isNaN(parsedTimestamp) ? 0 : parsedTimestamp;
}

function trimFailureEvents(failures: AgentFailureEvent[]) {
  if (failures.length <= MAX_AGENT_FAILURE_EVENTS) {
    return failures;
  }
  return failures.slice(failures.length - MAX_AGENT_FAILURE_EVENTS);
}

function trimActivityEvents(activities: AgentActivityRecord[]) {
  if (activities.length <= MAX_AGENT_ACTIVITY_EVENTS) {
    return activities;
  }
  return activities.slice(activities.length - MAX_AGENT_ACTIVITY_EVENTS);
}

function normalizeSnippet(snippet: string | null | undefined) {
  if (!snippet) {
    return null;
  }
  const compactSnippet = snippet.replace(/\s+/g, " ").trim();
  if (!compactSnippet) {
    return null;
  }
  if (compactSnippet.length <= MAX_AGENT_OUTPUT_SNIPPET_CHARACTERS) {
    return compactSnippet;
  }
  return `${compactSnippet.slice(0, MAX_AGENT_OUTPUT_SNIPPET_CHARACTERS - 1)}…`;
}

function activityMatchesFailure(activity: AgentActivityRecord, failure: AgentFailureEvent) {
  return (
    activity.agent === failure.agent &&
    activity.taskDescription === failure.taskDescription &&
    activity.tool === failure.tool
  );
}

function latestMatchingRunningActivityIndex(
  activities: AgentActivityRecord[],
  agent: string,
  taskDescription: string | null,
  tool: string,
) {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (
      activity.agent === agent &&
      activity.taskDescription === taskDescription &&
      activity.tool === tool &&
      activity.status === "running"
    ) {
      return index;
    }
  }
  return -1;
}

function emptySessionAgentHealthRecord(sessionID: string): SessionAgentHealthRecord {
  return {
    sessionID,
    failures: [],
    activities: [],
    updatedAt: new Date().toISOString(),
  };
}

const READ_ONLY_HELPER_AGENTS = new Set([
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

async function saveSessionAgentHealth(
  directory: string,
  sessionID: string,
  record: SessionAgentHealthRecord,
) {
  await mkdir(path.dirname(agentHealthPath(directory, sessionID)), { recursive: true });
  await writeFile(agentHealthPath(directory, sessionID), JSON.stringify(record, null, 2) + "\n", "utf8");
}

export function classifyAgentFailureReason(reason: string): AgentFailureClass {
  const normalizedReason = reason.toLowerCase();
  if (/permission|not allowed|access denied|blocked/.test(normalizedReason)) {
    return "permission_boundary";
  }
  if (/timeout|timed out|stale-task threshold|reaped/.test(normalizedReason)) {
    return "timeout_or_stall";
  }
  if (
    /provider or model runtime failure|rate.?limit|too many requests|quota|service unavailable|temporarily unavailable|overloaded|all credentials for model|retrying in|model not found|payment required|out of credits|insufficient quota|503|504|502|500|429/.test(
      normalizedReason,
    )
  ) {
    return "provider_runtime_error";
  }
  if (/bad fit|wrong fit|exceeds cheap mapping|broad read/.test(normalizedReason)) {
    return "bad_fit_for_task";
  }
  return "runtime_error";
}

export function fallbackAgentForFailure(agent: string, failureClasses: AgentFailureClass[]) {
  const fallbackByAgent: Partial<Record<string, Partial<Record<AgentFailureClass, string>>>> = {
    codebase_explorer: {
      permission_boundary: "long_context_reader",
      timeout_or_stall: "long_context_reader",
      bad_fit_for_task: "long_context_reader",
      runtime_error: "long_context_reader",
    },
    long_context_reader: {
      permission_boundary: "architecture_consultant",
      timeout_or_stall: "architecture_consultant",
      runtime_error: "architecture_consultant",
    },
    critical_reviewer: {
      timeout_or_stall: "verifier",
      runtime_error: "verifier",
    },
    verifier: {
      timeout_or_stall: "critical_reviewer",
      runtime_error: "critical_reviewer",
    },
    planning_analyst: {
      timeout_or_stall: "roadmap_keeper",
      runtime_error: "roadmap_keeper",
    },
  };

  const fallbackCandidates = fallbackByAgent[agent];
  if (!fallbackCandidates) {
    return null;
  }

  for (const failureClass of failureClasses) {
    const fallbackAgent = fallbackCandidates[failureClass];
    if (fallbackAgent) {
      return fallbackAgent;
    }
  }

  return null;
}

export function recoveryHintForFailure(
  agent: string,
  failureClasses: AgentFailureClass[],
  fallbackAgent: string | null,
) {
  if (failureClasses.includes("provider_runtime_error")) {
    return `Keep the same blind spot, but retry later or switch to a different helper/model lineage than ${agent}.`;
  }
  if (fallbackAgent) {
    return `Prefer ${fallbackAgent} for this blind spot in the current session.`;
  }
  if (failureClasses.includes("timeout_or_stall")) {
    return "Narrow the scope or keep the work local instead of relaunching the same helper unchanged.";
  }
  return null;
}

export function isReadOnlyHelperAgent(agent: string) {
  return READ_ONLY_HELPER_AGENTS.has(agent);
}

export function resolveHelperLaunchFallback(
  requestedAgent: string,
  health: SessionAgentHealthRecord | null,
  nowMilliseconds = Date.now(),
): HelperLaunchFallbackDecision {
  const instability = listUnstableAgents(health, nowMilliseconds).find(
    (candidate) => candidate.agent === requestedAgent,
  );

  if (!instability) {
    return {
      requestedAgent,
      effectiveAgent: requestedAgent,
      action: "allow",
      fallbackAgent: null,
      reason: null,
      recoveryHint: null,
    };
  }

  if (instability.failureClasses.includes("provider_runtime_error")) {
    return {
      requestedAgent,
      effectiveAgent: requestedAgent,
      action: "retry_later",
      fallbackAgent: null,
      reason: instability.reasons[0] ?? null,
      recoveryHint: instability.recoveryHint,
    };
  }

  if (
    instability.fallbackAgent &&
    isReadOnlyHelperAgent(requestedAgent) &&
    isReadOnlyHelperAgent(instability.fallbackAgent)
  ) {
    return {
      requestedAgent,
      effectiveAgent: instability.fallbackAgent,
      action: "prefer_fallback",
      fallbackAgent: instability.fallbackAgent,
      reason: instability.reasons[0] ?? null,
      recoveryHint: instability.recoveryHint,
    };
  }

  return {
    requestedAgent,
    effectiveAgent: requestedAgent,
    action: "allow",
    fallbackAgent: instability.fallbackAgent,
    reason: instability.reasons[0] ?? null,
    recoveryHint: instability.recoveryHint,
  };
}

export async function loadSessionAgentHealth(
  directory: string,
  sessionID: string,
): Promise<SessionAgentHealthRecord | null> {
  try {
    const raw = await readFile(agentHealthPath(directory, sessionID), "utf8");
    const parsedRecord = JSON.parse(raw) as Partial<SessionAgentHealthRecord>;
    return {
      sessionID,
      failures: parsedRecord.failures ?? [],
      activities: parsedRecord.activities ?? [],
      updatedAt: parsedRecord.updatedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function recordAgentFailure(
  directory: string,
  sessionID: string,
  failure: Omit<AgentFailureEvent, "sessionID" | "detectedAt">,
) {
  const existing = (await loadSessionAgentHealth(directory, sessionID)) ?? emptySessionAgentHealthRecord(sessionID);

  const merged: SessionAgentHealthRecord = {
    sessionID,
    failures: trimFailureEvents([
      ...existing.failures,
      {
        ...failure,
        sessionID,
        detectedAt: new Date().toISOString(),
      },
    ]),
    activities: existing.activities ?? [],
    updatedAt: new Date().toISOString(),
  };

  await saveSessionAgentHealth(directory, sessionID, merged);

  return merged;
}

export async function recordAgentActivityStart(
  directory: string,
  sessionID: string,
  activity: {
    agent: string;
    taskDescription: string | null;
    tool: string;
  },
) {
  const existing = (await loadSessionAgentHealth(directory, sessionID)) ?? emptySessionAgentHealthRecord(sessionID);
  const now = new Date().toISOString();
  const merged: SessionAgentHealthRecord = {
    ...existing,
    activities: trimActivityEvents([
      ...existing.activities,
      {
        id: randomUUID(),
        agent: activity.agent,
        sessionID,
        startedAt: now,
        updatedAt: now,
        taskDescription: activity.taskDescription,
        tool: activity.tool,
        status: "running",
        outputSnippet: null,
        blockerReason: null,
      },
    ]),
    updatedAt: now,
  };
  await saveSessionAgentHealth(directory, sessionID, merged);
  return merged;
}

export async function recordAgentActivityCompletion(
  directory: string,
  sessionID: string,
  activity: {
    agent: string;
    taskDescription: string | null;
    tool: string;
    status: Exclude<AgentActivityStatus, "running">;
    outputSnippet?: string | null;
    blockerReason?: string | null;
  },
) {
  const existing = (await loadSessionAgentHealth(directory, sessionID)) ?? emptySessionAgentHealthRecord(sessionID);
  const now = new Date().toISOString();
  const nextActivities = existing.activities.slice();
  const activityIndex = latestMatchingRunningActivityIndex(
    nextActivities,
    activity.agent,
    activity.taskDescription,
    activity.tool,
  );

  if (activityIndex >= 0) {
    const existingActivity = nextActivities[activityIndex];
    nextActivities[activityIndex] = {
      ...existingActivity,
      updatedAt: now,
      status: activity.status,
      outputSnippet: normalizeSnippet(activity.outputSnippet),
      blockerReason: normalizeSnippet(activity.blockerReason),
    };
  } else {
    nextActivities.push({
      id: randomUUID(),
      agent: activity.agent,
      sessionID,
      startedAt: now,
      updatedAt: now,
      taskDescription: activity.taskDescription,
      tool: activity.tool,
      status: activity.status,
      outputSnippet: normalizeSnippet(activity.outputSnippet),
      blockerReason: normalizeSnippet(activity.blockerReason),
    });
  }

  const merged: SessionAgentHealthRecord = {
    ...existing,
    activities: trimActivityEvents(nextActivities),
    updatedAt: now,
  };
  await saveSessionAgentHealth(directory, sessionID, merged);
  return merged;
}

export function listRecentAgentActivities(
  health: SessionAgentHealthRecord | null,
  nowMilliseconds = Date.now(),
  limit = 20,
): AgentActivityView[] {
  if (!health?.activities?.length) {
    return [];
  }

  const failureEvents = (health.failures ?? []).slice().sort((left, right) => {
    return parseTimestamp(left.detectedAt) - parseTimestamp(right.detectedAt);
  });

  const activities = health.activities.map((activity) => ({ ...activity }));
  for (const failure of failureEvents) {
    const activity = activities
      .slice()
      .sort((left, right) => parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt))
      .find((candidate) => {
        return (
          candidate.status === "running" &&
          parseTimestamp(candidate.startedAt) <= parseTimestamp(failure.detectedAt) &&
          activityMatchesFailure(candidate, failure)
        );
      });
    if (!activity) {
      continue;
    }
    activity.status = "failed";
    activity.updatedAt = failure.detectedAt;
    activity.blockerReason = normalizeSnippet(failure.reason);
  }

  return activities
    .sort((left, right) => parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt))
    .slice(0, limit)
    .map((activity) => ({
      ...activity,
      ageSeconds: Math.max(0, Math.floor((nowMilliseconds - parseTimestamp(activity.updatedAt)) / 1000)),
    }));
}

export function listUnstableAgents(
  health: SessionAgentHealthRecord | null,
  nowMilliseconds = Date.now(),
  unstableWindowMilliseconds = UNSTABLE_AGENT_WINDOW_MILLISECONDS,
  unstableFailureThreshold = UNSTABLE_AGENT_FAILURE_THRESHOLD,
): AgentInstability[] {
  if (!health?.failures?.length) {
    return [];
  }

  const recentFailures = health.failures.filter(
    (failure) => nowMilliseconds - parseTimestamp(failure.detectedAt) <= unstableWindowMilliseconds,
  );

  const failuresByAgent = new Map<string, AgentFailureEvent[]>();
  for (const failure of recentFailures) {
    const failures = failuresByAgent.get(failure.agent) ?? [];
    failures.push(failure);
    failuresByAgent.set(failure.agent, failures);
  }

  return Array.from(failuresByAgent.entries())
    .filter(([, failures]) => failures.length >= unstableFailureThreshold)
    .map(([agent, failures]) => {
      const failureClasses = Array.from(
        new Set(failures.map((failure) => classifyAgentFailureReason(failure.reason))),
      );
      const latestFailure = failures
        .slice()
        .sort((left, right) => parseTimestamp(right.detectedAt) - parseTimestamp(left.detectedAt))[0];
      const fallbackAgent = fallbackAgentForFailure(agent, failureClasses);
      return {
        agent,
        failureCount: failures.length,
        lastFailureAt: latestFailure.detectedAt,
        lastTaskDescription: latestFailure.taskDescription,
        reasons: Array.from(new Set(failures.map((failure) => failure.reason))),
        failureClasses,
        fallbackAgent,
        recoveryHint: recoveryHintForFailure(agent, failureClasses, fallbackAgent),
      };
    })
    .sort((left, right) => right.failureCount - left.failureCount || right.lastFailureAt.localeCompare(left.lastFailureAt));
}
