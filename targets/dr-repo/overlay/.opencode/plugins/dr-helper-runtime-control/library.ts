export const DEFAULT_HELPER_SESSION_LIMIT = 10;
export const MAX_HELPER_SESSION_LIMIT = 20;
export const MAX_HELPER_TEXT_SNIPPET_CHARACTERS = 240;
export const DEFAULT_HELPER_OUTPUT_MESSAGE_LIMIT = 10;
export const MAX_HELPER_OUTPUT_MESSAGE_LIMIT = 50;
export const DEFAULT_HELPER_OUTPUT_BLOCK_TIMEOUT_MILLISECONDS = 10_000;
export const MIN_HELPER_OUTPUT_BLOCK_TIMEOUT_MILLISECONDS = 1_000;
export const MAX_HELPER_OUTPUT_BLOCK_TIMEOUT_MILLISECONDS = 30_000;

export type HelperTaskState = {
  callID: string;
  status: string | null;
  description: string | null;
  agent: string | null;
  startedAtMilliseconds: number;
  taskOutput: string | null;
};

export type HelperChildSession = {
  sessionID: string;
  title: string;
  createdAtMilliseconds: number;
  updatedAtMilliseconds: number;
};

export type HelperOutputTextPart = {
  timeCreatedMilliseconds: number;
  text: string | null;
};

export function normalizeHelperSessionLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) {
    return DEFAULT_HELPER_SESSION_LIMIT;
  }
  const roundedLimit = Math.trunc(limit as number);
  if (roundedLimit < 1) {
    return 1;
  }
  if (roundedLimit > MAX_HELPER_SESSION_LIMIT) {
    return MAX_HELPER_SESSION_LIMIT;
  }
  return roundedLimit;
}

export function normalizeHelperSnippet(text: string | null | undefined) {
  if (!text) {
    return null;
  }
  const compactText = text.replace(/\s+/g, " ").trim();
  if (!compactText) {
    return null;
  }
  if (compactText.length <= MAX_HELPER_TEXT_SNIPPET_CHARACTERS) {
    return compactText;
  }
  return `${compactText.slice(0, MAX_HELPER_TEXT_SNIPPET_CHARACTERS - 1)}…`;
}

export function normalizeHelperOutputMessageLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) {
    return DEFAULT_HELPER_OUTPUT_MESSAGE_LIMIT;
  }
  const roundedLimit = Math.trunc(limit as number);
  if (roundedLimit < 1) {
    return 1;
  }
  if (roundedLimit > MAX_HELPER_OUTPUT_MESSAGE_LIMIT) {
    return MAX_HELPER_OUTPUT_MESSAGE_LIMIT;
  }
  return roundedLimit;
}

export function normalizeHelperOutputBlockTimeout(timeoutMilliseconds: number | undefined) {
  if (!Number.isFinite(timeoutMilliseconds)) {
    return DEFAULT_HELPER_OUTPUT_BLOCK_TIMEOUT_MILLISECONDS;
  }
  const roundedTimeout = Math.trunc(timeoutMilliseconds as number);
  if (roundedTimeout < MIN_HELPER_OUTPUT_BLOCK_TIMEOUT_MILLISECONDS) {
    return MIN_HELPER_OUTPUT_BLOCK_TIMEOUT_MILLISECONDS;
  }
  if (roundedTimeout > MAX_HELPER_OUTPUT_BLOCK_TIMEOUT_MILLISECONDS) {
    return MAX_HELPER_OUTPUT_BLOCK_TIMEOUT_MILLISECONDS;
  }
  return roundedTimeout;
}

export function extractTaskSessionIDFromOutput(taskOutput: string | null | undefined) {
  if (!taskOutput) {
    return null;
  }

  const metadataSessionMatch = taskOutput.match(/<task_metadata>[\s\S]*?^session_id:\s*(ses_[^\s]+)$/im);
  if (metadataSessionMatch?.[1]) {
    return metadataSessionMatch[1];
  }

  const inlineSessionMatch = taskOutput.match(/\bsession_id:\s*(ses_[^\s]+)/i);
  if (inlineSessionMatch?.[1]) {
    return inlineSessionMatch[1];
  }

  const legacyTaskMatch = taskOutput.match(/\btask_id:\s*(ses_[^\s]+)/i);
  return legacyTaskMatch?.[1] ?? null;
}

export function parseHelperSessionTitle(title: string) {
  const match = title.match(/^(.*)\s+\(@([A-Za-z0-9_-]+)\s+subagent\)$/);
  if (!match) {
    return {
      description: title.trim() || null,
      agent: null,
    };
  }
  return {
    description: match[1].trim() || null,
    agent: match[2].trim() || null,
  };
}

export function helperTaskKey(agent: string | null, description: string | null) {
  return `${agent ?? ""}\u0000${description ?? ""}`;
}

export function latestTaskByKey(taskStates: HelperTaskState[]) {
  const tasksByKey = new Map<string, HelperTaskState>();
  for (const taskState of taskStates) {
    const key = helperTaskKey(taskState.agent, taskState.description);
    if (!tasksByKey.has(key)) {
      tasksByKey.set(key, taskState);
    }
  }
  return tasksByKey;
}

export function isHelperTaskTerminalStatus(status: string | null | undefined) {
  return status === "completed" || status === "error";
}
