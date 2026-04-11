/**
 * Control-plane specialist routing for aicoder-opencode.
 *
 * This plugin keeps the shared maintenance server target-aware without copying
 * repo-specific runtime logic into the control plane. It exposes helper tools
 * for specialist discovery and adds a small system reminder so target names and
 * prompt work do not stay shallow in the main line.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Plugin, tool } from "@opencode-ai/plugin";
import { parse as parseYaml } from "yaml";

const PLUGIN_SOURCE_FILE_PATH = fileURLToPath(import.meta.url);
const PLUGIN_SOURCE_DIRECTORY = path.dirname(PLUGIN_SOURCE_FILE_PATH);
const CONTROL_PLANE_ROOT_DIRECTORY = path.resolve(PLUGIN_SOURCE_DIRECTORY, "..", "..");
const TARGET_CONFIGURATION_DIRECTORY = path.join(
  CONTROL_PLANE_ROOT_DIRECTORY,
  "config",
  "targets",
);
const TARGET_DOCS_DIRECTORY = path.join(CONTROL_PLANE_ROOT_DIRECTORY, "docs", "targets");
const PROMPT_WORK_PATTERN =
  /(prompt|prompts|system prompt|agent prompt|instruction|instructions|ag(e?)nts\.md|skill|skills|plugin|plugins|doctrine|wording|guardrail|role design|command surface|overlay)/i;
const DR_TARGET_PATTERN =
  /\bdr-repo\b|\bdr repo\b|\bportal\b|\bdr-agent\b|\bgateway\b|\binstaller\b|\bmigrations\b/i;
const LETTA_TARGET_PATTERN =
  /\bletta-workspace\b|\bletta workspace\b|\bletta-code\b|\bletta-fleet\b|\bletta-selfhost\b|\blettactl\b|\bmonorepo\b/i;
const AICODER_TARGET_PATTERN =
  /\baicoder-opencode\b|\baidev\b|\bcontrol plane\b|\bmodel registry\b|\btarget registry\b/i;

type TargetKind = "repo" | "monorepo";

type TargetSubproject = {
  name: string;
  root: string;
};

type ControlPlaneTarget = {
  name: string;
  kind: TargetKind;
  root: string;
  instructionPath: string;
  docsPath: string;
  maintenanceOwner: string;
  notes: string[];
  subprojects: TargetSubproject[];
};

type HelperCatalogEntry = {
  agent: string;
  description: string;
  mode: string;
  model: string;
  filePath: string;
};

type Recommendation = {
  agent: string;
  reason: string;
  when: string;
  jobBoundary: string;
  confidence: number;
  targetName?: string;
  targetInstructionPath?: string;
  targetDocsPath?: string;
};

type RawTargetConfiguration = {
  name: string;
  kind: TargetKind;
  root: string;
  instruction_path: string;
  maintenance_owner: string;
  notes?: string[];
  subprojects?: TargetSubproject[];
};

function agentsDirectory(directory: string): string {
  return path.join(directory, ".opencode", "agents");
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatterBody = match?.[1];
  if (!frontmatterBody) {
    return {};
  }

  const fields: Record<string, string> = {};
  for (const line of frontmatterBody.split("\n")) {
    const field = line.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
    if (!field) {
      continue;
    }
    const fieldName = field[1];
    const fieldValue = field[2];
    if (!fieldName || !fieldValue) {
      continue;
    }
    fields[fieldName] = fieldValue.trim();
  }
  return fields;
}

/**
 * Load the locally installed aicoder helper-agent catalog.
 */
export async function loadHelperCatalog(directory: string): Promise<HelperCatalogEntry[]> {
  const fileNames = await readdir(agentsDirectory(directory));
  const entries = await Promise.all(
    fileNames
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

/**
 * Load target declarations from the control-plane registry.
 */
export async function loadControlPlaneTargets(): Promise<ControlPlaneTarget[]> {
  const fileNames = await readdir(TARGET_CONFIGURATION_DIRECTORY);
  const targets = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".yaml"))
      .map(async (fileName) => {
        const filePath = path.join(TARGET_CONFIGURATION_DIRECTORY, fileName);
        const raw = await readFile(filePath, "utf8");
        const target = parseYaml(raw) as RawTargetConfiguration;
        const docsPath = path.join(
          TARGET_DOCS_DIRECTORY,
          `${target.name}.md`,
        );
        return {
          name: target.name,
          kind: target.kind,
          root: target.root,
          instructionPath: target.instruction_path,
          docsPath,
          maintenanceOwner: target.maintenance_owner,
          notes: target.notes ?? [],
          subprojects: target.subprojects ?? [],
        } satisfies ControlPlaneTarget;
      }),
  );

  return targets.sort((left, right) => left.name.localeCompare(right.name));
}

function confidenceScore(matches: number, targetKind: TargetKind): number {
  const baseConfidence = targetKind === "monorepo" ? 0.88 : 0.85;
  return Math.min(0.97, baseConfidence + matches * 0.03);
}

/**
 * Match a task description to the most relevant configured control-plane target.
 */
export function matchTargetForTask(
  taskText: string,
  targets: ControlPlaneTarget[],
): ControlPlaneTarget | null {
  const scores = targets.map((target) => {
    let score = 0;
    const lowerText = taskText.toLowerCase();
    if (lowerText.includes(target.name.toLowerCase())) {
      score += 3;
    }

    if (target.name === "dr-repo" && DR_TARGET_PATTERN.test(taskText)) {
      score += 2;
    }
    if (target.name === "letta-workspace" && LETTA_TARGET_PATTERN.test(taskText)) {
      score += 2;
    }
    if (target.name === "aicoder-opencode" && AICODER_TARGET_PATTERN.test(taskText)) {
      score += 2;
    }

    for (const subproject of target.subprojects) {
      if (lowerText.includes(subproject.name.toLowerCase())) {
        score += 2;
      }
    }

    return { target, score };
  });

  const best = scores.sort((left, right) => right.score - left.score)[0];
  if (!best || best.score === 0) {
    return null;
  }
  return best.target;
}

/**
 * Recommend the narrowest useful helpers for a control-plane task.
 */
export function recommendSpecialists(
  taskText: string,
  targets: ControlPlaneTarget[],
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const matchedTarget = matchTargetForTask(taskText, targets);

  if (matchedTarget) {
    const matchCount =
      1 +
      matchedTarget.subprojects.filter((subproject) =>
        taskText.toLowerCase().includes(subproject.name.toLowerCase()),
      ).length;
    recommendations.push({
      agent: "target_context_reader",
      reason:
        "The task names a configured target repo or one of its subprojects, so shallow generic control-plane reasoning is not enough.",
      when:
        "Use before planning or patching when work names dr-repo, letta-workspace, or one of their child components.",
      jobBoundary:
        "Read target declaration, target docs, and repo boundary only. Do not become the implementation owner.",
      confidence: confidenceScore(matchCount, matchedTarget.kind),
      targetName: matchedTarget.name,
      targetInstructionPath: matchedTarget.instructionPath,
      targetDocsPath: matchedTarget.docsPath,
    });
  }

  if (PROMPT_WORK_PATTERN.test(taskText)) {
    recommendations.push({
      agent: "prompt_architect",
      reason:
        "The task is about prompts, doctrine, skills, plugins, or command surfaces and needs structure rather than ad hoc wording edits.",
      when:
        "Use first for prompt systems, AGENTS.md doctrine, skill contracts, and plugin behavior framing.",
      jobBoundary:
        "Design instruction hierarchy, boundaries, and evaluation shape only. Do not own the final wording pass alone.",
      confidence: 0.93,
    });
    recommendations.push({
      agent: "prompt_critic",
      reason:
        "Prompt and doctrine changes need an adversarial failure-mode pass before being promoted into the shared base.",
      when:
        "Use after the prompt structure is drafted and before rollout to the target overlays.",
      jobBoundary:
        "Stress-test wording, edge cases, and ambiguity only. Do not widen scope into generic planning or implementation.",
      confidence: 0.9,
      ...(matchedTarget
        ? {
            targetName: matchedTarget.name,
            targetInstructionPath: matchedTarget.instructionPath,
            targetDocsPath: matchedTarget.docsPath,
          }
        : {}),
    });
  }

  return recommendations;
}

function buildControlPlaneSystemPrompt(targets: ControlPlaneTarget[]): string {
  const targetLines = targets.map(
    (target) => `- ${target.name}: ${target.kind} at ${target.root}`,
  );

  return [
    "## Control-plane target routing",
    "This server is the shared maintenance control plane, not a product-only lane.",
    "When a task names a target repo or subproject, read the control-plane target declaration and target docs before planning.",
    "When a task is about prompts, doctrine, skills, plugins, or commands, prefer the prompt specialists instead of keeping everything in implementation_lead.",
    "Known targets:",
    ...targetLines,
  ].join("\n");
}

export const ControlPlaneSpecialistRoutingPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      list_specialist_helpers: tool({
        description:
          "List aicoder-opencode helper agents, including their models and source files.",
        args: {},
        async execute() {
          const helpers = await loadHelperCatalog(ctx.directory);
          return JSON.stringify({ helpers }, null, 2);
        },
      }),
      list_control_plane_targets: tool({
        description:
          "List configured control-plane targets and their docs/config ownership.",
        args: {},
        async execute() {
          const targets = await loadControlPlaneTargets();
          return JSON.stringify({ targets }, null, 2);
        },
      }),
      show_control_plane_target: tool({
        description:
          "Show one control-plane target with config, docs path, and notes.",
        args: {
          target_name: tool.schema.string().describe("Target name, for example dr-repo or letta-workspace."),
        },
        async execute(args) {
          const targets = await loadControlPlaneTargets();
          const target = targets.find((entry) => entry.name === args.target_name);
          if (!target) {
            throw new Error(`unknown control-plane target: ${args.target_name}`);
          }
          const targetDocs = await readFile(target.docsPath, "utf8");
          return JSON.stringify(
            {
              target,
              targetDocs,
            },
            null,
            2,
          );
        },
      }),
      suggest_specialist_helpers: tool({
        description:
          "Suggest the narrowest useful aicoder specialists for a task, including prompt work and target-aware deep reads.",
        args: {
          task_text: tool.schema.string().describe("Task description or current problem statement."),
        },
        async execute(args) {
          const targets = await loadControlPlaneTargets();
          const recommendations = recommendSpecialists(args.task_text, targets);
          if (!recommendations.length) {
            return JSON.stringify(
              {
                recommendations: [
                  {
                    agent: "implementation_lead",
                    reason: "No narrower specialist stands out from the task description.",
                    when: "Keep ownership in the main line when the task is already explicit and bounded.",
                    jobBoundary: "Own synthesis and implementation without spawning extra helpers by habit.",
                    confidence: 0.5,
                  },
                ],
              },
              null,
              2,
            );
          }

          return JSON.stringify({ recommendations }, null, 2);
        },
      }),
    },

    async "experimental.chat.system.transform"(_input, output) {
      try {
        const targets = await loadControlPlaneTargets();
        output.system.push(buildControlPlaneSystemPrompt(targets));
      } catch {
        return;
      }
    },
  };
};
