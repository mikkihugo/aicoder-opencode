import { tool, type Plugin } from "@opencode-ai/plugin";

import {
  loadSessionAgentHealth,
  listRecentAgentActivities,
  listUnstableAgents,
  recordAgentActivityCompletion,
  recordAgentActivityStart,
  recordAgentFailure,
} from "../shared/session-agent-health.ts";

type ToolExecutionInput = {
  tool?: string;
  args?: Record<string, unknown>;
  sessionID: string;
};

type ToolExecutionOutput = {
  metadata?: Record<string, unknown>;
  output?: string;
  title?: string;
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

function taskDescription(args: Record<string, unknown>) {
  return (
    stringArgument(args, "description") ??
    stringArgument(args, "task_text") ??
    stringArgument(args, "prompt")
  );
}

function taskFailureReason(output: ToolExecutionOutput) {
  const metadata = output.metadata ?? {};
  const exitCode = metadata.exitCode ?? metadata.statusCode ?? metadata.code;
  if (typeof exitCode === "number" && exitCode !== 0) {
    return `task exited with code ${exitCode}`;
  }

  const metadataText = Object.values(metadata)
    .filter((value) => typeof value === "string")
    .join("\n");
  const combinedText = [output.title ?? "", output.output ?? "", metadataText].join("\n");
  if (!combinedText.trim()) {
    return null;
  }

  if (/permission denied|blocked by permission|not allowed|access denied/i.test(combinedText)) {
    return "task hit a permission boundary";
  }
  if (/timed out|timeout|deadline exceeded/i.test(combinedText)) {
    return "task timed out";
  }
  if (
    /rate.?limit|too many requests|quota|service unavailable|temporarily unavailable|overloaded|all credentials for model|retrying in|model not found|payment required|out of credits|insufficient quota/i.test(
      combinedText,
    )
  ) {
    return "task hit a provider or model runtime failure";
  }
  if (/error|failed|exception|traceback|panic:/i.test(combinedText)) {
    return "task returned an error";
  }

  return null;
}

function taskOutputSnippet(output: ToolExecutionOutput) {
  const metadataText = Object.values(output.metadata ?? {})
    .filter((value) => typeof value === "string")
    .join("\n");
  const combinedText = [output.title ?? "", output.output ?? "", metadataText].join("\n").trim();
  return combinedText || null;
}

const plugin: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) {
        return;
      }

      const health = await loadSessionAgentHealth(ctx.directory, input.sessionID);
      const unstableAgents = listUnstableAgents(health);
      if (!unstableAgents.length) {
        return;
      }

      output.system.push(
        [
          "DR specialist babysitter:",
          `- Unstable helpers for this session: ${unstableAgents
            .map((agent) => {
              const fallbackText = agent.fallbackAgent ? ` -> ${agent.fallbackAgent}` : "";
              const taskText = agent.lastTaskDescription ? ` on "${agent.lastTaskDescription}"` : "";
              const recoveryText = agent.recoveryHint ? ` | ${agent.recoveryHint}` : "";
              return `${agent.agent} (${agent.failureCount}${taskText}${fallbackText}${recoveryText})`;
            })
            .join(", ")}`,
          "- Avoid unstable helpers when a stable alternative exists.",
          "- If the same blind spot still matters, choose a different helper class or stay local.",
          "- Use show_unstable_helpers for the recorded reasons.",
        ].join("\n"),
      );
    },
    "tool.execute.before": async (input: ToolExecutionInput) => {
      if (!input.sessionID || input.tool !== "task") {
        return;
      }

      const args = input.args ?? {};
      const agent = taskAgentName(args);
      if (!agent) {
        return;
      }

      await recordAgentActivityStart(ctx.directory, input.sessionID, {
        agent,
        taskDescription: taskDescription(args),
        tool: "task",
      });
    },
    "tool.execute.after": async (input: ToolExecutionInput, output: ToolExecutionOutput) => {
      if (!input.sessionID || input.tool !== "task") {
        return;
      }

      const args = input.args ?? {};
      const agent = taskAgentName(args);
      if (!agent) {
        return;
      }

      const reason = taskFailureReason(output);
      await recordAgentActivityCompletion(ctx.directory, input.sessionID, {
        agent,
        taskDescription: taskDescription(args),
        tool: "task",
        status: reason ? "failed" : "completed",
        outputSnippet: taskOutputSnippet(output),
        blockerReason: reason,
      });

      if (!reason) {
        return;
      }

      await recordAgentFailure(ctx.directory, input.sessionID, {
        agent,
        reason,
        taskDescription: taskDescription(args),
        tool: "task",
      });
    },
    tool: {
      show_unstable_helpers: tool({
        description: "Show unstable helper agents detected for the current session and why they were flagged.",
        args: {},
        async execute(_args, context) {
          const health = await loadSessionAgentHealth(context.directory, context.sessionID);
          const unstableAgents = listUnstableAgents(health);
          return JSON.stringify(
            {
              unstableAgents,
              observableState: unstableAgents.map((agent) => ({
                agent: agent.agent,
                failureCount: agent.failureCount,
                lastTaskDescription: agent.lastTaskDescription,
                failureClasses: agent.failureClasses,
                latestObservedBlocker: agent.reasons[0] ?? null,
                fallbackAgent: agent.fallbackAgent,
                recoveryHint: agent.recoveryHint,
              })),
              failures: health?.failures ?? [],
            },
            null,
            2,
          );
        },
      }),
      show_helper_activity: tool({
        description:
          "Show recent helper-agent activity for the current session, including running, failed, and completed helper tasks.",
        args: {
          limit: tool.schema.number().optional().describe("Maximum number of recent helper activities to show."),
        },
        async execute(args, context) {
          const health = await loadSessionAgentHealth(context.directory, context.sessionID);
          const unstableAgents = listUnstableAgents(health);
          const activities = listRecentAgentActivities(health, Date.now(), args.limit ?? 20);
          return JSON.stringify(
            {
              summary: {
                runningCount: activities.filter((activity) => activity.status === "running").length,
                failedCount: activities.filter((activity) => activity.status === "failed").length,
                completedCount: activities.filter((activity) => activity.status === "completed").length,
                unstableHelperCount: unstableAgents.length,
              },
              activities,
              unstableAgents,
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
