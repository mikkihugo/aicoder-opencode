import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { tool, type Plugin } from "@opencode-ai/plugin";

import {
  AST_GREP_MAX_BUFFER_BYTES,
  AST_GREP_RUNNER_FALLBACK,
  DEFAULT_AST_GREP_LIMIT,
  DEFAULT_AST_GREP_TIMEOUT_MILLISECONDS,
  buildAstGrepArguments,
  extractAstGrepMatches,
  normalizeAstGrepGlobs,
  normalizeAstGrepLimit,
  normalizeAstGrepPaths,
  normalizeAstGrepStrictness,
} from "./library.ts";

const execFileAsync = promisify(execFile);

type AstGrepSearchResponse = {
  provider: "ast-grep";
  runner: string;
  pattern: string;
  language: string | null;
  selector: string | null;
  strictness: string;
  paths: string[];
  globs: string[];
  limit: number;
  success: boolean;
  reason: string | null;
  guidance: string;
  matches: unknown[];
};

function searchGuidance(runner: string) {
  if (runner === AST_GREP_RUNNER_FALLBACK) {
    return "Use ast_grep_search when structure matters more than raw text. This environment is using the npx fallback, so the first run can be slower than rg.";
  }
  return "Use ast_grep_search when structure matters more than raw text. Prefer rg for plain lexical search.";
}

function errorReason(error: unknown) {
  if (!error || typeof error !== "object") {
    return "Unknown ast-grep failure.";
  }

  const execError = error as {
    code?: string | number;
    stdout?: string;
    stderr?: string;
    message?: string;
    killed?: boolean;
    signal?: string;
  };

  if (execError.killed || execError.signal === "SIGTERM") {
    return "ast-grep search timed out";
  }

  const stderrText = typeof execError.stderr === "string" ? execError.stderr.trim() : "";
  const stdoutText = typeof execError.stdout === "string" ? execError.stdout.trim() : "";
  if (stderrText) {
    return stderrText;
  }
  if (stdoutText) {
    return stdoutText;
  }
  if (typeof execError.message === "string" && execError.message.trim()) {
    return execError.message.trim();
  }
  if (typeof execError.code === "string" || typeof execError.code === "number") {
    return `ast-grep failed with code ${String(execError.code)}`;
  }
  return "Unknown ast-grep failure.";
}

function missingBinary(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT");
}

async function executeAstGrep(directory: string, argumentsList: string[]) {
  try {
    const result = await execFileAsync("ast-grep", argumentsList, {
      cwd: directory,
      timeout: DEFAULT_AST_GREP_TIMEOUT_MILLISECONDS,
      maxBuffer: AST_GREP_MAX_BUFFER_BYTES,
    });
    return { runner: "ast-grep", stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!missingBinary(error)) {
      throw error;
    }

    const fallbackArguments = ["--yes", "-p", "@ast-grep/cli", "sg", ...argumentsList];
    const result = await execFileAsync("npx", fallbackArguments, {
      cwd: directory,
      timeout: DEFAULT_AST_GREP_TIMEOUT_MILLISECONDS,
      maxBuffer: AST_GREP_MAX_BUFFER_BYTES,
    });
    return { runner: AST_GREP_RUNNER_FALLBACK, stdout: result.stdout, stderr: result.stderr };
  }
}

async function searchWithAstGrep(
  directory: string,
  args: {
    pattern: string;
    language?: string;
    selector?: string;
    strictness?: string;
    paths?: string[];
    globs?: string[];
    limit?: number;
  },
): Promise<AstGrepSearchResponse> {
  const pattern = args.pattern.trim();
  if (!pattern) {
    throw new Error("pattern must not be empty");
  }

  const limit = normalizeAstGrepLimit(args.limit);
  const paths = normalizeAstGrepPaths(directory, args.paths);
  const globs = normalizeAstGrepGlobs(args.globs);
  const strictness = normalizeAstGrepStrictness(args.strictness);
  const argumentsList = buildAstGrepArguments({
    pattern,
    language: args.language,
    selector: args.selector,
    strictness,
    paths,
    globs,
    limit,
  });

  try {
    const executionResult = await executeAstGrep(directory, argumentsList);
    const payload = JSON.parse(executionResult.stdout || "[]");
    const matches = extractAstGrepMatches(payload, limit);

    return {
      provider: "ast-grep",
      runner: executionResult.runner,
      pattern,
      language: args.language?.trim() || null,
      selector: args.selector?.trim() || null,
      strictness,
      paths,
      globs,
      limit,
      success: true,
      reason: null,
      guidance: searchGuidance(executionResult.runner),
      matches,
    };
  } catch (error) {
    return {
      provider: "ast-grep",
      runner: "unknown",
      pattern,
      language: args.language?.trim() || null,
      selector: args.selector?.trim() || null,
      strictness,
      paths,
      globs,
      limit,
      success: false,
      reason: errorReason(error),
      guidance:
        "Use rg when the query is purely lexical. Use ast_grep_search when structure matters, and keep the pattern narrow enough to avoid result floods.",
      matches: [],
    };
  }
}

const plugin: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        [
          "Local structural search rule:",
          "- Use ast_grep_search when code structure matters more than exact text, especially for finding handlers, methods, hooks, or call shapes.",
          "- Prefer rg for plain text search and ast_grep_search for syntax-aware search.",
          "- Keep ast-grep patterns narrow and path-scoped to avoid flooding the session.",
        ].join("\n"),
      );
    },
    tool: {
      ast_grep_search: tool({
        description:
          "Run a syntax-aware local code search with ast-grep. Uses a real ast-grep binary when available, otherwise falls back to npx @ast-grep/cli.",
        args: {
          pattern: tool.schema.string().describe("AST pattern to match."),
          language: tool.schema.string().optional().describe("Optional pattern language, for example Go, TypeScript, or JavaScript."),
          selector: tool.schema.string().optional().describe("Optional AST selector kind."),
          strictness: tool.schema
            .enum(["cst", "smart", "ast", "relaxed", "signature", "template"])
            .optional()
            .describe("Optional ast-grep strictness."),
          paths: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Optional repo-relative paths to search. Defaults to the repo root."),
          globs: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Optional ast-grep glob filters, for example '*.go' or '!**/*_test.go'."),
          limit: tool.schema.number().optional().describe("Maximum number of matches to return."),
        },
        async execute(args) {
          const response = await searchWithAstGrep(ctx.directory, args);
          return JSON.stringify(response, null, 2);
        },
      }),
    },
  };
};

export default plugin;
