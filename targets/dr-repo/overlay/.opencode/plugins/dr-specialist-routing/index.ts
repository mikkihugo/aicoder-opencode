import { tool, type Plugin } from "@opencode-ai/plugin";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  MAX_HEAVY_READER_SPECIALISTS,
  MAX_LIGHT_READER_SPECIALISTS,
  MAX_REVIEWER_SPECIALISTS,
  MAX_TOTAL_PARALLEL_SPECIALISTS,
  MAX_WORKER_SPECIALISTS,
  maxParallelForClass,
  parallelClassForAgent,
} from "../shared/helper-parallel-policy.ts";
import { loadSessionAgentHealth, listUnstableAgents } from "../shared/session-agent-health.ts";

type Recommendation = {
  agent: string;
  failureMode: string;
  when: string;
  jobBoundary: string;
  skills: string[];
  confidence: number;
  parallelClass: "heavy_reader" | "light_reader" | "reviewer" | "worker" | "owner";
  maxParallelForClass: number;
  unstable?: boolean;
  instabilityReason?: string;
  fallbackAgent?: string | null;
  recoveryHint?: string | null;
};

type HelperCatalogEntry = {
  agent: string;
  description: string;
  mode: string;
  model: string;
  filePath: string;
};

function agentsDirectory(directory: string) {
  return path.join(directory, ".opencode", "agents");
}

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return {};
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
    if (!field) {
      continue;
    }
    fields[field[1]] = field[2].trim();
  }
  return fields;
}

async function loadHelperCatalog(directory: string): Promise<HelperCatalogEntry[]> {
  const files = await readdir(agentsDirectory(directory));
  const entries = await Promise.all(
    files
      .filter((fileName) => fileName.endsWith(".md"))
      .map(async (fileName) => {
        const filePath = path.join(agentsDirectory(directory), fileName);
        const content = await readFile(filePath, "utf8");
        const frontmatter = parseFrontmatter(content);
        return {
          agent: fileName.replace(/\.md$/, ""),
          description: frontmatter.description ?? "",
          mode: frontmatter.mode ?? "unknown",
          model: frontmatter.model ?? "unspecified",
          filePath: path.join(".opencode", "agents", fileName),
        };
      }),
  );

  return entries.sort((left, right) => left.agent.localeCompare(right.agent));
}

export function recommend(taskText: string): Recommendation[] {
  const text = taskText.toLowerCase();
  const results: Recommendation[] = [];

  const add = (
    agent: string,
    failureMode: string,
    when: string,
    jobBoundary: string,
    skills: string[],
    confidence: number,
  ) => {
    const parallelClass = parallelClassForAgent(agent);
    results.push({
      agent,
      failureMode,
      when,
      jobBoundary,
      skills,
      confidence,
      parallelClass,
      maxParallelForClass: maxParallelForClass(parallelClass),
    });
  };

  if (/(design|architecture|tradeoff|boundary|cross-component|multi-system|rethink|assumption)/.test(text)) {
    add(
      "architecture_consultant",
      "Structural assumption or cross-boundary design risk",
      "Use when the next step depends on an architectural assumption or repeated failed attempts suggest the design is wrong.",
      "Review structure, boundaries, and simplification only. Do not take ownership of implementation or planning as a whole.",
      ["dr-design-and-planning", "dr-systematic-debugging"],
      0.93,
    );
  }

  if (/(oracle|self-review|second opinion|sanity check|hard debugging|stuck after|failed fix|failed attempt|major tradeoff|strategic advice|simplest path)/.test(text)) {
    add(
      "oracle",
      "High-cost decision or repeated failed-fix risk that needs an independent recommendation",
      "Use after repeated failed fixes, after significant implementation, or when a high-cost tradeoff needs one clear recommendation and escalation triggers.",
      "Give strategic diagnosis and one bounded recommendation only. Do not implement, own the plan, or replace source-backed research.",
      ["dr-systematic-debugging", "dr-code-review", "dr-design-and-planning"],
      0.94,
    );
  }

  if (/(doc|docs|api|upstream|framework|library|example|reference|research|blog|sdk)/.test(text)) {
    add(
      "documentation_researcher",
      "External dependency or upstream behavior uncertainty",
      "Use for current external docs, APIs, frameworks, examples, and authoritative references.",
      "Gather external evidence only. Do not become the general planner or code owner.",
      ["dr-design-and-planning", "dr-clarify-spec"],
      0.92,
    );
  }

  if (/(where|find|trace|map|route|template|grep|search|which file|code path|ownership|entry point)/.test(text)) {
    add(
      "codebase_explorer",
      "Local code ownership or path-mapping uncertainty",
      "Use for cheap codebase mapping before spending deeper models on broad repo reading.",
      "Map the execution path and ownership only. Do not redesign or implement.",
      ["dr-design-and-planning", "dr-portal-ui-and-handlers"],
      0.88,
    );
  }

  if (/(user|customer|operator|admin flow|installer flow|workflow|onboarding|journey|ux|friction|confusing|discoverability|manual step|end-to-end|user-visible)/.test(text)) {
    add(
      "consumer_advocate",
      "Consumer workflow or user-visible friction risk",
      "Use when the next choice needs the point of view of the person actually operating or consuming the system.",
      "Inspect the customer, admin, operator, or installer experience only. Do not become the general planner or implementation owner.",
      ["dr-design-and-planning", "dr-production-readiness", "dr-portal-ui-and-handlers"],
      0.9,
    );
  }

  if (/(broad read|whole subsystem|many files|cross-component read|long context|read the subsystem|understand the subsystem|deep search|advanced search|deep audit|codebase audit|thorough audit|many-file analysis|scan the subsystem|read widely)/.test(text)) {
    add(
      "long_context_reader",
      "Broad subsystem understanding risk that exceeds cheap local mapping",
      "Use when the next decision depends on evidence spread across many files or multiple components.",
      "Read broadly and summarize the relevant evidence only. Do not redesign, verify, or implement.",
      ["dr-design-and-planning", "dr-production-readiness"],
      0.9,
    );
  }

  if (/(roadmap|status|what next|next slice|next milestone|priority|priorit|sequence|sequencing|dependency order|milestone|backlog|stale plan|stale next step|blocked slice|release plan)/.test(text)) {
    add(
      "roadmap_keeper",
      "Execution-state or sequencing drift",
      "Use when roadmap, status, checkpoints, or next-slice ordering may be stale, blocked, or out of sequence.",
      "Keep milestones, next-step ordering, and artifact coherence aligned only. Do not take over implementation or broad product strategy.",
      ["dr-session-pickup", "dr-design-and-planning", "dr-production-readiness"],
      0.92,
    );
  }

  if (/(review|regression|missing test|edge case|pre-merge|correctness|critique|prove it)/.test(text)) {
    add(
      "critical_reviewer",
      "Correctness, regression, or missing-test risk",
      "Use for a narrow blocker-focused review before the next significant step.",
      "Review for correctness and missing proof only. Do not broaden scope or rewrite the plan.",
      ["dr-code-review", "dr-security-review"],
      0.91,
    );
  }

  if (/(security|auth|session|csrf|token|secret|credential|permission|injection|sql|xss|dangerous command|trust boundary)/.test(text)) {
    add(
      "security_reviewer",
      "Security or trust-boundary risk",
      "Use when the next decision depends on auth, session, CSRF, secret handling, injection resistance, or another trust boundary.",
      "Review only for security blockers and missing proof at the boundary. Do not become the general planner or implementation owner.",
      ["dr-security-review", "dr-code-review"],
      0.95,
    );
  }

  if (/(verify|verification|verify it|re-run|rerun|prove it works|regression check|quality gate|lint|test pass|test run)/.test(text)) {
    add(
      "verifier",
      "Verification or proof-of-completion risk",
      "Use when the current blocker is whether the change is actually verified rather than whether it is well designed.",
      "Run or inspect the bounded verification evidence only. Do not become the new planner or implementation owner.",
      ["dr-finish-and-verify", "dr-spec-first-tdd"],
      0.89,
    );
  }

  if (/(plan|scope|proposal|clarify|acceptance criteria|task list|purpose|consumer|contract)/.test(text)) {
    add(
      "planning_analyst",
      "Execution-readiness or scope ambiguity",
      "Use when purpose, contract, scope, or task slicing is not yet execution-ready.",
      "Clarify and slice the work only. Do not take over implementation or external research unless explicitly requested.",
      ["dr-clarify-spec", "dr-design-and-planning", "dr-generate-tasks"],
      0.86,
    );
  }

  if (/(hard bug|deep implementation|multi-file|refactor|complex change|hardest coding|stuck in code)/.test(text)) {
    add(
      "implementation_worker",
      "Hard implementation once the contract is already clear",
      "Use for difficult coding or debugging only after the slice and contract are explicit.",
      "Implement the bounded slice only. Do not redefine the purpose or plan.",
      ["dr-spec-first-tdd", "dr-wave-implementation"],
      0.83,
    );
  }

  if (/(reliability|sre|incident|rollout|production|queue depth|alert|operational|capacity|circuit breaker|rate limit|failover|recovery|readiness)/.test(text)) {
    add(
      "reliability_consultant",
      "Operational safety or production-readiness risk",
      "Use for failure modes, rollout safety, queue depth, alerting, incident posture, and release risk.",
      "Focus on operational safety tied to the product purpose. Do not drift into generic ops chatter.",
      ["dr-production-readiness", "dr-systematic-debugging", "dr-finish-and-verify"],
      0.94,
    );
  }

  return results.sort((a, b) => b.confidence - a.confidence).slice(0, 2);
}

export function markUnstableRecommendations(
  recommendations: Recommendation[],
  unstableAgents: Array<{
    agent: string;
    failureCount: number;
    fallbackAgent?: string | null;
    recoveryHint?: string | null;
  }>,
) {
  const unstableByAgent = new Map(unstableAgents.map((agent) => [agent.agent, agent]));
  return recommendations.map((recommendation) => {
    const instability = unstableByAgent.get(recommendation.agent);
    if (!instability) {
      return recommendation;
    }
    return {
      ...recommendation,
      unstable: true,
      instabilityReason: `${recommendation.agent} failed ${instability.failureCount} times recently in this session`,
      fallbackAgent: instability.fallbackAgent ?? null,
      recoveryHint: instability.recoveryHint ?? null,
      confidence: Math.max(0, recommendation.confidence - 0.25),
    };
  });
}

export function filterUnstableRecommendations(recommendations: Recommendation[]) {
  const stableRecommendations = recommendations.filter((recommendation) => !recommendation.unstable);
  return stableRecommendations.length ? stableRecommendations : recommendations;
}

const plugin: Plugin = async (ctx) => {
  return {
    tool: {
      list_specialist_helpers: tool({
        description:
          "List the repo-local OpenCode helper agents, including their current model assignments and source files.",
        args: {},
        async execute(_args, context) {
          const catalog = await loadHelperCatalog(ctx.directory);
          const unstableAgents = listUnstableAgents(
            await loadSessionAgentHealth(ctx.directory, context.sessionID),
          );
          return JSON.stringify({ helpers: catalog, unstableAgents }, null, 2);
        },
      }),
      suggest_specialist_helpers: tool({
        description:
          "Suggest the narrowest useful helper agents and skills for a task description. Prefer one specialist; return two only when they close different blind spots.",
        args: {
          task_text: tool.schema.string().describe("Task description or current problem statement."),
        },
        async execute(args, context) {
          const unstableAgents = listUnstableAgents(
            await loadSessionAgentHealth(ctx.directory, context.sessionID),
          );
          const recommendations = filterUnstableRecommendations(
            markUnstableRecommendations(recommend(args.task_text), unstableAgents),
          );
          if (!recommendations.length) {
            return JSON.stringify(
              {
                recommendations: [
                  {
                    agent: "implementation_lead",
                    failureMode: "No narrower specialist stands out",
                    when: "Keep ownership in the main line when the task is already clear enough.",
                    jobBoundary: "Own synthesis and implementation without spawning extra helpers by habit.",
                    skills: ["dr-design-and-planning", "dr-spec-first-tdd"],
                    confidence: 0.5,
                    parallelClass: "owner",
                    maxParallelForClass: 1,
                  },
                ],
                parallelPolicy: {
                  maxSubagentDepth: 1,
                  maxTotalSpecialists: MAX_TOTAL_PARALLEL_SPECIALISTS,
                  maxHeavyReaders: MAX_HEAVY_READER_SPECIALISTS,
                  maxLightReaders: MAX_LIGHT_READER_SPECIALISTS,
                  maxReviewers: MAX_REVIEWER_SPECIALISTS,
                  maxWorkers: MAX_WORKER_SPECIALISTS,
                },
                unstableAgents,
                guidance: "Use fewer responsibilities per helper. Choose the narrowest role that reduces the current blind spot.",
              },
              null,
              2,
            );
          }
          return JSON.stringify(
            {
              recommendations,
              parallelPolicy: {
                maxSubagentDepth: 1,
                maxTotalSpecialists: MAX_TOTAL_PARALLEL_SPECIALISTS,
                maxHeavyReaders: MAX_HEAVY_READER_SPECIALISTS,
                maxLightReaders: MAX_LIGHT_READER_SPECIALISTS,
                maxReviewers: MAX_REVIEWER_SPECIALISTS,
                maxWorkers: MAX_WORKER_SPECIALISTS,
              },
              unstableAgents,
              guidance: "Prefer one primary specialist. Add a second only if it closes a different blind spot or uses a different model family for an important decision. Do not exceed the parallel policy caps, and avoid helpers already marked unstable in this session when a stable alternative exists.",
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
