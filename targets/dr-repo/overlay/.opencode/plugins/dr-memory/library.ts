import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import crypto from "node:crypto";

const execFile = promisify(execFileCallback);

export const MEMORY_DIRECTORY = path.join(".opencode", "state", "memory");
export const PENDING_OUTCOME_DIRECTORY = path.join(".opencode", "state", "pending-outcomes");
export const MAX_MEMORY_RESULTS = 12;
export const MAX_MEMORY_CONTENT_CHARS = 1600;
export const DEFAULT_REMEMBER_SYNC_MODE = "index";
export const DEFAULT_RECALL_SEARCH_MODE = "search";
export const DEFAULT_SYNC_MODE = "index";
export const MEMORY_TYPES = [
  "architectural-decision",
  "feature-outcome",
  "known-gap",
  "research-finding",
  "smoke-regression",
  "user-friction-finding",
  "runbook-learning",
  "failure-pattern",
  "user-workflow-lesson",
  "project-convention",
  "release-lesson",
  "repo-context",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export const OUTCOME_MEMORY_TYPES = [
  "feature-outcome",
  "smoke-regression",
  "user-friction-finding",
  "runbook-learning",
] as const;
export type OutcomeMemoryType = (typeof OUTCOME_MEMORY_TYPES)[number];
export type SyncMode = "index" | "embed";
export type SearchMode = "query" | "search" | "vsearch";

export const MEMORY_TYPE_DESCRIPTIONS_BY_NAME: Record<MemoryType, string> = {
  "architectural-decision":
    "Durable design and structure decisions that affect future implementation choices.",
  "feature-outcome":
    "User-visible outcome of a shipped or verified feature, including what changed, why it matters, and what remains open.",
  "known-gap":
    "Known missing capability, integration gap, or blocker that should not be rediscovered.",
  "research-finding":
    "Durable upstream finding, API behavior, or external reference conclusion worth recalling across sessions.",
  "smoke-regression":
    "Smoke-test failure or regression worth recalling across sessions because it changed release confidence or follow-up work.",
  "user-friction-finding":
    "Durable user, admin, operator, or installer friction that affects whether the workflow succeeds end to end.",
  "runbook-learning":
    "Recovery or operational lesson that improved the runbook and should be reused in future incidents.",
  "failure-pattern":
    "Repeated failure mode, debugging lesson, or anti-pattern found in this repo.",
  "user-workflow-lesson":
    "Customer, admin, operator, or installer workflow insight that affects usability or safety.",
  "project-convention":
    "Repo-specific coding, planning, verification, or runtime convention worth preserving.",
  "release-lesson":
    "Release, rollout, or production-readiness lesson that affects future delivery.",
  "repo-context":
    "Long-lived repo context that helps future sessions reason correctly.",
};

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i,
];

type FrontmatterData = {
  id: string;
  title: string;
  memory_type: MemoryType;
  tags: string[];
  created: string;
  modified: string;
};

type SearchResult = {
  path: string;
  score: number;
  snippet?: string;
};

type PendingOutcomeRecord = {
  title: string;
  content: string;
  memoryType: OutcomeMemoryType;
  tags?: string[];
};

export type MemoryRecord = {
  id: string;
  title: string;
  memoryType: MemoryType;
  tags: string[];
  created: string;
  modified: string;
  content: string;
  filePath: string;
};

export function memoryRoot(directory: string) {
  return path.join(directory, MEMORY_DIRECTORY);
}

export function pendingOutcomeRoot(directory: string) {
  return path.join(directory, PENDING_OUTCOME_DIRECTORY);
}

function memoryTypePath(directory: string, memoryType: MemoryType) {
  return path.join(memoryRoot(directory), memoryType);
}

function qmdIndexName(directory: string) {
  const baseName = path.basename(directory).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${baseName}-dr-memory`;
}

function slugifyTitle(title: string) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "memory"
  );
}

export function truncateContent(content: string, maxChars: number) {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}...[truncated]`;
}

export function parseMemoryType(value: string): MemoryType {
  if (MEMORY_TYPES.includes(value as MemoryType)) {
    return value as MemoryType;
  }
  throw new Error(
    `Unsupported memory type "${value}". Use one of: ${MEMORY_TYPES.join(", ")}`,
  );
}

export function parseOutcomeMemoryType(value: string): OutcomeMemoryType {
  if (OUTCOME_MEMORY_TYPES.includes(value as OutcomeMemoryType)) {
    return value as OutcomeMemoryType;
  }
  throw new Error(
    `Unsupported outcome memory type "${value}". Use one of: ${OUTCOME_MEMORY_TYPES.join(", ")}`,
  );
}

export function parseSyncMode(value: string): SyncMode {
  if (value === "index" || value === "embed") {
    return value;
  }
  throw new Error(`Unsupported sync mode "${value}". Use "index" or "embed".`);
}

export function parseSearchMode(value: string): SearchMode {
  if (value === "query" || value === "search" || value === "vsearch") {
    return value;
  }
  throw new Error(`Unsupported search mode "${value}". Use "query", "search", or "vsearch".`);
}

export function splitTags(tags?: string[]) {
  return (tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .filter((tag, index, allTags) => allTags.indexOf(tag) === index);
}

export function isSecretLikeMaterial(value: string) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

export function assertNoSecretLikeMaterial(...values: string[]) {
  for (const value of values) {
    if (isSecretLikeMaterial(value)) {
      throw new Error("Refusing to store secret-like material in dr-memory.");
    }
  }
}

export function formatOutcomeMemoryContent(input: {
  summary: string;
  userImpact?: string;
  environment?: string;
  verificationCommand?: string;
  evidence?: string[];
  followUp?: string;
}) {
  const trimmedEvidence = (input.evidence ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean);
  const sections = [
    ["Summary", input.summary.trim()],
    ["User Impact", input.userImpact?.trim()],
    ["Environment", input.environment?.trim()],
    ["Verification Command", input.verificationCommand?.trim()],
    ["Evidence", trimmedEvidence.length ? trimmedEvidence.map((entry) => `- ${entry}`).join("\n") : undefined],
    ["Follow-up", input.followUp?.trim()],
  ].filter((section): section is [string, string] => Boolean(section[1]));

  return sections.map(([heading, body]) => `## ${heading}\n${body}`).join("\n\n");
}

function parseSerializedArray(value: string | undefined) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseFrontmatter(content: string): { data: FrontmatterData; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("Invalid memory file format.");
  }

  const fieldMap: Record<string, string> = {};
  for (const rawField of match[1].split("\n")) {
    const parsedField = rawField.match(/^([a-z_]+):\s*(.+)$/);
    if (parsedField) {
      fieldMap[parsedField[1]] = parsedField[2];
    }
  }

  return {
    data: {
      id: fieldMap.id ?? "",
      title: fieldMap.title ?? "",
      memory_type: parseMemoryType(fieldMap.memory_type ?? ""),
      tags: parseSerializedArray(fieldMap.tags),
      created: fieldMap.created ?? "",
      modified: fieldMap.modified ?? "",
    },
    body: match[2].trim(),
  };
}

function serializeMemory(record: Omit<MemoryRecord, "filePath">) {
  return [
    "---",
    `id: ${record.id}`,
    `title: ${record.title}`,
    `memory_type: ${record.memoryType}`,
    `tags: ${JSON.stringify(record.tags)}`,
    `created: ${record.created}`,
    `modified: ${record.modified}`,
    "---",
    "",
    record.content.trim(),
    "",
  ].join("\n");
}

async function ensureMemoryDirectories(directory: string) {
  await mkdir(memoryRoot(directory), { recursive: true });
  await Promise.all(
    MEMORY_TYPES.map((memoryType) => mkdir(memoryTypePath(directory, memoryType), { recursive: true })),
  );
}

async function ensurePendingOutcomeDirectory(directory: string) {
  await mkdir(pendingOutcomeRoot(directory), { recursive: true });
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function nextAvailableMemoryPath(directory: string, title: string, memoryType: MemoryType) {
  const baseSlug = slugifyTitle(title);
  const basePath = path.join(memoryTypePath(directory, memoryType), `${baseSlug}.md`);
  if (!(await fileExists(basePath))) {
    return basePath;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidatePath = path.join(memoryTypePath(directory, memoryType), `${baseSlug}-${suffix}.md`);
    if (!(await fileExists(candidatePath))) {
      return candidatePath;
    }
  }
}

async function readMemoryFile(filePath: string): Promise<MemoryRecord> {
  const raw = await readFile(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  return {
    id: parsed.data.id,
    title: parsed.data.title,
    memoryType: parsed.data.memory_type,
    tags: parsed.data.tags,
    created: parsed.data.created,
    modified: parsed.data.modified,
    content: parsed.body,
    filePath,
  };
}

function qmdPathToFilePath(directory: string, qmdPath: string) {
  if (!qmdPath.startsWith("qmd://")) {
    return qmdPath;
  }

  const normalized = qmdPath.replace(/^qmd:\/\//, "");
  const [collectionName, ...rest] = normalized.split("/");
  if (!collectionName || !rest.length) {
    throw new Error(`Unsupported qmd path "${qmdPath}".`);
  }
  return path.join(memoryRoot(directory), collectionName, rest.join("/"));
}

async function resolveQmdCommand() {
  try {
    await execFile("qmd", ["--help"]);
    return { command: "qmd", baseArgs: [] as string[] };
  } catch {
    return { command: "npx", baseArgs: ["--yes", "@tobilu/qmd"] };
  }
}

async function runQmd(directory: string, args: string[]) {
  const qmdCommand = await resolveQmdCommand();
  return execFile(qmdCommand.command, [...qmdCommand.baseArgs, ...args], {
    cwd: directory,
    env: {
      ...process.env,
      BUN_INSTALL: "",
    },
  });
}

async function listCollections(directory: string) {
  try {
    const { stdout } = await runQmd(directory, ["collection", "list", "--index", qmdIndexName(directory)]);
    return stdout
      .split("\n")
      .map((line) => line.match(/^(\S+)\s+\(qmd:\/\//)?.[1])
      .filter((value): value is string => Boolean(value));
  } catch {
    return [];
  }
}

async function ensureQmdCollections(directory: string, memoryType?: MemoryType) {
  await ensureMemoryDirectories(directory);
  const existingCollections = new Set(await listCollections(directory));
  const targetTypes = memoryType ? [memoryType] : MEMORY_TYPES;

  for (const targetType of targetTypes) {
    if (existingCollections.has(targetType)) {
      continue;
    }
    await runQmd(directory, [
      "--index",
      qmdIndexName(directory),
      "collection",
      "add",
      memoryTypePath(directory, targetType),
      "--name",
      targetType,
      "--mask",
      "**/*.md",
    ]);
  }
}

export async function syncMemoryIndex(directory: string, syncMode: SyncMode, memoryType?: MemoryType) {
  await ensureQmdCollections(directory, memoryType);
  await runQmd(directory, ["--index", qmdIndexName(directory), "update"]);
  if (syncMode === "embed") {
    await runQmd(directory, ["--index", qmdIndexName(directory), "embed"]);
  }
}

export async function rememberMemory(
  directory: string,
  title: string,
  content: string,
  memoryType: MemoryType,
  tags: string[],
  syncMode: SyncMode,
) {
  await ensureMemoryDirectories(directory);
  const now = new Date().toISOString();
  const filePath = await nextAvailableMemoryPath(directory, title, memoryType);
  const record = {
    id: crypto.randomUUID(),
    title: title.trim(),
    memoryType,
    tags,
    created: now,
    modified: now,
    content: content.trim(),
  };
  await writeFile(filePath, serializeMemory(record), "utf8");
  await syncMemoryIndex(directory, syncMode, memoryType);
  return filePath;
}

function normalizePendingOutcomeRecord(value: unknown): PendingOutcomeRecord {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid pending outcome payload.");
  }

  const rawRecord = value as Record<string, unknown>;
  const title = String(rawRecord.title ?? "").trim();
  const content = String(rawRecord.content ?? "").trim();
  const memoryType = parseOutcomeMemoryType(String(rawRecord.memoryType ?? "").trim());
  const tags = Array.isArray(rawRecord.tags)
    ? rawRecord.tags.filter((tag): tag is string => typeof tag === "string")
    : [];

  if (!title || !content) {
    throw new Error("Pending outcome must include non-empty title and content.");
  }

  assertNoSecretLikeMaterial(title, content, ...tags);

  return {
    title,
    content,
    memoryType,
    tags: splitTags(tags),
  };
}

export async function ingestPendingOutcomes(directory: string, limit = MAX_MEMORY_RESULTS) {
  await ensurePendingOutcomeDirectory(directory);
  const entries = (await readdir(pendingOutcomeRoot(directory)))
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, limit);

  const ingested: Array<{ pendingFilePath: string; memoryFilePath: string; memoryType: OutcomeMemoryType }> = [];

  for (const entry of entries) {
    const pendingFilePath = path.join(pendingOutcomeRoot(directory), entry);
    const raw = await readFile(pendingFilePath, "utf8");
    const parsed = normalizePendingOutcomeRecord(JSON.parse(raw) as unknown);
    const memoryFilePath = await rememberMemory(
      directory,
      parsed.title,
      parsed.content,
      parsed.memoryType,
      parsed.tags ?? [],
      DEFAULT_REMEMBER_SYNC_MODE,
    );
    await rm(pendingFilePath);
    ingested.push({
      pendingFilePath,
      memoryFilePath,
      memoryType: parsed.memoryType,
    });
  }

  return ingested;
}

async function listLatestMemories(directory: string, memoryType: MemoryType | undefined, limit: number) {
  const typeDirectories = memoryType
    ? [memoryTypePath(directory, memoryType)]
    : MEMORY_TYPES.map((type) => memoryTypePath(directory, type));
  const memoryFiles: string[] = [];

  for (const typeDirectory of typeDirectories) {
    try {
      const entries = await readdir(typeDirectory);
      for (const entry of entries) {
        if (entry.endsWith(".md")) {
          memoryFiles.push(path.join(typeDirectory, entry));
        }
      }
    } catch {
      continue;
    }
  }

  const filesWithStats = await Promise.all(
    memoryFiles.map(async (filePath) => ({
      filePath,
      stats: await stat(filePath),
    })),
  );
  filesWithStats.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);

  const memories: Array<MemoryRecord & { score: number }> = [];
  for (const file of filesWithStats.slice(0, limit)) {
    memories.push({
      ...(await readMemoryFile(file.filePath)),
      score: 0,
    });
  }
  return memories;
}

export async function recallMemory(
  directory: string,
  query: string | undefined,
  memoryType: MemoryType | undefined,
  limit: number,
  searchMode: SearchMode,
) {
  await ensureMemoryDirectories(directory);
  if (!query?.trim()) {
    return listLatestMemories(directory, memoryType, limit);
  }

  await ensureQmdCollections(directory, memoryType);
  const qmdArgs = [
    searchMode,
    query,
    "--index",
    qmdIndexName(directory),
    "--json",
    "-n",
    String(limit),
  ];
  if (memoryType) {
    qmdArgs.push("-c", memoryType);
  }

  const { stdout } = await runQmd(directory, qmdArgs);
  const parsedResults = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const normalizedResults: SearchResult[] = parsedResults.map((result) => ({
    path: String(result.file ?? result.path ?? ""),
    score: typeof result.score === "number" ? result.score : 0,
    snippet: typeof result.snippet === "string" ? result.snippet : undefined,
  }));

  const memories: Array<MemoryRecord & { score: number; snippet?: string }> = [];
  for (const result of normalizedResults) {
    if (!result.path) {
      continue;
    }
    const filePath = qmdPathToFilePath(directory, result.path);
    if (!(await fileExists(filePath))) {
      continue;
    }
    memories.push({
      ...(await readMemoryFile(filePath)),
      score: result.score,
      snippet: result.snippet,
    });
  }

  return memories;
}

export async function forgetMemory(directory: string, filePath: string) {
  const resolvedRoot = path.resolve(memoryRoot(directory));
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Refusing to delete files outside dr-memory.");
  }
  await rm(resolvedFile);
  await runQmd(directory, ["--index", qmdIndexName(directory), "update"]);
}
