import { tool, type Plugin } from "@opencode-ai/plugin";

import {
  DEFAULT_PUBLIC_CODE_SEARCH_LIMIT,
  DEFAULT_PUBLIC_CODE_SEARCH_TIMEOUT_MILLISECONDS,
  GREP_APP_BLOCKED_STATUS,
  GREP_APP_USER_AGENT,
  buildGrepAppAPIURL,
  buildGrepAppSearchURL,
  extractPublicCodeSearchHits,
  normalizePublicCodeSearchLimit,
} from "./library.ts";

type PublicCodeSearchResponse = {
  provider: "grep.app";
  query: string;
  searchURL: string;
  apiURL: string;
  language: string | null;
  pathPattern: string | null;
  repositoryPattern: string | null;
  limit: number;
  success: boolean;
  blocked: boolean;
  status: number | null;
  reason: string | null;
  guidance: string;
  hits: unknown[];
};

async function searchPublicCodeExamples(
  query: string,
  language: string | undefined,
  pathPattern: string | undefined,
  repositoryPattern: string | undefined,
  limit: number,
): Promise<PublicCodeSearchResponse> {
  const searchURL = buildGrepAppSearchURL(query, { language, pathPattern, repositoryPattern });
  const apiURL = buildGrepAppAPIURL(query, { language, pathPattern, repositoryPattern });
  const normalizedLimit = normalizePublicCodeSearchLimit(limit);

  try {
    const response = await fetch(apiURL, {
      headers: {
        accept: "application/json,text/plain,*/*",
        "user-agent": GREP_APP_USER_AGENT,
      },
      signal: AbortSignal.timeout(DEFAULT_PUBLIC_CODE_SEARCH_TIMEOUT_MILLISECONDS),
    });

    if (response.status === GREP_APP_BLOCKED_STATUS) {
      return {
        provider: "grep.app",
        query,
        searchURL,
        apiURL,
        language: language?.trim() || null,
        pathPattern: pathPattern?.trim() || null,
        repositoryPattern: repositoryPattern?.trim() || null,
        limit: normalizedLimit,
        success: false,
        blocked: true,
        status: response.status,
        reason: "grep.app blocked server-side access from this environment with a security checkpoint.",
        guidance:
          "Open the search URL in a browser-backed session when you need public code examples. Use official docs as canonical truth, and store reusable conclusions in dr-memory as research-finding.",
        hits: [],
      };
    }

    if (!response.ok) {
      return {
        provider: "grep.app",
        query,
        searchURL,
        apiURL,
        language: language?.trim() || null,
        pathPattern: pathPattern?.trim() || null,
        repositoryPattern: repositoryPattern?.trim() || null,
        limit: normalizedLimit,
        success: false,
        blocked: false,
        status: response.status,
        reason: `grep.app returned HTTP ${response.status}.`,
        guidance:
          "Use the search URL manually if public code examples still matter. Prefer official docs over public snippets when deciding behavior.",
        hits: [],
      };
    }

    const payload: unknown = await response.json();
    const hits = extractPublicCodeSearchHits(payload, normalizedLimit);

    return {
      provider: "grep.app",
      query,
      searchURL,
      apiURL,
      language: language?.trim() || null,
      pathPattern: pathPattern?.trim() || null,
      repositoryPattern: repositoryPattern?.trim() || null,
      limit: normalizedLimit,
      success: true,
      blocked: false,
      status: response.status,
      reason: null,
      guidance:
        "Use public code examples for pattern pressure, not as canonical truth. Confirm important behavior against official docs or upstream source.",
      hits,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown grep.app request failure.";
    return {
      provider: "grep.app",
      query,
      searchURL,
      apiURL,
      language: language?.trim() || null,
      pathPattern: pathPattern?.trim() || null,
      repositoryPattern: repositoryPattern?.trim() || null,
      limit: normalizedLimit,
      success: false,
      blocked: false,
      status: null,
      reason,
      guidance:
        "Use the search URL manually when public code examples still matter. Prefer repo evidence and official docs before public snippets.",
      hits: [],
    };
  }
}

const plugin: Plugin = async () => {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        [
          "Public code search rule:",
          "- Use grep.app only for public implementation pattern pressure, not as canonical truth.",
          "- Prefer repo evidence first, then official docs, then public code examples when you need to see how real projects use an API or library.",
          "- If a public-code finding materially changes a future decision, store the conclusion in dr-memory as a research-finding with source and date.",
        ].join("\n"),
      );
    },
    tool: {
      grep_app_search: tool({
        description:
          "Search public GitHub code patterns through grep.app. Best effort only: if server-side access is blocked, returns the canonical search URL for manual/browser-backed use.",
        args: {
          query: tool.schema.string().describe("Search query for the public code pattern."),
          language: tool.schema.string().optional().describe("Optional language filter, for example TypeScript or Go."),
          path_pattern: tool.schema.string().optional().describe("Optional grep.app path filter."),
          repository_pattern: tool.schema.string().optional().describe("Optional grep.app repository filter."),
          limit: tool.schema.number().optional().describe("Maximum number of hits to return."),
        },
        async execute(args) {
          const query = args.query.trim();
          if (!query) {
            throw new Error("query must not be empty");
          }

          const response = await searchPublicCodeExamples(
            query,
            args.language,
            args.path_pattern,
            args.repository_pattern,
            args.limit ?? DEFAULT_PUBLIC_CODE_SEARCH_LIMIT,
          );

          return JSON.stringify(response, null, 2);
        },
      }),
    },
  };
};

export default plugin;
