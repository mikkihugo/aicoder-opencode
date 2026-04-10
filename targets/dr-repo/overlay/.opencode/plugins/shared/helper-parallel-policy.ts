import type { AgentActivityView } from "./session-agent-health.ts";

export const MAX_TOTAL_PARALLEL_SPECIALISTS = 3;
export const MAX_HEAVY_READER_SPECIALISTS = 1;
export const MAX_LIGHT_READER_SPECIALISTS = 2;
export const MAX_REVIEWER_SPECIALISTS = 2;
export const MAX_WORKER_SPECIALISTS = 1;

export type HelperParallelClass = "heavy_reader" | "light_reader" | "reviewer" | "worker" | "owner";

export type HelperParallelCounts = {
  totalRunning: number;
  byClass: Record<HelperParallelClass, number>;
};

export type HelperLaunchDecision = {
  allowed: boolean;
  reason: string | null;
  parallelClass: HelperParallelClass;
  counts: HelperParallelCounts;
};

export function parallelClassForAgent(agent: string): HelperParallelClass {
  if (["long_context_reader", "architecture_consultant", "reliability_consultant", "consumer_advocate", "oracle"].includes(agent)) {
    return "heavy_reader";
  }
  if (["codebase_explorer", "documentation_researcher", "roadmap_keeper", "planning_analyst"].includes(agent)) {
    return "light_reader";
  }
  if (["critical_reviewer", "security_reviewer", "verifier"].includes(agent)) {
    return "reviewer";
  }
  if (["implementation_worker", "small_change_worker"].includes(agent)) {
    return "worker";
  }
  return "owner";
}

export function maxParallelForClass(parallelClass: HelperParallelClass) {
  switch (parallelClass) {
    case "heavy_reader":
      return MAX_HEAVY_READER_SPECIALISTS;
    case "light_reader":
      return MAX_LIGHT_READER_SPECIALISTS;
    case "reviewer":
      return MAX_REVIEWER_SPECIALISTS;
    case "worker":
      return MAX_WORKER_SPECIALISTS;
    default:
      return 1;
  }
}

export function helperParallelCounts(runningActivities: AgentActivityView[]): HelperParallelCounts {
  const counts: HelperParallelCounts = {
    totalRunning: 0,
    byClass: {
      heavy_reader: 0,
      light_reader: 0,
      reviewer: 0,
      worker: 0,
      owner: 0,
    },
  };

  for (const runningActivity of runningActivities) {
    if (runningActivity.status !== "running") {
      continue;
    }
    counts.totalRunning += 1;
    counts.byClass[parallelClassForAgent(runningActivity.agent)] += 1;
  }

  return counts;
}

function hasRunningActivityForAgent(agent: string, runningActivities: AgentActivityView[]) {
  return runningActivities.some(
    (runningActivity) => runningActivity.status === "running" && runningActivity.agent === agent,
  );
}

export function canLaunchHelperTask(agent: string, runningActivities: AgentActivityView[]): HelperLaunchDecision {
  const counts = helperParallelCounts(runningActivities);
  const parallelClass = parallelClassForAgent(agent);

  if (hasRunningActivityForAgent(agent, runningActivities)) {
    return {
      allowed: false,
      reason: `${agent} is already running for this session`,
      parallelClass,
      counts,
    };
  }

  if (counts.totalRunning >= MAX_TOTAL_PARALLEL_SPECIALISTS) {
    return {
      allowed: false,
      reason: `max total specialists already running (${counts.totalRunning}/${MAX_TOTAL_PARALLEL_SPECIALISTS})`,
      parallelClass,
      counts,
    };
  }

  const classLimit = maxParallelForClass(parallelClass);
  const runningInClass = counts.byClass[parallelClass];
  if (runningInClass >= classLimit) {
    return {
      allowed: false,
      reason: `${parallelClass} cap already hit (${runningInClass}/${classLimit})`,
      parallelClass,
      counts,
    };
  }

  return {
    allowed: true,
    reason: null,
    parallelClass,
    counts,
  };
}
