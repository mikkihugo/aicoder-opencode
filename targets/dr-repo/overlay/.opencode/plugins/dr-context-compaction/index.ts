import type { Plugin } from "@opencode-ai/plugin";
import { readFile } from "node:fs/promises";
import path from "node:path";

type VerificationRecord = {
  category: string;
  command: string;
  status: string;
};

type CheckpointRecord = {
  planPath?: string;
  currentSlice?: string;
  nextStep?: string;
  parkedReason?: string;
  blockedBy?: string;
  nextFeature?: string;
  status?: string;
  risks?: string[];
  verification?: VerificationRecord[];
};

type ActiveSliceSummary = {
  purpose?: string;
  consumer?: string;
  valueAtRisk?: string;
  component?: string;
  currentSlice?: string;
  status?: string;
  contractTest?: string;
  requiredVerification?: string;
  nextStep?: string;
  parkedReason?: string;
  blockedBy?: string;
  nextFeature?: string;
};

function checkpointPath(directory: string, sessionID: string) {
  return path.join(directory, ".opencode", "state", "checkpoints", `${sessionID}.json`);
}

async function loadCheckpoint(directory: string, sessionID: string): Promise<CheckpointRecord | null> {
  try {
    const raw = await readFile(checkpointPath(directory, sessionID), "utf8");
    return JSON.parse(raw) as CheckpointRecord;
  } catch {
    return null;
  }
}

async function readBoundedFile(directory: string, filePath: string, maxChars: number) {
  const raw = await readFile(path.join(directory, filePath), "utf8");
  return raw.length <= maxChars ? raw : raw.slice(0, maxChars) + "\n...[truncated]";
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseInlineField(content: string, label: string) {
  const pattern = new RegExp(`\\*\\*${escapeRegex(label)}:\\*\\*\\s*(.+)$`, "mi");
  return content.match(pattern)?.[1]?.trim();
}

function summarizeActiveSlice(content: string): ActiveSliceSummary {
  return {
    purpose: parseInlineField(content, "Purpose"),
    consumer: parseInlineField(content, "Consumer"),
    valueAtRisk: parseInlineField(content, "Value At Risk"),
    component: parseInlineField(content, "Component"),
    currentSlice: parseInlineField(content, "Current Slice"),
    status: parseInlineField(content, "Status"),
    contractTest: parseInlineField(content, "Contract Test"),
    requiredVerification: parseInlineField(content, "Required Verification"),
    nextStep: parseInlineField(content, "Next Step"),
    parkedReason: parseInlineField(content, "Parked Reason"),
    blockedBy: parseInlineField(content, "Blocked By"),
    nextFeature: parseInlineField(content, "Next Feature"),
  };
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

const plugin: Plugin = async (ctx) => {
  return {
    "experimental.session.compacting": async (input, output) => {
      const checkpoint = await loadCheckpoint(ctx.directory, input.sessionID);
      if (!checkpoint) {
        return;
      }

      output.context.push(
        [
          "DR session checkpoint:",
          `- Status: ${checkpoint.status ?? "unknown"}`,
          checkpoint.currentSlice ? `- Current slice: ${checkpoint.currentSlice}` : null,
          checkpoint.nextStep ? `- Next step: ${checkpoint.nextStep}` : null,
          checkpoint.parkedReason ? `- Parked reason: ${checkpoint.parkedReason}` : null,
          checkpoint.blockedBy ? `- Blocked by: ${checkpoint.blockedBy}` : null,
          checkpoint.nextFeature ? `- Next feature: ${checkpoint.nextFeature}` : null,
          checkpoint.risks?.length ? `- Open risks: ${checkpoint.risks.join("; ")}` : null,
          checkpoint.verification?.length
            ? `- Verification: ${checkpoint.verification
                .map((item) => `${item.category}:${item.status}`)
                .join(", ")}`
            : "- Verification: none recorded",
        ]
          .filter(Boolean)
          .join("\n"),
      );

      if (checkpoint.planPath) {
        const planSummary = await readBoundedFile(ctx.directory, checkpoint.planPath, 2500);
        output.context.push(
          `Active DR plan excerpt from ${checkpoint.planPath}:\n${planSummary}`,
        );
      }

      const activeSlicePath = activeSlicePathFromPlan(checkpoint.planPath);
      if (activeSlicePath) {
        try {
          const activeSliceContent = await readFile(
            path.join(ctx.directory, activeSlicePath),
            "utf8",
          );
          const summary = summarizeActiveSlice(activeSliceContent);
          output.context.push(
            [
              `Structured active slice summary from ${activeSlicePath}:`,
              summary.purpose ? `- Purpose: ${summary.purpose}` : null,
              summary.consumer ? `- Consumer: ${summary.consumer}` : null,
              summary.valueAtRisk ? `- Value At Risk: ${summary.valueAtRisk}` : null,
              summary.component ? `- Component: ${summary.component}` : null,
              summary.currentSlice ? `- Current Slice: ${summary.currentSlice}` : null,
              summary.status ? `- Status: ${summary.status}` : null,
              summary.contractTest ? `- Contract Test: ${summary.contractTest}` : null,
              summary.requiredVerification
                ? `- Required Verification: ${summary.requiredVerification}`
                : null,
              summary.nextStep ? `- Next Step: ${summary.nextStep}` : null,
              summary.parkedReason ? `- Parked Reason: ${summary.parkedReason}` : null,
              summary.blockedBy ? `- Blocked By: ${summary.blockedBy}` : null,
              summary.nextFeature ? `- Next Feature: ${summary.nextFeature}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        } catch {
          // Ignore missing or unreadable active-slice artifacts during compaction.
        }
      }

      output.context.push(
        [
          "DR compaction rule:",
          "- Preserve purpose, component, active plan path, current slice, next step, verification evidence, and unresolved risks.",
          "- For dr-agent work, preserve the Windows-only build rule and do not collapse it away.",
          "- For behavior changes, keep the failing-test-first and verification requirements explicit.",
        ].join("\n"),
      );
    },
  };
};

export default plugin;
