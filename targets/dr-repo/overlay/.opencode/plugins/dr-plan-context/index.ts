import { tool, type Plugin } from "@opencode-ai/plugin";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type CheckpointRecord = {
  sessionID: string;
  planPath?: string;
  currentSlice?: string;
  nextStep?: string;
  updatedAt?: string;
};

type ActiveSliceSummary = {
  status?: string;
  currentSlice?: string;
  nextStep?: string;
  parkedReason?: string;
  nextFeature?: string;
};

type ActivePlanSummary = {
  planDirectory: string;
  proposalPath: string | null;
  activeSlicePath: string | null;
  status: string;
  currentSlice: string | null;
  nextStep: string | null;
  parkedReason: string | null;
  nextFeature: string | null;
  updatedAt: string | null;
};

const PLAN_ROOT_PATH = path.join("docs", "plans");
const MAX_DR_STATE_PLAN_COUNT = 3;
const DEFAULT_ACTIVE_PLAN_LIMIT = 10;
const MAINTENANCE_OPERATOR_NOTE_PATH = path.join(
  ".opencode",
  "state",
  "autopilot",
  "maintenance-operator-note.md",
);

function activeSlicePathFromPlan(planPath?: string) {
  if (!planPath) {
    return null;
  }
  const directory = path.dirname(planPath);
  if (directory === "docs/plans" || directory === path.join("docs", "plans")) {
    return null;
  }
  return path.join(directory, "active-slice.md");
}

function checkpointPath(directory: string, sessionID: string) {
  return path.join(directory, ".opencode", "state", "checkpoints", `${sessionID}.json`);
}

function ledgerDir(directory: string) {
  return path.join(directory, ".opencode", "state", "ledgers");
}

function planRoot(directory: string) {
  return path.join(directory, PLAN_ROOT_PATH);
}

function normalizeStatus(status?: string) {
  const normalizedStatus = String(status ?? "").trim().toLowerCase();
  if (!normalizedStatus) {
    return "in_progress";
  }
  return normalizedStatus;
}

function normalizeNextStep(nextStep?: string) {
  const normalizedNextStep = String(nextStep ?? "").trim();
  if (!normalizedNextStep || normalizedNextStep.toLowerCase() === "none") {
    return "";
  }
  return normalizedNextStep;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseInlineField(content: string, label: string) {
  const pattern = new RegExp(`(?:\\*\\*${escapeRegex(label)}:\\*\\*|- ${escapeRegex(label)}:)\\s*(.+)$`, "mi");
  return content.match(pattern)?.[1]?.trim();
}

function parseActiveSliceSummary(content: string): ActiveSliceSummary {
  return {
    status: parseInlineField(content, "Status"),
    currentSlice: parseInlineField(content, "Current Slice"),
    nextStep: parseInlineField(content, "Next Step"),
    parkedReason: parseInlineField(content, "Parked Reason"),
    nextFeature: parseInlineField(content, "Next Feature"),
  };
}

async function loadCheckpoint(directory: string, sessionID: string): Promise<CheckpointRecord | null> {
  try {
    const raw = await readFile(checkpointPath(directory, sessionID), "utf8");
    return JSON.parse(raw) as CheckpointRecord;
  } catch {
    return null;
  }
}

async function updateCheckpoint(directory: string, sessionID: string, patch: Partial<CheckpointRecord>) {
  const existing = (await loadCheckpoint(directory, sessionID)) ?? { sessionID };
  const merged = {
    ...existing,
    ...patch,
    sessionID,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(checkpointPath(directory, sessionID)), { recursive: true });
  await writeFile(checkpointPath(directory, sessionID), JSON.stringify(merged, null, 2) + "\n", "utf8");
}

async function readBoundedFile(directory: string, filePath: string, maxChars: number) {
  const fullPath = path.join(directory, filePath);
  const raw = await readFile(fullPath, "utf8");
  const trimmed = raw.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(0, maxChars) + "\n...[truncated]";
}

async function tryReadContextFile(directory: string, filePath: string, maxChars: number) {
  try {
    const content = await readBoundedFile(directory, filePath, maxChars);
    return { filePath, content };
  } catch {
    return null;
  }
}

async function loadMaintenanceOperatorNote(directory: string) {
  return tryReadContextFile(directory, MAINTENANCE_OPERATOR_NOTE_PATH, 1800);
}

async function loadProjectContext(directory: string) {
  const candidates = [
    "AGENTS.md",
    "TDD_SPEC_FIRST.md",
    "ARCHITECTURE.md",
    "STYLEGUIDE.md",
    "STATUS.md",
  ];
  const results = await Promise.all(
    candidates.map((candidate) => tryReadContextFile(directory, candidate, 1800)),
  );
  return results.filter(Boolean) as Array<{ filePath: string; content: string }>;
}

async function listPlanDirectories(directory: string) {
  try {
    const entries = await readdir(planRoot(directory), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function readActiveSliceSummary(directory: string, planDirectoryName: string) {
  const relativePath = path.join(PLAN_ROOT_PATH, planDirectoryName, "active-slice.md");
  try {
    const fullPath = path.join(directory, relativePath);
    const raw = await readFile(fullPath, "utf8");
    return {
      relativePath,
      summary: parseActiveSliceSummary(raw),
      updatedAt: (await stat(fullPath)).mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

async function readProposalTimestamp(directory: string, planDirectoryName: string) {
  const relativePath = path.join(PLAN_ROOT_PATH, planDirectoryName, "proposal.md");
  try {
    return {
      relativePath,
      updatedAt: (await stat(path.join(directory, relativePath))).mtime.toISOString(),
    };
  } catch {
    return {
      relativePath: null,
      updatedAt: null,
    };
  }
}

async function listActivePlans(directory: string) {
  const planDirectoryNames = await listPlanDirectories(directory);
  const activePlans: ActivePlanSummary[] = [];

  for (const planDirectoryName of planDirectoryNames) {
    const activeSlice = await readActiveSliceSummary(directory, planDirectoryName);
    if (!activeSlice) {
      continue;
    }

    const proposal = await readProposalTimestamp(directory, planDirectoryName);
    const nextStep = normalizeNextStep(activeSlice.summary.nextStep);

    activePlans.push({
      planDirectory: path.join(PLAN_ROOT_PATH, planDirectoryName),
      proposalPath: proposal.relativePath,
      activeSlicePath: activeSlice.relativePath,
      status: normalizeStatus(activeSlice.summary.status),
      currentSlice: activeSlice.summary.currentSlice ?? null,
      nextStep: nextStep || null,
      parkedReason: activeSlice.summary.parkedReason ?? null,
      nextFeature: activeSlice.summary.nextFeature ?? null,
      updatedAt: activeSlice.updatedAt ?? proposal.updatedAt,
    });
  }

  return activePlans
    .filter((summary) => summary.status !== "done" || !!summary.nextStep)
    .sort((left, right) => {
      const leftUpdatedAt = Date.parse(left.updatedAt ?? "");
      const rightUpdatedAt = Date.parse(right.updatedAt ?? "");
      return (Number.isNaN(rightUpdatedAt) ? 0 : rightUpdatedAt) - (Number.isNaN(leftUpdatedAt) ? 0 : leftUpdatedAt);
    });
}

function renderDrStateBlock(activePlans: ActivePlanSummary[], checkpoint: CheckpointRecord | null) {
  const visiblePlans = activePlans.slice(0, MAX_DR_STATE_PLAN_COUNT);
  return [
    "<dr_state>",
    `session_plan: ${checkpoint?.planPath ?? "none"}`,
    `open_plan_count: ${activePlans.length}`,
    ...visiblePlans.map((plan) => {
      const descriptorParts = [
        plan.planDirectory,
        plan.status,
        plan.currentSlice ? `slice=${plan.currentSlice}` : null,
        plan.nextStep ? `next=${plan.nextStep}` : null,
        plan.parkedReason ? `parked=${plan.parkedReason}` : null,
        plan.nextFeature ? `next_feature=${plan.nextFeature}` : null,
      ].filter(Boolean);
      return `open_plan: ${descriptorParts.join(" | ")}`;
    }),
    "</dr_state>",
  ].join("\n");
}

async function collectArtifactFiles(directory: string) {
  const candidates: string[] = [];

  try {
    const planRoot = path.join(directory, "docs", "plans");
    const entries = await readdir(planRoot, { recursive: true } as any);
    for (const entry of entries as string[]) {
      if (entry.endsWith(".md")) {
        candidates.push(path.join("docs", "plans", entry));
      }
    }
  } catch {
    // ignore
  }

  try {
    const entries = await readdir(ledgerDir(directory));
    for (const entry of entries) {
      if (entry.endsWith(".md")) {
        candidates.push(path.join(".opencode", "state", "ledgers", entry));
      }
    }
  } catch {
    // ignore
  }

  return candidates;
}

function scoreArtifact(query: string, content: string, filePath: string) {
  const q = query.toLowerCase();
  const haystack = `${filePath}\n${content}`.toLowerCase();
  if (!q.trim()) {
    return 0;
  }
  let score = 0;
  for (const token of q.split(/\s+/).filter(Boolean)) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function summarizeArtifact(filePath: string, content: string) {
  const firstHeading = content
    .split("\n")
    .find((line) => line.startsWith("#") || line.trim().startsWith("**"));
  return `${filePath}${firstHeading ? ` :: ${firstHeading.trim()}` : ""}`;
}

const plugin: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) {
        return;
      }

      const checkpoint = await loadCheckpoint(ctx.directory, input.sessionID);
      const activePlans = await listActivePlans(ctx.directory);
      output.system.push(renderDrStateBlock(activePlans, checkpoint));

      const projectContext = await loadProjectContext(ctx.directory);
      if (projectContext.length) {
        output.system.push(
          [
            "DR project context:",
            ...projectContext.map(
              (item) => `<context file="${item.filePath}">\n${item.content}\n</context>`,
            ),
          ].join("\n"),
        );
      }

      const maintenanceOperatorNote = await loadMaintenanceOperatorNote(ctx.directory);
      if (maintenanceOperatorNote) {
        output.system.push(
          `Maintenance operator note:\n<context file="${maintenanceOperatorNote.filePath}">\n${maintenanceOperatorNote.content}\n</context>`,
        );
      }

      if (!checkpoint?.planPath) {
        return;
      }

      const activeSlicePath = activeSlicePathFromPlan(checkpoint.planPath);
      const activeSlice = activeSlicePath
        ? await tryReadContextFile(ctx.directory, activeSlicePath, 2200)
        : null;

      const note = [
        "DR active plan context:",
        `- Plan: ${checkpoint.planPath}`,
        activeSlicePath ? `- Active slice: ${activeSlicePath}` : null,
        checkpoint.currentSlice ? `- Current slice: ${checkpoint.currentSlice}` : null,
        checkpoint.nextStep ? `- Next step: ${checkpoint.nextStep}` : null,
        "- Use the active plan as the execution source of truth. Prefer updating docs/plans artifacts over inventing ad-hoc state.",
        "- Keep reflections and research folded back into the active slice instead of drifting into a separate notes file.",
      ]
        .filter(Boolean)
        .join("\n");
      output.system.push(note);
      if (activeSlice) {
        output.system.push(
          `DR active slice context:\n<context file="${activeSlice.filePath}">\n${activeSlice.content}\n</context>`,
        );
      }
    },
    tool: {
      set_active_plan: tool({
        description:
          "Set the active DR plan for the current session. Use a repo-relative docs/plans/... path so the rest of the runtime can reload the right context.",
        args: {
          plan_path: tool.schema.string().describe("Repo-relative path to the active plan file."),
        },
        async execute(args, context) {
          await updateCheckpoint(context.directory, context.sessionID, { planPath: args.plan_path });
          return `Active plan set to ${args.plan_path}`;
        },
      }),
      load_active_plan_context: tool({
        description:
          "Read the active DR plan context for this session and return a bounded plan summary.",
        args: {
          max_chars: tool.schema.number().optional().describe("Maximum number of characters to return from the plan."),
        },
        async execute(args, context) {
          const checkpoint = await loadCheckpoint(context.directory, context.sessionID);
          if (!checkpoint?.planPath) {
            return "No active plan is set for this session.";
          }
          const maxChars = args.max_chars ?? 3500;
          try {
            const summary = await readBoundedFile(context.directory, checkpoint.planPath, maxChars);
            return `Plan: ${checkpoint.planPath}\n\n${summary}`;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `Active plan is set to ${checkpoint.planPath}, but it could not be read: ${message}`;
          }
        },
      }),
      load_active_slice_context: tool({
        description:
          "Read the active-slice artifact for this session and return a bounded summary when one exists beside the active plan.",
        args: {
          max_chars: tool.schema.number().optional().describe("Maximum number of characters to return from the active-slice artifact."),
        },
        async execute(args, context) {
          const checkpoint = await loadCheckpoint(context.directory, context.sessionID);
          if (!checkpoint?.planPath) {
            return "No active plan is set for this session.";
          }
          const activeSlicePath = activeSlicePathFromPlan(checkpoint.planPath);
          if (!activeSlicePath) {
            return "No active-slice artifact is available for this session.";
          }
          const maxChars = args.max_chars ?? 3000;
          try {
            const summary = await readBoundedFile(context.directory, activeSlicePath, maxChars);
            return `Active slice: ${activeSlicePath}\n\n${summary}`;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `Active slice should be at ${activeSlicePath}, but it could not be read: ${message}`;
          }
        },
      }),
      search_artifacts: tool({
        description:
          "Search DR plans and continuity ledgers for relevant precedent, similar work, or prior decisions.",
        args: {
          query: tool.schema.string().describe("Search query describing the precedent or artifact you want."),
          limit: tool.schema.number().optional().describe("Maximum results to return."),
        },
        async execute(args, context) {
          const files = await collectArtifactFiles(context.directory);
          const scored = await Promise.all(
            files.map(async (filePath) => {
              try {
                const content = await readFile(path.join(context.directory, filePath), "utf8");
                return {
                  filePath,
                  score: scoreArtifact(args.query, content, filePath),
                  summary: summarizeArtifact(filePath, content),
                };
              } catch {
                return null;
              }
            }),
          );

          const results = scored
            .filter((item): item is { filePath: string; score: number; summary: string } => !!item)
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, args.limit ?? 10);

          if (!results.length) {
            return `No matching DR plan or continuity artifacts found for "${args.query}".`;
          }

          return results
            .map((item) => `- ${item.summary} (score ${item.score})`)
            .join("\n");
        },
      }),
      list_active_plans: tool({
        description:
          "List open DR plans that still have an active-slice status or a recorded next step.",
        args: {
          limit: tool.schema.number().optional().describe("Maximum number of open plans to return."),
        },
        async execute(args, context) {
          const activePlans = await listActivePlans(context.directory);
          return JSON.stringify(activePlans.slice(0, args.limit ?? DEFAULT_ACTIVE_PLAN_LIMIT), null, 2);
        },
      }),
    },
  };
};

export default plugin;
