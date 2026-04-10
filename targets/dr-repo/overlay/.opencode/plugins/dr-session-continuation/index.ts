import type { Plugin } from "@opencode-ai/plugin";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadSessionAgentHealth } from "../shared/session-agent-health.ts";

type CheckpointRecord = {
  sessionID: string;
  status?: string;
  currentSlice?: string;
  nextStep?: string;
  autonomousIteration?: boolean;
  planPath?: string;
  verification?: Array<{ category: string; status: string }>;
  updatedAt?: string;
};

type ActiveSliceRecord = {
  purpose?: string;
  consumer?: string;
  valueAtRisk?: string;
  contractTest?: string;
  falsifier?: string;
  status?: string;
};

type ToolExecutionInput = {
  tool?: string;
  args?: Record<string, unknown>;
  sessionID: string;
};

const SUPPORTIVE_HELPER_AGENTS = [
  "planning_analyst",
  "consumer_advocate",
  "codebase_explorer",
  "long_context_reader",
  "architecture_consultant",
  "roadmap_keeper",
] as const;
const ADVERSARIAL_HELPER_AGENTS = [
  "critical_reviewer",
  "security_reviewer",
  "oracle",
  "reliability_consultant",
] as const;
const EDIT_TOOL_NAMES = new Set(["write", "edit", "patch", "apply_patch"]);

function checkpointPath(directory: string, sessionID: string) {
  return path.join(directory, ".opencode", "state", "checkpoints", `${sessionID}.json`);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseInlineField(content: string, label: string) {
  const pattern = new RegExp(`\\*\\*${escapeRegex(label)}:\\*\\*\\s*(.+)$`, "mi");
  return content.match(pattern)?.[1]?.trim();
}

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

async function loadCheckpoint(directory: string, sessionID: string): Promise<CheckpointRecord | null> {
  try {
    const raw = await readFile(checkpointPath(directory, sessionID), "utf8");
    return JSON.parse(raw) as CheckpointRecord;
  } catch {
    return null;
  }
}

async function saveCheckpoint(directory: string, sessionID: string, patch: Partial<CheckpointRecord>) {
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

async function loadActiveSlice(directory: string, planPath?: string): Promise<ActiveSliceRecord | null> {
  const relativePath = activeSlicePathFromPlan(planPath);
  if (!relativePath) {
    return null;
  }

  try {
    const content = await readFile(path.join(directory, relativePath), "utf8");
    return {
      purpose: parseInlineField(content, "Purpose"),
      consumer: parseInlineField(content, "Consumer"),
      valueAtRisk: parseInlineField(content, "Value At Risk"),
      contractTest: parseInlineField(content, "Contract Test"),
      falsifier: parseInlineField(content, "Falsifier"),
      status: parseInlineField(content, "Status"),
    };
  } catch {
    return null;
  }
}

function computeMissingPurposeContract(activeSlice: ActiveSliceRecord | null) {
  if (!activeSlice) {
    return [];
  }

  const missingFields: string[] = [];
  if (!activeSlice.purpose?.trim()) {
    missingFields.push("purpose");
  }
  if (!activeSlice.consumer?.trim()) {
    missingFields.push("consumer");
  }
  if (!activeSlice.valueAtRisk?.trim()) {
    missingFields.push("value at risk");
  }
  if (!activeSlice.contractTest?.trim()) {
    missingFields.push("contract test");
  }
  if (!activeSlice.falsifier?.trim()) {
    missingFields.push("falsifier");
  }
  return missingFields;
}

function hasCompletedHelperActivity(
  health: Awaited<ReturnType<typeof loadSessionAgentHealth>>,
  agents: readonly string[],
) {
  return (health?.activities ?? []).some(
    (activity) => activity.status === "completed" && agents.includes(activity.agent as (typeof agents)[number]),
  );
}

function computeMissingPreEditHelperPasses(
  checkpoint: CheckpointRecord,
  activeSlice: ActiveSliceRecord | null,
  health: Awaited<ReturnType<typeof loadSessionAgentHealth>>,
) {
  if (!checkpoint.planPath && !activeSlice) {
    return [];
  }

  const missingHelperPasses: string[] = [];
  if (!hasCompletedHelperActivity(health, SUPPORTIVE_HELPER_AGENTS)) {
    missingHelperPasses.push("supportive helper pass");
  }
  if (!hasCompletedHelperActivity(health, ADVERSARIAL_HELPER_AGENTS)) {
    missingHelperPasses.push("adversarial helper pass");
  }
  return missingHelperPasses;
}

function mutatingCommand(args: Record<string, unknown>) {
  const commandCandidates = [args.command, args.cmd, args.input, args.script, args.raw];
  for (const candidate of commandCandidates) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      continue;
    }
    const command = candidate.trim();
    if (
      /(^|[;&|]\s*)(mkdir|touch|mv|cp|rm|chmod|chown|install|git|jj)\b/.test(command) ||
      /(>|>>|\btee\b|\bmake\s+(?!help\b|status\b)|\bgo(fmt|generate)\b)/.test(command)
    ) {
      return command;
    }
  }
  return null;
}

function isMutatingToolCall(input: ToolExecutionInput) {
  if (!input.tool) {
    return false;
  }
  if (EDIT_TOOL_NAMES.has(input.tool)) {
    return true;
  }
  if (input.tool === "bash") {
    return !!mutatingCommand(input.args ?? {});
  }
  return false;
}

function missingVerification(checkpoint: CheckpointRecord) {
  const verification = checkpoint.verification ?? [];
  const passed = new Set(
    verification.filter((item) => item.status === "passed").map((item) => item.category),
  );
  const required = new Set(["test", "lint", "build"]);
  const text = [checkpoint.currentSlice, checkpoint.nextStep].filter(Boolean).join("\n").toLowerCase();

  if (checkpoint.planPath?.includes("dr-agent") || /dr-agent|windows|dpapi|wmi|hyper-v/.test(text)) {
    required.add("windows");
  }

  if (/(handler|template|ui|dashboard|sse|browser|page|route|api|user-visible)/.test(text)) {
    required.add("runtime");
  }

  return Array.from(required).filter((category) => !passed.has(category));
}

const plugin: Plugin = async (ctx) => {
  return {
    "tool.execute.before": async (input: ToolExecutionInput) => {
      if (!input.sessionID || !isMutatingToolCall(input)) {
        return;
      }

      const checkpoint = await loadCheckpoint(ctx.directory, input.sessionID);
      if (!checkpoint?.autonomousIteration) {
        return;
      }

      const activeSlice = await loadActiveSlice(ctx.directory, checkpoint.planPath);
      const missingPurposeContract = computeMissingPurposeContract(activeSlice);
      const health = await loadSessionAgentHealth(ctx.directory, input.sessionID);
      const missingPreEditHelperPasses = computeMissingPreEditHelperPasses(checkpoint, activeSlice, health);

      if (!missingPurposeContract.length && !missingPreEditHelperPasses.length) {
        return;
      }

      const missingItems = [
        ...missingPurposeContract.map((item) => `missing ${item}`),
        ...missingPreEditHelperPasses,
      ];
      throw new Error(
        [
          "pre-edit autonomous gate blocked implementation.",
          `Complete the preconditions first: ${missingItems.join(", ")}.`,
          "For a non-trivial slice, run one supportive partner pass and one adversarial combatant pass before editing code.",
          "Then refresh active-slice.md so purpose, consumer, value at risk, contract test, and falsifier are explicit.",
        ].join(" "),
      );
    },
    "chat.message": async (_input, output) => {
      const messageText = output.parts
        .filter((part: any) => part.type === "text")
        .map((part: any) => String(part.text ?? ""))
        .join("\n")
        .toLowerCase();
      if (!messageText) {
        return;
      }
      if (
        messageText.includes("ulw") ||
        messageText.includes("ultrawork") ||
        messageText.includes("autopilot") ||
        messageText.includes("dr-autopilot") ||
        messageText.includes("autonomous iteration") ||
        messageText.includes("keep going until done")
      ) {
        await saveCheckpoint(ctx.directory, _input.sessionID, {
          autonomousIteration: true,
          status: "in_progress",
        });
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) {
        return;
      }
      const checkpoint = await loadCheckpoint(ctx.directory, input.sessionID);
      if (!checkpoint?.autonomousIteration) {
        return;
      }
      const missing = missingVerification(checkpoint);
      output.system.push(
        [
          "DR autonomous iteration mode is active.",
          "- Work in the repo's spec-first loop: clarify if needed, plan, taskify, write the failing test, implement, verify, and continue.",
          "- The repo purpose is already known from project context. Treat a missing plan as an internal planning gap, not a default reason to ask the user.",
          "- If no active plan exists, infer the most likely user goal from the repo purpose and request, use planning_analyst plus consumer_advocate internally, then create or refresh the plan artifacts before coding.",
          "- Hard pre-edit rule for non-trivial slices: partner plus combatant before implementation. Do not start code edits until one supportive helper pass and one adversarial helper pass are complete.",
          "- High confidence must come from evidence. If confidence is not yet high, inspect the repo, reload active artifacts, consult orthogonal specialists, and research unstable external facts plus adjacent problem-space context before changing course.",
          "- Iterative research and specialist passes are allowed while confidence is still rising between passes. Stop only when confidence plateaus and the issue remains unsolved.",
          "- If confidence keeps stalling, treat that as a sign that the slice is too broad or a foundation task is missing. Shrink the slice or create the missing foundation task before continuing.",
          "- If the current slice is complete, move to the next planned slice instead of stopping early.",
          checkpoint.currentSlice ? `- Current slice: ${checkpoint.currentSlice}` : null,
          checkpoint.nextStep ? `- Next step: ${checkpoint.nextStep}` : null,
          checkpoint.planPath ? `- Active plan: ${checkpoint.planPath}` : null,
          missing.length ? `- Missing verification categories: ${missing.join(", ")}` : null,
          "- Do not use multi-choice or paged user-question tools in this repo. The runtime cannot honestly enforce default ordering or auto-pick behavior.",
          "- If the remaining ambiguity is reversible, choose the safest evidence-backed default, record the assumption, and continue.",
          "- If the current path is still not solvable after the hard evidence, specialist, and research pass, park the blocked plan or slice explicitly and move to the next highest-value planned feature.",
          "- Ask one concise plain-text question only when the next decision is destructive, irreversible, or materially preference-shaped and still unsafe after the internal planning, user-advocate, specialist, and research pass.",
          "- If the reasoning is getting fuzzy, build a reflection packet and offload the reflection pass instead of starting a separate notes file.",
          "- Stop only when the work is actually done, the next required decision is missing, or you are truly blocked.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  };
};

export default plugin;
