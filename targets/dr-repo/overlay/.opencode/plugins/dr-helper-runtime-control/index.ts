import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { tool, type Plugin } from "@opencode-ai/plugin";

import { canLaunchHelperTask, helperParallelCounts } from "../shared/helper-parallel-policy.ts";
import {
  MAX_AGENT_ACTIVITY_EVENTS,
  loadSessionAgentHealth,
  listRecentAgentActivities,
  resolveHelperLaunchFallback,
} from "../shared/session-agent-health.ts";
import {
  MAX_HELPER_SESSION_LIMIT,
  extractTaskSessionIDFromOutput,
  helperTaskKey,
  isHelperTaskTerminalStatus,
  latestTaskByKey,
  normalizeHelperOutputBlockTimeout,
  normalizeHelperOutputMessageLimit,
  normalizeHelperSessionLimit,
  normalizeHelperSnippet,
  parseHelperSessionTitle,
  type HelperOutputTextPart,
  type HelperChildSession,
  type HelperTaskState,
} from "./library.ts";

const execFile = promisify(execFileCallback);
const PLUGIN_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(PLUGIN_PATH), "..", "..", "..");
const DEFAULT_OPENCODE_DATA_HOME = path.join(REPO_ROOT, ".opencode", "xdg-data");
const OPENCODE_DATA_HOME = process.env.XDG_DATA_HOME?.trim() || DEFAULT_OPENCODE_DATA_HOME;
const OPENCODE_DB_PATH = path.join(OPENCODE_DATA_HOME, "opencode", "opencode.db");
const SQLITE_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

type SqliteJsonRow = Record<string, unknown>;

type ToolExecuteBeforeInput = {
  tool?: string;
  args?: Record<string, unknown>;
  sessionID: string;
};

type HelperOutputView = {
  helperSession: {
    sessionID: string;
    title: string;
    agent: string | null;
    description: string | null;
    status: string | null;
    startedAtMilliseconds: number;
    updatedAtMilliseconds: number;
    latestTextSnippet: string | null;
  };
  helperTask: {
    callID: string | null;
    status: string | null;
    description: string | null;
    agent: string | null;
    startedAtMilliseconds: number | null;
  } | null;
  transcript: HelperOutputTextPart[];
};

function stringArgument(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function taskAgentName(args: Record<string, unknown>) {
  return (
    stringArgument(args, "subagent_type") ??
    stringArgument(args, "subagentType") ??
    stringArgument(args, "agent") ??
    stringArgument(args, "helper")
  );
}

function quoteSqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function runSqliteJsonQuery(query: string): Promise<SqliteJsonRow[]> {
  const result = await execFile("sqlite3", ["-json", OPENCODE_DB_PATH, query], {
    maxBuffer: SQLITE_MAX_BUFFER_BYTES,
  });
  const stdout = result.stdout.trim();
  if (!stdout) {
    return [];
  }
  return JSON.parse(stdout) as SqliteJsonRow[];
}

function numberField(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

async function listHelperTaskStates(sessionID: string, limit: number) {
  const query = [
    "select",
    "json_extract(data, '$.callID') as call_id,",
    "time_created as time_created,",
    "json_extract(data, '$.state.status') as status,",
    "json_extract(data, '$.state.input.description') as description,",
    "json_extract(data, '$.state.input.subagent_type') as agent,",
    "json_extract(data, '$.state.output') as task_output",
    "from part",
    "where session_id =",
    quoteSqlString(sessionID),
    "and json_extract(data, '$.type') = 'tool'",
    "and json_extract(data, '$.tool') = 'task'",
    "order by time_created desc",
    `limit ${limit};`,
  ].join(" ");

  const rows = await runSqliteJsonQuery(query);
  return rows.map((row): HelperTaskState => ({
    callID: stringField(row.call_id) ?? "",
    status: stringField(row.status),
    description: stringField(row.description),
    agent: stringField(row.agent),
    startedAtMilliseconds: numberField(row.time_created),
    taskOutput: stringField(row.task_output),
  }));
}

async function listHelperChildSessions(parentSessionID: string, limit: number) {
  const query = [
    "select id as session_id, title, time_created, time_updated",
    "from session",
    "where parent_id =",
    quoteSqlString(parentSessionID),
    "order by time_updated desc",
    `limit ${limit};`,
  ].join(" ");

  const rows = await runSqliteJsonQuery(query);
  return rows.map((row): HelperChildSession => ({
    sessionID: stringField(row.session_id) ?? "",
    title: stringField(row.title) ?? "",
    createdAtMilliseconds: numberField(row.time_created),
    updatedAtMilliseconds: numberField(row.time_updated),
  }));
}

async function latestChildTextSnippet(sessionID: string) {
  const query = [
    "select json_extract(data, '$.text') as text",
    "from part",
    "where session_id =",
    quoteSqlString(sessionID),
    "and json_extract(data, '$.type') = 'text'",
    "order by time_created desc",
    "limit 1;",
  ].join(" ");

  const rows = await runSqliteJsonQuery(query);
  return normalizeHelperSnippet(stringField(rows[0]?.text));
}

async function listHelperTextParts(sessionID: string, limit: number) {
  const query = [
    "select time_created, json_extract(data, '$.text') as text",
    "from part",
    "where session_id =",
    quoteSqlString(sessionID),
    "and json_extract(data, '$.type') = 'text'",
    "order by time_created desc",
    `limit ${limit};`,
  ].join(" ");

  const rows = await runSqliteJsonQuery(query);
  return rows
    .map((row): HelperOutputTextPart => ({
      timeCreatedMilliseconds: numberField(row.time_created),
      text: normalizeHelperSnippet(stringField(row.text)),
    }))
    .filter((row) => row.text)
    .reverse();
}

async function findHelperOutputView(
  parentSessionID: string,
  helperSessionID: string,
  transcriptLimit: number,
): Promise<HelperOutputView | null> {
  const helperSessionView = await buildHelperSessionView(parentSessionID, MAX_HELPER_SESSION_LIMIT);
  const helperSession = helperSessionView.sessions.find((session) => session.sessionID === helperSessionID);
  if (!helperSession) {
    return null;
  }

  const helperTask =
    helperSessionView.taskStates.find(
      (taskState) => extractTaskSessionIDFromOutput(taskState.taskOutput) === helperSessionID,
    ) ?? null;

  return {
    helperSession,
    helperTask: helperTask
      ? {
          callID: helperTask.callID,
          status: helperTask.status,
          description: helperTask.description,
          agent: helperTask.agent,
          startedAtMilliseconds: helperTask.startedAtMilliseconds,
        }
      : null,
    transcript: await listHelperTextParts(helperSessionID, transcriptLimit),
  };
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHelperOutputView(
  parentSessionID: string,
  helperSessionID: string,
  transcriptLimit: number,
  timeoutMilliseconds: number,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let latestView = await findHelperOutputView(parentSessionID, helperSessionID, transcriptLimit);
  while (latestView && !isHelperTaskTerminalStatus(latestView.helperTask?.status) && Date.now() < deadline) {
    await sleep(1_000);
    latestView = await findHelperOutputView(parentSessionID, helperSessionID, transcriptLimit);
  }
  return {
    helperOutputView: latestView,
    timedOut:
      !!latestView &&
      !isHelperTaskTerminalStatus(latestView.helperTask?.status) &&
      Date.now() >= deadline,
  };
}

async function buildHelperSessionView(parentSessionID: string, limit: number) {
  const [taskStates, childSessions] = await Promise.all([
    listHelperTaskStates(parentSessionID, limit),
    listHelperChildSessions(parentSessionID, limit),
  ]);
  const tasksByKey = latestTaskByKey(taskStates);

  const sessions = await Promise.all(
    childSessions.map(async (childSession) => {
      const parsedTitle = parseHelperSessionTitle(childSession.title);
      const matchedTask =
        tasksByKey.get(helperTaskKey(parsedTitle.agent, parsedTitle.description)) ??
        taskStates.find((taskState) => extractTaskSessionIDFromOutput(taskState.taskOutput) === childSession.sessionID) ??
        null;

      return {
        sessionID: childSession.sessionID,
        title: childSession.title,
        agent: parsedTitle.agent ?? matchedTask?.agent ?? null,
        description: parsedTitle.description ?? matchedTask?.description ?? null,
        status: matchedTask?.status ?? null,
        startedAtMilliseconds: matchedTask?.startedAtMilliseconds ?? childSession.createdAtMilliseconds,
        updatedAtMilliseconds: childSession.updatedAtMilliseconds,
        latestTextSnippet: await latestChildTextSnippet(childSession.sessionID),
      };
    }),
  );

  return {
    taskStates,
    sessions,
  };
}

const plugin: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        [
          "Helper runtime rule:",
          "- Parallel helper caps are enforced at runtime, not just suggested.",
          "- If helper output matters, use show_helper_sessions instead of guessing from the parent transcript.",
          "- If a helper looks wedged, inspect it first and use external dr-autopilot reap only when it is truly stale.",
        ].join("\n"),
      );
    },
    "tool.execute.before": async (input: ToolExecuteBeforeInput) => {
      if (!input.sessionID || input.tool !== "task") {
        return;
      }

      const args = input.args ?? {};
      const agent = taskAgentName(args);
      if (!agent) {
        return;
      }

      const health = await loadSessionAgentHealth(ctx.directory, input.sessionID);
      const launchFallback = resolveHelperLaunchFallback(agent, health);
      if (launchFallback.action === "retry_later") {
        throw new Error(
          [
            `helper launch blocked for ${agent}: ${launchFallback.reason ?? "helper is unstable in this session"}.`,
            launchFallback.recoveryHint ??
              "Recent failures look like provider or model unavailability. Retry later, switch lineage, or stay local.",
            "Use show_unstable_helpers before relaunching the same helper.",
          ].join(" "),
        );
      }
      if (launchFallback.action === "prefer_fallback" && launchFallback.fallbackAgent) {
        throw new Error(
          [
            `helper launch blocked for ${agent}: ${launchFallback.reason ?? "helper is unstable in this session"}.`,
            launchFallback.recoveryHint ??
              `Prefer ${launchFallback.fallbackAgent} for this blind spot in the current session.`,
            `Relaunch with ${launchFallback.fallbackAgent}, choose a different helper class, or stay local.`,
          ].join(" "),
        );
      }

      const runningActivities = listRecentAgentActivities(
        health,
        Date.now(),
        MAX_AGENT_ACTIVITY_EVENTS,
      ).filter((activity) => activity.status === "running");
      const launchDecision = canLaunchHelperTask(agent, runningActivities);
      if (launchDecision.allowed) {
        return;
      }

      const counts = helperParallelCounts(runningActivities);
      throw new Error(
        [
          `helper fanout cap hit for ${agent}: ${launchDecision.reason}.`,
          `running helpers: total=${counts.totalRunning}, heavy_reader=${counts.byClass.heavy_reader}, light_reader=${counts.byClass.light_reader}, reviewer=${counts.byClass.reviewer}, worker=${counts.byClass.worker}.`,
          "Use show_helper_activity or show_helper_sessions, then wait, synthesize locally, or choose a different helper class.",
        ].join(" "),
      );
    },
    tool: {
      show_helper_sessions: tool({
        description:
          "Show helper child sessions for the current parent session, including status hints and latest assistant text snippets.",
        args: {
          limit: tool.schema.number().optional().describe("Maximum number of recent helper sessions to show."),
        },
        async execute(args, context) {
          const limit = normalizeHelperSessionLimit(args.limit);
          const helperSessionView = await buildHelperSessionView(context.sessionID, limit);
          return JSON.stringify(
            {
              summary: {
                helperSessionCount: helperSessionView.sessions.length,
                runningTaskCount: helperSessionView.taskStates.filter((task) => task.status === "running").length,
                failedTaskCount: helperSessionView.taskStates.filter((task) => task.status === "error").length,
                completedTaskCount: helperSessionView.taskStates.filter((task) => task.status === "completed").length,
              },
              helperSessions: helperSessionView.sessions,
              helperTasks: helperSessionView.taskStates.map((taskState) => ({
                callID: taskState.callID,
                agent: taskState.agent,
                description: taskState.description,
                status: taskState.status,
                childSessionID: extractTaskSessionIDFromOutput(taskState.taskOutput),
                startedAtMilliseconds: taskState.startedAtMilliseconds,
              })),
              guidance:
                "Use helperSessions.latestTextSnippet for recent helper output. OpenCode does not expose a safe in-process per-task cancel primitive here; use external dr-autopilot recovery only for truly stale tasks.",
            },
            null,
            2,
          );
        },
      }),
      show_helper_output: tool({
        description:
          "Show output for one helper child session, with optional bounded blocking while the helper is still running.",
        args: {
          helper_session_id: tool.schema.string().describe("Helper child session id returned from show_helper_sessions."),
          message_limit: tool.schema.number().optional().describe("Maximum number of helper text parts to return."),
          block: tool.schema.boolean().optional().describe("When true, wait briefly for terminal helper status before returning."),
          timeout_ms: tool.schema.number().optional().describe("Maximum block time in milliseconds when block=true."),
        },
        async execute(args, context) {
          const transcriptLimit = normalizeHelperOutputMessageLimit(args.message_limit);
          const helperSessionID = args.helper_session_id.trim();
          const helperOutputResult = args.block
            ? await waitForHelperOutputView(
                context.sessionID,
                helperSessionID,
                transcriptLimit,
                normalizeHelperOutputBlockTimeout(args.timeout_ms),
              )
            : {
                helperOutputView: await findHelperOutputView(context.sessionID, helperSessionID, transcriptLimit),
                timedOut: false,
              };

          if (!helperOutputResult.helperOutputView) {
            throw new Error(
              `helper session ${helperSessionID} was not found under parent session ${context.sessionID}. Use show_helper_sessions first.`,
            );
          }

          return JSON.stringify(
            {
              helperSession: helperOutputResult.helperOutputView.helperSession,
              helperTask: helperOutputResult.helperOutputView.helperTask,
              transcript: helperOutputResult.helperOutputView.transcript,
              blocking: {
                requested: !!args.block,
                timedOut: helperOutputResult.timedOut,
                timeoutMilliseconds: args.block
                  ? normalizeHelperOutputBlockTimeout(args.timeout_ms)
                  : null,
              },
              guidance: helperOutputResult.timedOut
                ? "The helper is still running. Re-run show_helper_output later, or inspect show_helper_activity before treating it as stuck."
                : "Use transcript for recent helper output. Use show_helper_sessions for sibling helpers and show_helper_activity for session-level instability.",
            },
            null,
            2,
          );
        },
      }),
    },
  };
};

export default plugin;
