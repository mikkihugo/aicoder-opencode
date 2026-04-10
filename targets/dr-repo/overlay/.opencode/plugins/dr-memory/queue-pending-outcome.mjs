import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import {
  assertNoSecretLikeMaterial,
  formatOutcomeMemoryContent,
  parseOutcomeMemoryType,
  pendingOutcomeRoot,
  splitTags,
} from "./library.ts";

const DEFAULT_DIRECTORY = process.cwd();
const DEFAULT_ENVIRONMENT = "unknown";

function parseArguments(argv) {
  const parsed = {
    command: "",
    directory: DEFAULT_DIRECTORY,
    summaryFile: "",
    memoryType: "smoke-regression",
    environment: DEFAULT_ENVIRONMENT,
    verificationCommand: "",
    title: "",
    summary: "",
    userImpact: "",
    tagValues: [],
    followUp: "",
    evidence: [],
    dedupeKey: "",
  };

  const [command = "", ...rest] = argv;
  parsed.command = command;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const next = rest[index + 1];

    switch (argument) {
      case "--directory":
        parsed.directory = next;
        index += 1;
        break;
      case "--summary-file":
        parsed.summaryFile = next;
        index += 1;
        break;
      case "--memory-type":
        parsed.memoryType = next;
        index += 1;
        break;
      case "--environment":
        parsed.environment = next;
        index += 1;
        break;
      case "--verification-command":
        parsed.verificationCommand = next;
        index += 1;
        break;
      case "--title":
        parsed.title = next;
        index += 1;
        break;
      case "--summary":
        parsed.summary = next;
        index += 1;
        break;
      case "--user-impact":
        parsed.userImpact = next;
        index += 1;
        break;
      case "--tag":
        parsed.tagValues.push(next);
        index += 1;
        break;
      case "--evidence":
        parsed.evidence.push(next);
        index += 1;
        break;
      case "--follow-up":
        parsed.followUp = next;
        index += 1;
        break;
      case "--dedupe-key":
        parsed.dedupeKey = next;
        index += 1;
        break;
      default:
        throw new Error(`Unsupported argument "${argument}".`);
    }
  }

  return parsed;
}

function buildUsage() {
  return [
    "Usage:",
    "  queue-pending-outcome.mjs smoke-summary --summary-file <path> [--directory <repo-root>] [--environment <name>] [--verification-command <cmd>] [--memory-type <type>] [--tag <tag>] [--follow-up <text>] [--dedupe-key <key>]",
    "  queue-pending-outcome.mjs outcome-block --title <title> --summary <text> [--directory <repo-root>] [--memory-type <type>] [--environment <name>] [--verification-command <cmd>] [--user-impact <text>] [--evidence <text>] [--tag <tag>] [--follow-up <text>] [--dedupe-key <key>]",
  ].join("\n");
}

function slugify(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "pending-outcome"
  );
}

function normalizeSummaryPayload(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Smoke summary payload must be an object.");
  }

  const raw = value;
  const failedTests = Array.isArray(raw.failedTests)
    ? raw.failedTests.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  const passedTests = Array.isArray(raw.passedTests)
    ? raw.passedTests.filter((entry) => typeof entry === "string" && entry.trim())
    : [];

  return {
    portalUrl: typeof raw.portalUrl === "string" ? raw.portalUrl.trim() : "",
    gatewayUrl: typeof raw.gatewayUrl === "string" ? raw.gatewayUrl.trim() : "",
    success: raw.success === true,
    testsFailed: typeof raw.testsFailed === "number" ? raw.testsFailed : Number(raw.testsFailed ?? "0"),
    testsPassed: typeof raw.testsPassed === "number" ? raw.testsPassed : Number(raw.testsPassed ?? "0"),
    testsRun: typeof raw.testsRun === "number" ? raw.testsRun : Number(raw.testsRun ?? "0"),
    failedTests,
    passedTests,
    quickMode: raw.quickMode === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt.trim() : "",
  };
}

function buildSmokeRegressionRecord(parsedArguments, summary) {
  if (summary.success || summary.testsFailed <= 0 || summary.failedTests.length === 0) {
    return null;
  }

  const memoryType = parseOutcomeMemoryType(parsedArguments.memoryType);
  const environment = parsedArguments.environment || DEFAULT_ENVIRONMENT;
  const failedTests = [...summary.failedTests].sort();
  const title =
    parsedArguments.title ||
    `${environment} smoke regression: ${failedTests.join(", ")}`;
  const content = formatOutcomeMemoryContent({
    summary: `Smoke validation failed in ${environment} for ${failedTests.join(", ")}.`,
    userImpact:
      "Release confidence dropped because user-facing or operator-facing validation no longer proves the workflow.",
    environment,
    verificationCommand: parsedArguments.verificationCommand || undefined,
    evidence: [
      `Portal URL: ${summary.portalUrl || "unknown"}`,
      `Gateway URL: ${summary.gatewayUrl || "unknown"}`,
      `Failed checks: ${failedTests.join(", ")}`,
      `Passed checks before failure summary: ${summary.testsPassed}/${summary.testsRun}`,
      summary.quickMode ? "Quick smoke mode was enabled." : "Full smoke mode was enabled.",
      summary.createdAt ? `Observed at: ${summary.createdAt}` : "",
    ].filter(Boolean),
    followUp:
      parsedArguments.followUp ||
      "Inspect the failing endpoint or dependency and rerun the same smoke gate after the fix.",
  });
  const tags = splitTags([
    "smoke-regression",
    environment,
    ...failedTests.map((testName) => slugify(testName)),
    ...parsedArguments.tagValues,
  ]);
  const dedupeKey =
    parsedArguments.dedupeKey ||
    `${environment}:${failedTests.map((testName) => slugify(testName)).join("+")}`;

  assertNoSecretLikeMaterial(title, content, ...tags);
  return { title, content, memoryType, tags, dedupeKey };
}

async function readSummaryFile(summaryFile) {
  const raw = await readFile(summaryFile, "utf8");
  return normalizeSummaryPayload(JSON.parse(raw));
}

function buildOutcomeBlockRecord(parsedArguments) {
  const memoryType = parseOutcomeMemoryType(parsedArguments.memoryType);
  const title = parsedArguments.title.trim();
  const summary = parsedArguments.summary.trim();

  if (!title || !summary) {
    throw new Error("Outcome block requires non-empty --title and --summary.");
  }

  const content = formatOutcomeMemoryContent({
    summary,
    userImpact: parsedArguments.userImpact || undefined,
    environment: parsedArguments.environment || undefined,
    verificationCommand: parsedArguments.verificationCommand || undefined,
    evidence: parsedArguments.evidence,
    followUp: parsedArguments.followUp || undefined,
  });
  const tags = splitTags(parsedArguments.tagValues);
  const dedupeKey = parsedArguments.dedupeKey || `${memoryType}:${slugify(title)}`;

  assertNoSecretLikeMaterial(title, content, ...tags);
  return { title, content, memoryType, tags, dedupeKey };
}

async function queuePendingOutcome(directory, record) {
  const pendingDirectory = pendingOutcomeRoot(directory);
  await mkdir(pendingDirectory, { recursive: true });

  if (record.dedupeKey) {
    const existingEntries = await readdir(pendingDirectory);
    for (const entry of existingEntries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(pendingDirectory, entry);
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      if (parsed.dedupeKey === record.dedupeKey) {
        await writeFile(
          filePath,
          `${JSON.stringify(
            {
              title: record.title,
              content: record.content,
              memoryType: record.memoryType,
              tags: record.tags,
              dedupeKey: record.dedupeKey,
              updatedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        return { action: "updated", pendingFilePath: filePath };
      }
    }
  }

  const fileName = `${Date.now()}-${crypto.randomUUID()}.json`;
  const filePath = path.join(pendingDirectory, fileName);
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        title: record.title,
        content: record.content,
        memoryType: record.memoryType,
        tags: record.tags,
        dedupeKey: record.dedupeKey,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { action: "created", pendingFilePath: filePath };
}

async function main() {
  const parsedArguments = parseArguments(process.argv.slice(2));
  if (!parsedArguments.command) {
    throw new Error(buildUsage());
  }

  if (parsedArguments.command === "smoke-summary") {
    if (!parsedArguments.summaryFile) {
      throw new Error("Missing required --summary-file argument.");
    }

    const summary = await readSummaryFile(parsedArguments.summaryFile);
    const record = buildSmokeRegressionRecord(parsedArguments, summary);

    if (!record) {
      process.stdout.write(
        `${JSON.stringify({ success: true, action: "noop", reason: "summary did not describe a failed smoke regression" }, null, 2)}\n`,
      );
      return;
    }

    const result = await queuePendingOutcome(parsedArguments.directory, record);
    process.stdout.write(`${JSON.stringify({ success: true, ...result }, null, 2)}\n`);
    return;
  }

  if (parsedArguments.command === "outcome-block") {
    const record = buildOutcomeBlockRecord(parsedArguments);
    const result = await queuePendingOutcome(parsedArguments.directory, record);
    process.stdout.write(`${JSON.stringify({ success: true, ...result }, null, 2)}\n`);
    return;
  }

  throw new Error(buildUsage());
}

await main();
