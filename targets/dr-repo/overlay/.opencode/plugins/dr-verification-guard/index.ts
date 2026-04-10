import { tool, type Plugin } from "@opencode-ai/plugin";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_VERIFICATION_RECORDS = 200;

type VerificationRecord = {
  category: string;
  command: string;
  status: string;
  summary?: string;
  recordedAt: string;
};

type CheckpointRecord = {
  sessionID: string;
  verification?: VerificationRecord[];
  component?: string;
  updatedAt?: string;
};

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

async function saveCheckpoint(directory: string, sessionID: string, patch: Partial<CheckpointRecord>) {
  const existing = (await loadCheckpoint(directory, sessionID)) ?? { sessionID, verification: [] };
  const merged = {
    ...existing,
    ...patch,
    sessionID,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(checkpointPath(directory, sessionID)), { recursive: true });
  await writeFile(checkpointPath(directory, sessionID), JSON.stringify(merged, null, 2) + "\n", "utf8");
}

function mergeVerificationRecord(
  verification: VerificationRecord[],
  nextRecord: VerificationRecord,
) {
  const existingIndex = verification.findIndex(
    (item) =>
      item.category === nextRecord.category &&
      item.command === nextRecord.command &&
      item.status === nextRecord.status &&
      item.summary === nextRecord.summary,
  );

  if (existingIndex >= 0) {
    verification[existingIndex] = nextRecord;
  } else {
    verification.push(nextRecord);
  }

  if (verification.length > MAX_VERIFICATION_RECORDS) {
    verification.splice(0, verification.length - MAX_VERIFICATION_RECORDS);
  }
}

function detectCategories(command: string) {
  const categories = new Set<string>();

  if (/go test|pytest|cargo test|npm test|pnpm test|bun test/i.test(command)) {
    categories.add("test");
  }
  if (/golangci-lint|ruff|eslint|shellcheck/i.test(command)) {
    categories.add("lint");
  }
  if (/go build|cargo build|make build|npm run build|pnpm build|bun run build/i.test(command)) {
    categories.add("build");
  }
  if (/docker compose|docker-compose|curl|playwright|cypress|manual qa|runtime|smoke|http/i.test(command)) {
    categories.add("runtime");
  }
  if (/semgrep|trivy|snyk|zap|sqlmap|payload|injection|csrf/i.test(command)) {
    categories.add("security");
  }
  if (/goos=windows/i.test(command)) {
    categories.add("windows");
  }

  return Array.from(categories);
}

function extractCommand(input: ToolExecutionInput) {
  const args = input.args ?? {};
  const candidates = [
    args.command,
    args.cmd,
    args.input,
    args.script,
    args.text,
    args.raw,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  const toolName = typeof input.tool === "string" ? input.tool : "";
  if (toolName) {
    return toolName;
  }

  return "";
}

function detectStatus(metadata: Record<string, unknown> | undefined, output: string) {
  const exitCode = metadata?.exitCode ?? metadata?.statusCode ?? metadata?.code;
  if (typeof exitCode === "number") {
    return exitCode === 0 ? "passed" : "failed";
  }
  if (/FAIL|ERROR|panic:|traceback/i.test(output)) {
    return "failed";
  }
  return "passed";
}

const plugin: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        [
          "DR verification guard:",
          "- Behavior-changing work is incomplete without the relevant test contract and component verification.",
          "- Before calling work done, record or run the needed test, lint, build, runtime, and consumer-path checks for the touched component when they apply.",
          "- dr-agent work must respect the GOOS=windows rule.",
          "- A slice is not done just because one command is green.",
        ].join("\n"),
      );
    },
    "tool.execute.after": async (input: ToolExecutionInput, output: ToolExecutionOutput) => {
      const command = extractCommand(input);
      if (!command) {
        return;
      }
      const categories = detectCategories(command);
      if (!categories.length) {
        return;
      }
      const status = detectStatus(output.metadata, output.output ?? "");
      const existing = (await loadCheckpoint(ctx.directory, input.sessionID)) ?? {
        sessionID: input.sessionID,
        verification: [],
      };
      const verification = existing.verification ?? [];
      for (const category of categories) {
        mergeVerificationRecord(verification, {
          category,
          command,
          status,
          summary: output.title || undefined,
          recordedAt: new Date().toISOString(),
        });
      }
      await saveCheckpoint(ctx.directory, input.sessionID, { verification });
    },
    tool: {
      show_verification_status: tool({
        description:
          "Show the recorded DR verification evidence for the current session.",
        args: {},
        async execute(_args, context) {
          const checkpoint = await loadCheckpoint(context.directory, context.sessionID);
          if (!checkpoint?.verification?.length) {
            return "No verification evidence has been recorded for this session.";
          }
          return JSON.stringify(checkpoint.verification, null, 2);
        },
      }),
    },
  };
};

export default plugin;
