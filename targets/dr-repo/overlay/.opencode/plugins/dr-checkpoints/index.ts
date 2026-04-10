import { tool, type Plugin } from "@opencode-ai/plugin";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionAgentHealthRecord } from "../shared/session-agent-health.ts";
import { loadSessionAgentHealth } from "../shared/session-agent-health.ts";

type VerificationRecord = {
  category: string;
  command: string;
  status: string;
  summary?: string;
  recordedAt: string;
};

type CheckpointRecord = {
  sessionID: string;
  component?: string;
  planPath?: string;
  currentSlice?: string;
  status?: string;
  nextStep?: string;
  parkedReason?: string;
  blockedBy?: string;
  nextFeature?: string;
  risks?: string[];
  notes?: string;
  autonomousIteration?: boolean;
  verification?: VerificationRecord[];
  updatedAt: string;
};

type ChecklistState = {
  complete: string[];
  incomplete: string[];
};

type ActiveSliceRecord = {
  path: string;
  purpose?: string;
  consumer?: string;
  valueAtRisk?: string;
  component?: string;
  currentSlice?: string;
  status?: string;
  contractTest?: string;
  falsifier?: string;
  outOfScope?: string;
  requiredVerification: string[];
  nextStep?: string;
  parkedReason?: string;
  blockedBy?: string;
  nextFeature?: string;
  decisionComplete: ChecklistState;
  sliceDone: ChecklistState;
};

const DEFAULT_STALE_CHECKPOINT_LIMIT = 10;
const DEFAULT_STALE_CHECKPOINT_MINUTES = 30;
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
const POST_CHANGE_REVIEW_HELPER_AGENTS = [
  "verifier",
  "critical_reviewer",
  "security_reviewer",
] as const;

function emptyCheckpoint(sessionID: string): CheckpointRecord {
  return {
    sessionID,
    verification: [],
    updatedAt: new Date().toISOString(),
  };
}

function checkpointPath(directory: string, sessionID: string) {
  return path.join(directory, ".opencode", "state", "checkpoints", `${sessionID}.json`);
}

function continuityLedgerPath(directory: string, sessionID: string) {
  return path.join(directory, ".opencode", "state", "ledgers", `CONTINUITY_${sessionID}.md`);
}

function normalizeCategory(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseInlineField(content: string, label: string) {
  const pattern = new RegExp(`\\*\\*${escapeRegex(label)}:\\*\\*\\s*(.+)$`, "mi");
  return content.match(pattern)?.[1]?.trim();
}

function parseChecklistSection(content: string, heading: string): ChecklistState {
  const pattern = new RegExp(`## ${escapeRegex(heading)}\\n([\\s\\S]*?)(?:\\n## |$)`, "m");
  const block = content.match(pattern)?.[1] ?? "";
  const complete: string[] = [];
  const incomplete: string[] = [];

  for (const line of block.split("\n")) {
    const match = line.match(/^- \[([ xX])\] (.+)$/);
    if (!match) {
      continue;
    }
    const [, state, label] = match;
    if (state.toLowerCase() === "x") {
      complete.push(label.trim());
    } else {
      incomplete.push(label.trim());
    }
  }

  return { complete, incomplete };
}

function parseChecklistSectionWithFallback(content: string, headings: string[]): ChecklistState {
  for (const heading of headings) {
    const checklistState = parseChecklistSection(content, heading);
    if (checklistState.complete.length || checklistState.incomplete.length) {
      return checklistState;
    }
  }
  return { complete: [], incomplete: [] };
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

async function listCheckpoints(directory: string) {
  try {
    const checkpointDirectory = path.join(directory, ".opencode", "state", "checkpoints");
    const files = (await readdir(checkpointDirectory)).filter((file) => file.endsWith(".json"));
    const checkpoints = await Promise.all(
      files.map(async (file) => {
        try {
          const raw = await readFile(path.join(checkpointDirectory, file), "utf8");
          return JSON.parse(raw) as CheckpointRecord;
        } catch {
          return null;
        }
      }),
    );
    return checkpoints.filter((checkpoint): checkpoint is CheckpointRecord => !!checkpoint);
  } catch {
    return [];
  }
}

async function saveCheckpoint(directory: string, sessionID: string, data: CheckpointRecord) {
  const file = checkpointPath(directory, sessionID);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function loadActiveSlice(directory: string, planPath?: string): Promise<ActiveSliceRecord | null> {
  const relativePath = activeSlicePathFromPlan(planPath);
  if (!relativePath) {
    return null;
  }

  try {
    const fullPath = path.join(directory, relativePath);
    const content = await readFile(fullPath, "utf8");
    const requiredVerification = (parseInlineField(content, "Required Verification") ?? "")
      .split(",")
      .map(normalizeCategory)
      .filter(Boolean);

    return {
      path: relativePath,
      purpose: parseInlineField(content, "Purpose"),
      consumer: parseInlineField(content, "Consumer"),
      valueAtRisk: parseInlineField(content, "Value At Risk"),
      component: parseInlineField(content, "Component"),
      currentSlice: parseInlineField(content, "Current Slice"),
      status: parseInlineField(content, "Status"),
      contractTest: parseInlineField(content, "Contract Test"),
      falsifier: parseInlineField(content, "Falsifier"),
      outOfScope: parseInlineField(content, "Out Of Scope"),
      requiredVerification,
      nextStep: parseInlineField(content, "Next Step"),
      parkedReason: parseInlineField(content, "Parked Reason"),
      blockedBy: parseInlineField(content, "Blocked By"),
      nextFeature: parseInlineField(content, "Next Feature"),
      decisionComplete: parseChecklistSection(content, "Decision Complete"),
      sliceDone: parseChecklistSectionWithFallback(content, ["Green Punchlist", "Slice Done"]),
    };
  } catch {
    return null;
  }
}

function computeMissingPurposeContract(activeSlice: ActiveSliceRecord | null) {
  if (!activeSlice?.path) {
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

function currentSliceText(record: CheckpointRecord, activeSlice: ActiveSliceRecord | null) {
  return [
    record.currentSlice,
    activeSlice?.currentSlice,
    record.notes,
    activeSlice?.purpose,
    activeSlice?.consumer,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function inferRequiredVerification(record: CheckpointRecord, activeSlice: ActiveSliceRecord | null) {
  const fromArtifact = activeSlice?.requiredVerification ?? [];
  const required = new Set<string>(fromArtifact.length ? fromArtifact : ["test", "lint", "build"]);
  const component = record.component ?? activeSlice?.component;
  const text = currentSliceText(record, activeSlice);

  if (component === "dr-agent") {
    required.add("windows");
  }

  if (/(handler|template|ui|dashboard|sse|browser|page|route|api|login|customer|admin|operator|installer|user-visible)/.test(text)) {
    required.add("runtime");
  }

  if (/(auth|session|csrf|token|secret|command|sql|permission|injection|credential|encryption)/.test(text)) {
    required.add("security");
  }

  return Array.from(required);
}

function hasPassedCategory(verification: VerificationRecord[], category: string) {
  if (category === "windows") {
    return verification.some(
      (item) =>
        item.status === "passed" &&
        (item.category === "windows" || /goos=windows/i.test(item.command)),
    );
  }

  return verification.some((item) => item.status === "passed" && item.category === category);
}

function computeMissingVerification(record: CheckpointRecord, activeSlice: ActiveSliceRecord | null) {
  const required = inferRequiredVerification(record, activeSlice);
  const verification = record.verification ?? [];
  return required.filter((category) => !hasPassedCategory(verification, category));
}

function activeSliceNeedsHelperGate(record: CheckpointRecord, activeSlice: ActiveSliceRecord | null) {
  return Boolean(activeSlice?.path || record.planPath);
}

function hasCompletedHelperActivity(
  health: SessionAgentHealthRecord | null,
  agents: readonly string[],
) {
  if (!health?.activities?.length) {
    return false;
  }

  return health.activities.some((activity) => {
    return activity.status === "completed" && agents.includes(activity.agent as (typeof agents)[number]);
  });
}

function computeMissingHelperPasses(
  record: CheckpointRecord,
  activeSlice: ActiveSliceRecord | null,
  health: SessionAgentHealthRecord | null,
) {
  const missingPurposeContract = computeMissingPurposeContract(activeSlice);
  if (!activeSliceNeedsHelperGate(record, activeSlice)) {
    return [];
  }

  const missingHelperPasses: string[] = [];
  if (!hasCompletedHelperActivity(health, SUPPORTIVE_HELPER_AGENTS)) {
    missingHelperPasses.push("supportive helper pass");
  }
  if (!hasCompletedHelperActivity(health, ADVERSARIAL_HELPER_AGENTS)) {
    missingHelperPasses.push("adversarial helper pass");
  }
  if (!hasCompletedHelperActivity(health, POST_CHANGE_REVIEW_HELPER_AGENTS)) {
    missingHelperPasses.push("post-change review pass");
  }
  return missingHelperPasses;
}

function normalizeNextStep(nextStep?: string) {
  if (!nextStep) {
    return "";
  }
  const normalized = nextStep.trim();
  if (normalized.toLowerCase() === "none") {
    return "";
  }
  return normalized;
}

function checkpointAgeMinutes(record: CheckpointRecord, nowMilliseconds: number) {
  const updatedMilliseconds = Date.parse(record.updatedAt);
  if (Number.isNaN(updatedMilliseconds)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor((nowMilliseconds - updatedMilliseconds) / (60 * 1000));
}

export function evaluateSliceCompletion(
  record: CheckpointRecord,
  activeSlice: ActiveSliceRecord | null,
  health: SessionAgentHealthRecord | null = null,
) {
  const missingPurposeContract = computeMissingPurposeContract(activeSlice);
  const missingVerification = computeMissingVerification(record, activeSlice);
  const missingHelperPasses = computeMissingHelperPasses(record, activeSlice, health);
  const nextStep = normalizeNextStep(activeSlice?.nextStep ?? record.nextStep);
  const status = (activeSlice?.status ?? record.status ?? "unknown").toLowerCase();
  const parkedReason = activeSlice?.parkedReason ?? record.parkedReason ?? null;
  const blockedBy = activeSlice?.blockedBy ?? record.blockedBy ?? null;
  const nextFeature = activeSlice?.nextFeature ?? record.nextFeature ?? null;
  const incompleteDecisionChecks = activeSlice?.decisionComplete.incomplete ?? [];
  const incompleteSliceDoneChecks = activeSlice?.sliceDone.incomplete ?? [];
  const likelyComplete =
    status === "done" &&
    missingPurposeContract.length === 0 &&
    !nextStep &&
    missingVerification.length === 0 &&
    missingHelperPasses.length === 0 &&
    incompleteSliceDoneChecks.length === 0;

  let completionReason = "Slice status and evidence are incomplete.";
  if (likelyComplete) {
    completionReason =
      "Current slice is marked done, required verification is present, no slice-local next step remains, and the active-slice done checks are complete.";
  } else if (status === "parked") {
    completionReason = parkedReason
      ? `Slice is intentionally parked: ${parkedReason}`
      : "Slice is intentionally parked.";
  } else if (missingPurposeContract.length) {
    completionReason = `Missing purpose contract fields: ${missingPurposeContract.join(", ")}`;
  } else if (status !== "done") {
    completionReason = `Slice status is ${status}, so the slice is not done yet.`;
  } else if (missingVerification.length) {
    completionReason = `Missing required verification: ${missingVerification.join(", ")}`;
  } else if (missingHelperPasses.length) {
    completionReason = `Missing required helper passes: ${missingHelperPasses.join(", ")}`;
  } else if (nextStep) {
    completionReason = "A next step is still recorded for the current slice.";
  } else if (incompleteSliceDoneChecks.length) {
    completionReason = `Active-slice done checks remain open: ${incompleteSliceDoneChecks.join("; ")}`;
  }

  return {
    likelyComplete,
    missingPurposeContract,
    missingVerification,
    missingHelperPasses,
    activeSliceArtifact: activeSlice?.path ?? null,
    decisionCompleteChecksRemaining: incompleteDecisionChecks,
    sliceDoneChecksRemaining: incompleteSliceDoneChecks,
    hasNextStep: !!nextStep,
    isParked: status === "parked",
    parkedReason,
    blockedBy,
    nextFeature,
    completionReason,
  };
}

export function summarizeCheckpoint(
  record: CheckpointRecord,
  activeSlice: ActiveSliceRecord | null,
  health: SessionAgentHealthRecord | null = null,
) {
  const completion = evaluateSliceCompletion(record, activeSlice, health);
  return JSON.stringify(
    {
      sessionID: record.sessionID,
      status: activeSlice?.status ?? record.status ?? "unknown",
      component: activeSlice?.component ?? record.component ?? null,
      planPath: record.planPath ?? null,
      activeSliceArtifact: completion.activeSliceArtifact,
      currentSlice: activeSlice?.currentSlice ?? record.currentSlice ?? null,
      nextStep: normalizeNextStep(activeSlice?.nextStep ?? record.nextStep) || null,
      parkedReason: completion.parkedReason,
      blockedBy: completion.blockedBy,
      nextFeature: completion.nextFeature,
      purpose: activeSlice?.purpose ?? null,
      consumer: activeSlice?.consumer ?? null,
      valueAtRisk: activeSlice?.valueAtRisk ?? null,
      falsifier: activeSlice?.falsifier ?? null,
      risks: record.risks ?? [],
      autonomousIteration: !!record.autonomousIteration,
      verification: record.verification ?? [],
      missingPurposeContract: completion.missingPurposeContract,
      requiredVerification: inferRequiredVerification(record, activeSlice),
      missingVerification: completion.missingVerification,
      missingHelperPasses: completion.missingHelperPasses,
      decisionCompleteChecksRemaining: completion.decisionCompleteChecksRemaining,
      sliceDoneChecksRemaining: completion.sliceDoneChecksRemaining,
      likelyComplete: completion.likelyComplete,
      isParked: completion.isParked,
      completionReason: completion.completionReason,
      updatedAt: record.updatedAt,
    },
    null,
    2,
  );
}

async function writeContinuityLedger(directory: string, record: CheckpointRecord, activeSlice: ActiveSliceRecord | null) {
  const file = continuityLedgerPath(directory, record.sessionID);
  await mkdir(path.dirname(file), { recursive: true });
  const health = await loadSessionAgentHealth(directory, record.sessionID);
  const completion = evaluateSliceCompletion(record, activeSlice, health);

  const verificationLines = (record.verification ?? []).length
    ? (record.verification ?? [])
        .map((item) => `- ${item.category}: ${item.status} via \`${item.command}\`${item.summary ? ` (${item.summary})` : ""}`)
        .join("\n")
    : "- none recorded";

  const ledger = [
    `# Session: ${record.sessionID}`,
    `Updated: ${record.updatedAt}`,
    "",
    "## Goal",
    activeSlice?.purpose?.trim() || record.notes?.trim() || record.currentSlice?.trim() || "UNCONFIRMED",
    "",
    "## Constraints",
    `- Component: ${activeSlice?.component ?? record.component ?? "UNCONFIRMED"}`,
    record.planPath ? `- Active plan: \`${record.planPath}\`` : "- Active plan: UNCONFIRMED",
    activeSlice?.path ? `- Active slice: \`${activeSlice.path}\`` : "- Active slice: UNCONFIRMED",
    record.autonomousIteration ? "- Autonomous iteration is active" : "- Autonomous iteration is not active",
    "",
    "## Progress",
    "### In Progress",
    `- ${activeSlice?.currentSlice ?? record.currentSlice ?? "UNCONFIRMED"}`,
    "",
    "### Status",
    `- ${activeSlice?.status ?? record.status ?? "unknown"}`,
    "",
    "## Next Steps",
    normalizeNextStep(activeSlice?.nextStep ?? record.nextStep)
      ? `1. ${normalizeNextStep(activeSlice?.nextStep ?? record.nextStep)}`
      : "1. No next step recorded.",
    "",
    "## Parking",
    completion.isParked
      ? `- Parked Reason: ${completion.parkedReason ?? "UNCONFIRMED"}`
      : "- Parked Reason: NONE",
    completion.blockedBy ? `- Blocked By: ${completion.blockedBy}` : "- Blocked By: NONE",
    completion.nextFeature ? `- Next Feature: ${completion.nextFeature}` : "- Next Feature: NONE",
    "",
    "## Risks",
    ...(record.risks?.length ? record.risks.map((risk) => `- ${risk}`) : ["- none recorded"]),
    "",
    "## Verification",
    verificationLines,
    "",
    "## Missing Purpose Contract",
    ...(completion.missingPurposeContract.length
      ? completion.missingPurposeContract.map((item) => `- ${item}`)
      : ["- none"]),
    "",
    "## Missing Verification",
    ...(completion.missingVerification.length
      ? completion.missingVerification.map((item) => `- ${item}`)
      : ["- none"]),
    "",
    "## Missing Helper Passes",
    ...(completion.missingHelperPasses.length
      ? completion.missingHelperPasses.map((item) => `- ${item}`)
      : ["- none"]),
    "",
    "## Reflection",
    completion.completionReason,
  ].join("\n");

  await writeFile(file, ledger + "\n", "utf8");
  return file;
}

async function latestLedgers(directory: string, limit: number) {
  const ledgerDir = path.join(directory, ".opencode", "state", "ledgers");
  try {
    const files = (await readdir(ledgerDir)).filter((file) => file.endsWith(".md"));
    const withTimes = await Promise.all(
      files.map(async (file) => ({
        file,
        fullPath: path.join(ledgerDir, file),
        mtime: (await stat(path.join(ledgerDir, file))).mtimeMs,
      })),
    );
    return withTimes.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  } catch {
    return [];
  }
}

async function listStaleCheckpoints(directory: string, staleMinutes: number) {
  const nowMilliseconds = Date.now();
  const allCheckpoints = await listCheckpoints(directory);
  const staleThresholdMinutes = Math.max(staleMinutes, 1);
  const checkpointSummaries = await Promise.all(
    allCheckpoints.map(async (record) => {
      const activeSlice = await loadActiveSlice(directory, record.planPath);
      const health = await loadSessionAgentHealth(directory, record.sessionID);
      const completion = evaluateSliceCompletion(record, activeSlice, health);
      const ageMinutes = checkpointAgeMinutes(record, nowMilliseconds);

      return {
        sessionID: record.sessionID,
        status: activeSlice?.status ?? record.status ?? "unknown",
        planPath: record.planPath ?? null,
        activeSliceArtifact: activeSlice?.path ?? null,
        currentSlice: activeSlice?.currentSlice ?? record.currentSlice ?? null,
        nextStep: normalizeNextStep(activeSlice?.nextStep ?? record.nextStep) || null,
        parkedReason: completion.parkedReason,
        blockedBy: completion.blockedBy,
        nextFeature: completion.nextFeature,
        autonomousIteration: !!record.autonomousIteration,
        missingVerification: completion.missingVerification,
        missingHelperPasses: completion.missingHelperPasses,
        likelyComplete: completion.likelyComplete,
        isParked: completion.isParked,
        completionReason: completion.completionReason,
        minutesSinceUpdate: ageMinutes,
        updatedAt: record.updatedAt,
      };
    }),
  );

  return checkpointSummaries
    .filter((record) => !record.likelyComplete && !record.isParked)
    .filter((record) => record.minutesSinceUpdate >= staleThresholdMinutes)
    .sort((left, right) => right.minutesSinceUpdate - left.minutesSinceUpdate);
}

const plugin: Plugin = async () => {
  return {
    tool: {
      record_checkpoint: tool({
        description:
          "Record or refresh the current repo checkpoint for this session. Use this after planning, when entering a new slice, or when next-step state changes.",
        args: {
          component: tool.schema.string().optional().describe("Affected component such as portal, dr-agent, gateway, installer, or migrations."),
          plan_path: tool.schema.string().optional().describe("Repo-relative path to the active docs/plans/... file or other active plan artifact."),
          current_slice: tool.schema.string().optional().describe("Current story slice or execution slice."),
          status: tool.schema.enum(["planned", "in_progress", "blocked", "parked", "done"]).optional().describe("Current state of the active slice."),
          next_step: tool.schema.string().optional().describe("Immediate next action that should happen after this checkpoint."),
          parked_reason: tool.schema.string().optional().describe("Why the current slice or plan was intentionally parked."),
          blocked_by: tool.schema.string().optional().describe("Missing foundation, dependency, or external blocker that caused the parking decision."),
          next_feature: tool.schema.string().optional().describe("Next highest-value feature or slice that should run after parking this one."),
          risks: tool.schema.array(tool.schema.string()).optional().describe("Open risks or blockers worth carrying forward."),
          notes: tool.schema.string().optional().describe("Short free-form checkpoint notes."),
          autonomous_iteration: tool.schema.boolean().optional().describe("Whether the session is intentionally running in continue-until-done mode."),
        },
        async execute(args, context) {
          const existing =
            (await loadCheckpoint(context.directory, context.sessionID)) ??
            emptyCheckpoint(context.sessionID);
          const merged: CheckpointRecord = {
            ...existing,
            sessionID: context.sessionID,
            component: args.component ?? existing.component,
            planPath: args.plan_path ?? existing.planPath,
            currentSlice: args.current_slice ?? existing.currentSlice,
            status: args.status ?? existing.status ?? "planned",
            nextStep: args.next_step ?? existing.nextStep,
            parkedReason: args.parked_reason ?? existing.parkedReason,
            blockedBy: args.blocked_by ?? existing.blockedBy,
            nextFeature: args.next_feature ?? existing.nextFeature,
            risks: args.risks ?? existing.risks ?? [],
            notes: args.notes ?? existing.notes,
            autonomousIteration:
              args.autonomous_iteration ?? existing.autonomousIteration ?? false,
            verification: existing.verification ?? [],
            updatedAt: new Date().toISOString(),
          };
          await saveCheckpoint(context.directory, context.sessionID, merged);
          const activeSlice = await loadActiveSlice(context.directory, merged.planPath);
          const health = await loadSessionAgentHealth(context.directory, context.sessionID);
          return summarizeCheckpoint(merged, activeSlice, health);
        },
      }),
      record_verification_result: tool({
        description:
          "Record verification evidence for the current session. Use after tests, lint, build, runtime checks, security checks, or consumer-path checks.",
        args: {
          category: tool.schema
            .enum(["test", "lint", "build", "runtime", "security", "review", "consumer", "windows"])
            .describe("Verification category."),
          command: tool.schema.string().describe("Command or check that produced the evidence."),
          status: tool.schema.enum(["passed", "failed", "skipped"]).describe("Result status."),
          summary: tool.schema.string().optional().describe("Short summary of the outcome."),
        },
        async execute(args, context) {
          const existing =
            (await loadCheckpoint(context.directory, context.sessionID)) ??
            emptyCheckpoint(context.sessionID);
          const verification = existing.verification ?? [];
          verification.push({
            category: args.category,
            command: args.command,
            status: args.status,
            summary: args.summary,
            recordedAt: new Date().toISOString(),
          });
          const updated: CheckpointRecord = {
            ...existing,
            sessionID: context.sessionID,
            verification,
            updatedAt: new Date().toISOString(),
          };
          await saveCheckpoint(context.directory, context.sessionID, updated);
          const activeSlice = await loadActiveSlice(context.directory, updated.planPath);
          const health = await loadSessionAgentHealth(context.directory, context.sessionID);
          return summarizeCheckpoint(updated, activeSlice, health);
        },
      }),
      load_active_checkpoint_context: tool({
        description:
          "Load the current checkpoint context for this session, including active-slice context, verification evidence, and missing verification.",
        args: {},
        async execute(_args, context) {
          const existing = await loadCheckpoint(context.directory, context.sessionID);
          if (!existing) {
            return "No active checkpoint recorded for this session.";
          }
          const activeSlice = await loadActiveSlice(context.directory, existing.planPath);
          const health = await loadSessionAgentHealth(context.directory, context.sessionID);
          return summarizeCheckpoint(existing, activeSlice, health);
        },
      }),
      evaluate_slice_completion: tool({
        description:
          "Evaluate whether the current slice appears complete based on active-slice status, required verification, and remaining done checks.",
        args: {},
        async execute(_args, context) {
          const existing = await loadCheckpoint(context.directory, context.sessionID);
          if (!existing) {
            return "No active checkpoint recorded for this session.";
          }
          const activeSlice = await loadActiveSlice(context.directory, existing.planPath);
          const health = await loadSessionAgentHealth(context.directory, context.sessionID);
          return JSON.stringify(evaluateSliceCompletion(existing, activeSlice, health), null, 2);
        },
      }),
      build_reflection_packet: tool({
        description:
          "Build a compact evidence packet for a reflection pass by the main agent or a narrow specialist. Use this instead of maintaining a separate thoughts file.",
        args: {
          question: tool.schema.string().optional().describe("Optional specific question to focus the reflection pass."),
        },
        async execute(args, context) {
          const existing = await loadCheckpoint(context.directory, context.sessionID);
          if (!existing) {
            return "No active checkpoint recorded for this session.";
          }
          const activeSlice = await loadActiveSlice(context.directory, existing.planPath);
          const health = await loadSessionAgentHealth(context.directory, context.sessionID);
          const completion = evaluateSliceCompletion(existing, activeSlice, health);
          return JSON.stringify(
            {
              question:
                args.question ??
                "What matters most in the current slice, what is weakly supported, and what would falsify the current direction?",
              purpose: activeSlice?.purpose ?? null,
              consumer: activeSlice?.consumer ?? null,
              valueAtRisk: activeSlice?.valueAtRisk ?? null,
              component: activeSlice?.component ?? existing.component ?? null,
              currentSlice: activeSlice?.currentSlice ?? existing.currentSlice ?? null,
              status: activeSlice?.status ?? existing.status ?? null,
              contractTest: activeSlice?.contractTest ?? null,
              nextStep: normalizeNextStep(activeSlice?.nextStep ?? existing.nextStep) || null,
              risks: existing.risks ?? [],
              verification: existing.verification ?? [],
              requiredVerification: inferRequiredVerification(existing, activeSlice),
              missingVerification: completion.missingVerification,
              missingHelperPasses: completion.missingHelperPasses,
              decisionCompleteChecksRemaining: completion.decisionCompleteChecksRemaining,
              sliceDoneChecksRemaining: completion.sliceDoneChecksRemaining,
              activePlan: existing.planPath ?? null,
              activeSliceArtifact: activeSlice?.path ?? null,
              reflectionPrompt:
                "Review only the current purpose, contract, evidence, risks, and missing verification. Return Observed, Inferred, Proposed, Confidence, Falsifier, and Reflection. Do not broaden scope.",
            },
            null,
            2,
          );
        },
      }),
      write_continuity_ledger: tool({
        description:
          "Write or refresh a compact continuity ledger for the current session under .opencode/state/ledgers.",
        args: {},
        async execute(_args, context) {
          const existing = await loadCheckpoint(context.directory, context.sessionID);
          if (!existing) {
            return "No active checkpoint recorded for this session.";
          }
          const activeSlice = await loadActiveSlice(context.directory, existing.planPath);
          const ledgerPath = await writeContinuityLedger(context.directory, existing, activeSlice);
          return `Continuity ledger updated: ${path.relative(context.directory, ledgerPath)}`;
        },
      }),
      list_recent_continuity_ledgers: tool({
        description:
          "List recent continuity ledgers written under .opencode/state/ledgers.",
        args: {
          limit: tool.schema.number().optional().describe("Maximum number of ledgers to list."),
        },
        async execute(args, context) {
          const ledgers = await latestLedgers(context.directory, args.limit ?? 10);
          if (!ledgers.length) {
            return "No continuity ledgers found.";
          }
          return ledgers
            .map((item) => `- ${path.relative(context.directory, item.fullPath)} (${new Date(item.mtime).toISOString()})`)
            .join("\n");
        },
      }),
      list_stale_checkpoints: tool({
        description:
          "List incomplete checkpoints that have not been refreshed recently, including missing verification and next-step state.",
        args: {
          stale_minutes: tool.schema.number().optional().describe("Minimum age in minutes for a checkpoint to count as stale."),
          limit: tool.schema.number().optional().describe("Maximum number of stale checkpoints to return."),
        },
        async execute(args, context) {
          const staleCheckpoints = await listStaleCheckpoints(
            context.directory,
            args.stale_minutes ?? DEFAULT_STALE_CHECKPOINT_MINUTES,
          );
          return JSON.stringify(
            staleCheckpoints.slice(0, args.limit ?? DEFAULT_STALE_CHECKPOINT_LIMIT),
            null,
            2,
          );
        },
      }),
    },
  };
};

export default plugin;
