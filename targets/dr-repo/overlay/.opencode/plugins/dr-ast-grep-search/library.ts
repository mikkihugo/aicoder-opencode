import path from "node:path";

export const DEFAULT_AST_GREP_LIMIT = 10;
export const MAX_AST_GREP_LIMIT = 25;
export const DEFAULT_AST_GREP_TIMEOUT_MILLISECONDS = 20_000;
export const AST_GREP_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
export const MAX_AST_GREP_SNIPPET_CHARACTERS = 240;
export const DEFAULT_AST_GREP_STRICTNESS = "smart";
export const AST_GREP_RUNNER_FALLBACK = "npx --yes -p @ast-grep/cli sg";

export const AST_GREP_STRICTNESS_VALUES = [
  "cst",
  "smart",
  "ast",
  "relaxed",
  "signature",
  "template",
] as const;

export type AstGrepStrictness = (typeof AST_GREP_STRICTNESS_VALUES)[number];

export type AstGrepMatch = {
  file: string;
  language: string | null;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  snippet: string;
  captureNames: string[];
};

function normalizeSnippet(text: string | null | undefined) {
  if (!text) {
    return "";
  }
  const compactText = text.replace(/\s+/g, " ").trim();
  if (compactText.length <= MAX_AST_GREP_SNIPPET_CHARACTERS) {
    return compactText;
  }
  return `${compactText.slice(0, MAX_AST_GREP_SNIPPET_CHARACTERS - 1)}…`;
}

export function normalizeAstGrepLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) {
    return DEFAULT_AST_GREP_LIMIT;
  }
  const roundedLimit = Math.trunc(limit as number);
  if (roundedLimit < 1) {
    return 1;
  }
  if (roundedLimit > MAX_AST_GREP_LIMIT) {
    return MAX_AST_GREP_LIMIT;
  }
  return roundedLimit;
}

export function normalizeAstGrepPaths(directory: string, paths: string[] | undefined) {
  if (!paths?.length) {
    return ["."];
  }

  const normalizedPaths = paths
    .map((candidatePath) => candidatePath.trim())
    .filter(Boolean)
    .map((candidatePath) => {
      if (path.isAbsolute(candidatePath)) {
        throw new Error(`paths must be repo-relative: ${candidatePath}`);
      }
      const resolvedPath = path.resolve(directory, candidatePath);
      const relativePath = path.relative(directory, resolvedPath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error(`paths must stay inside the repo: ${candidatePath}`);
      }
      return relativePath || ".";
    });

  return Array.from(new Set(normalizedPaths));
}

export function normalizeAstGrepGlobs(globs: string[] | undefined) {
  if (!globs?.length) {
    return [];
  }

  return Array.from(
    new Set(
      globs
        .map((globPattern) => globPattern.trim())
        .filter(Boolean),
    ),
  );
}

export function normalizeAstGrepStrictness(strictness: string | undefined): AstGrepStrictness {
  if (!strictness) {
    return DEFAULT_AST_GREP_STRICTNESS;
  }
  if ((AST_GREP_STRICTNESS_VALUES as readonly string[]).includes(strictness)) {
    return strictness as AstGrepStrictness;
  }
  throw new Error(`strictness must be one of: ${AST_GREP_STRICTNESS_VALUES.join(", ")}`);
}

export function buildAstGrepArguments(options: {
  pattern: string;
  language?: string;
  selector?: string;
  strictness: AstGrepStrictness;
  paths: string[];
  globs: string[];
  limit: number;
}) {
  const argumentsList = [
    "run",
    "--pattern",
    options.pattern,
    "--json=compact",
    "--max-results",
    String(options.limit),
    "--strictness",
    options.strictness,
  ];

  if (options.language?.trim()) {
    argumentsList.push("--lang", options.language.trim());
  }
  if (options.selector?.trim()) {
    argumentsList.push("--selector", options.selector.trim());
  }
  for (const globPattern of options.globs) {
    argumentsList.push("--globs", globPattern);
  }

  argumentsList.push(...options.paths);
  return argumentsList;
}

export function extractAstGrepMatches(payload: unknown, limit: number): AstGrepMatch[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.slice(0, limit).flatMap((entry): AstGrepMatch[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const candidateMatch = entry as {
      file?: unknown;
      language?: unknown;
      lines?: unknown;
      range?: {
        start?: { line?: unknown; column?: unknown };
        end?: { line?: unknown; column?: unknown };
      };
      metaVariables?: {
        single?: Record<string, unknown>;
        multi?: Record<string, unknown>;
      };
    };

    if (typeof candidateMatch.file !== "string") {
      return [];
    }

    const startLine =
      typeof candidateMatch.range?.start?.line === "number" ? candidateMatch.range.start.line + 1 : 0;
    const startColumn =
      typeof candidateMatch.range?.start?.column === "number" ? candidateMatch.range.start.column + 1 : 0;
    const endLine = typeof candidateMatch.range?.end?.line === "number" ? candidateMatch.range.end.line + 1 : 0;
    const endColumn =
      typeof candidateMatch.range?.end?.column === "number" ? candidateMatch.range.end.column + 1 : 0;

    const singleCaptureNames = Object.keys(candidateMatch.metaVariables?.single ?? {});
    const multiCaptureNames = Object.keys(candidateMatch.metaVariables?.multi ?? {});

    return [
      {
        file: candidateMatch.file,
        language: typeof candidateMatch.language === "string" ? candidateMatch.language : null,
        startLine,
        startColumn,
        endLine,
        endColumn,
        snippet: normalizeSnippet(typeof candidateMatch.lines === "string" ? candidateMatch.lines : null),
        captureNames: [...singleCaptureNames, ...multiCaptureNames],
      },
    ];
  });
}
