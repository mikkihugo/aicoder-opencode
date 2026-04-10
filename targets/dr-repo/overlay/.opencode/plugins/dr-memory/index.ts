import { tool, type Plugin } from "@opencode-ai/plugin";

import {
  DEFAULT_RECALL_SEARCH_MODE,
  DEFAULT_REMEMBER_SYNC_MODE,
  DEFAULT_SYNC_MODE,
  MAX_MEMORY_CONTENT_CHARS,
  MAX_MEMORY_RESULTS,
  MEMORY_DIRECTORY,
  MEMORY_TYPES,
  MEMORY_TYPE_DESCRIPTIONS_BY_NAME,
  assertNoSecretLikeMaterial,
  formatOutcomeMemoryContent,
  forgetMemory,
  ingestPendingOutcomes,
  OUTCOME_MEMORY_TYPES,
  parseMemoryType,
  parseOutcomeMemoryType,
  parseSearchMode,
  parseSyncMode,
  recallMemory,
  rememberMemory,
  splitTags,
  syncMemoryIndex,
  truncateContent,
} from "./library.ts";

const plugin: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        [
          "DR memory rule:",
          "- Use dr-memory only for durable cross-session knowledge: decisions, feature outcomes, smoke regressions, user friction, runbook learning, known gaps, research findings, failure patterns, project conventions, release lessons, and user workflow lessons.",
          "- Do not store current slice state, next steps, active plan content, or anything that belongs in checkpoints, STATUS.md, ROADMAP.md, or active-slice.md.",
          "- Do not turn dr-memory into a run log. Store a durable conclusion once, not every transient pass/fail event.",
          "- Do not store secrets, credentials, tokens, or customer-specific sensitive data.",
          "- When external research materially changes a future decision, store the conclusion once as a research-finding with source and date instead of rediscovering it.",
          "- Shell automation may leave pending outcome files under .opencode/state/pending-outcomes/. Ingest them when they represent a durable lesson worth keeping.",
        ].join("\n"),
      );
    },
    tool: {
      memory_list_types: tool({
        description: "List the DR memory types and what each type is for.",
        args: {},
        async execute() {
          return JSON.stringify(
            {
              memoryRoot: MEMORY_DIRECTORY,
              memoryTypes: MEMORY_TYPES.map((memoryType) => ({
                name: memoryType,
                description: MEMORY_TYPE_DESCRIPTIONS_BY_NAME[memoryType],
              })),
            },
            null,
            2,
          );
        },
      }),
      memory_remember: tool({
        description:
          "Store durable DR repo knowledge as markdown memory. Use this only for long-lived cross-session knowledge, not current workflow state.",
        args: {
          title: tool.schema.string().describe("Short memory title."),
          content: tool.schema.string().describe("Memory content to persist."),
          memory_type: tool.schema.string().describe(`One of: ${MEMORY_TYPES.join(", ")}`),
          tags: tool.schema.array(tool.schema.string()).optional().describe("Optional search tags."),
          sync_mode: tool.schema
            .string()
            .optional()
            .describe(`Optional sync mode: ${DEFAULT_REMEMBER_SYNC_MODE}, index, or embed.`),
        },
        async execute(args) {
          const memoryType = parseMemoryType(args.memory_type.trim());
          const syncMode = parseSyncMode((args.sync_mode ?? DEFAULT_REMEMBER_SYNC_MODE).trim());
          assertNoSecretLikeMaterial(args.title, args.content, ...(args.tags ?? []));

          const filePath = await rememberMemory(
            ctx.directory,
            args.title,
            args.content,
            memoryType,
            splitTags(args.tags),
            syncMode,
          );

          return JSON.stringify(
            {
              success: true,
              filePath,
              memoryType,
              syncMode,
            },
            null,
            2,
          );
        },
      }),
      memory_recall: tool({
        description:
          "Recall DR memories by semantic or lexical search. If query is omitted, returns the latest memories.",
        args: {
          query: tool.schema.string().optional().describe("Search query. Omit to return latest memories."),
          memory_type: tool.schema
            .string()
            .optional()
            .describe(`Optional type filter: ${MEMORY_TYPES.join(", ")}`),
          limit: tool.schema.number().optional().describe("Maximum number of results."),
          search_mode: tool.schema
            .string()
            .optional()
            .describe(`Optional search mode: ${DEFAULT_RECALL_SEARCH_MODE}, search, or vsearch.`),
        },
        async execute(args) {
          const memoryType = args.memory_type?.trim() ? parseMemoryType(args.memory_type.trim()) : undefined;
          const searchMode = parseSearchMode((args.search_mode ?? DEFAULT_RECALL_SEARCH_MODE).trim());

          const memories = await recallMemory(
            ctx.directory,
            args.query,
            memoryType,
            Math.min(args.limit ?? MAX_MEMORY_RESULTS, MAX_MEMORY_RESULTS),
            searchMode,
          );

          return JSON.stringify(
            {
              count: memories.length,
              memories: memories.map((memory) => ({
                filePath: memory.filePath,
                title: memory.title,
                memoryType: memory.memoryType,
                tags: memory.tags,
                created: memory.created,
                modified: memory.modified,
                score: memory.score,
                snippet: "snippet" in memory ? memory.snippet : undefined,
                content: truncateContent(memory.content, MAX_MEMORY_CONTENT_CHARS),
              })),
            },
            null,
            2,
          );
        },
      }),
      memory_record_outcome: tool({
        description:
          "Store a durable feature outcome, smoke regression, user friction finding, or runbook learning without turning dr-memory into a raw run log.",
        args: {
          title: tool.schema.string().describe("Short outcome title."),
          memory_type: tool.schema
            .string()
            .describe(`One of: ${OUTCOME_MEMORY_TYPES.join(", ")}`),
          summary: tool.schema.string().describe("Durable outcome summary."),
          user_impact: tool.schema
            .string()
            .optional()
            .describe("Optional user/admin/operator impact."),
          environment: tool.schema
            .string()
            .optional()
            .describe("Optional environment such as local, staging, hetzner-beta, or production."),
          verification_command: tool.schema
            .string()
            .optional()
            .describe("Optional command or check that proved the outcome."),
          evidence: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Optional durable evidence bullets."),
          follow_up: tool.schema
            .string()
            .optional()
            .describe("Optional known gap or follow-up work."),
          tags: tool.schema.array(tool.schema.string()).optional().describe("Optional search tags."),
          sync_mode: tool.schema
            .string()
            .optional()
            .describe(`Optional sync mode: ${DEFAULT_REMEMBER_SYNC_MODE}, index, or embed.`),
        },
        async execute(args) {
          const memoryType = parseOutcomeMemoryType(args.memory_type.trim());
          const syncMode = parseSyncMode((args.sync_mode ?? DEFAULT_REMEMBER_SYNC_MODE).trim());
          assertNoSecretLikeMaterial(
            args.title,
            args.summary,
            args.user_impact ?? "",
            args.environment ?? "",
            args.verification_command ?? "",
            args.follow_up ?? "",
            ...(args.evidence ?? []),
            ...(args.tags ?? []),
          );

          const filePath = await rememberMemory(
            ctx.directory,
            args.title,
            formatOutcomeMemoryContent({
              summary: args.summary,
              userImpact: args.user_impact,
              environment: args.environment,
              verificationCommand: args.verification_command,
              evidence: args.evidence,
              followUp: args.follow_up,
            }),
            memoryType,
            splitTags(args.tags),
            syncMode,
          );

          return JSON.stringify(
            {
              success: true,
              filePath,
              memoryType,
              syncMode,
            },
            null,
            2,
          );
        },
      }),
      memory_sync: tool({
        description:
          "Sync DR memory into QMD. Use embed for semantic recall and index for fast lexical refresh only.",
        args: {
          memory_type: tool.schema
            .string()
            .optional()
            .describe(`Optional type filter: ${MEMORY_TYPES.join(", ")}`),
          sync_mode: tool.schema
            .string()
            .optional()
            .describe(`Optional sync mode: ${DEFAULT_SYNC_MODE}, index, or embed.`),
        },
        async execute(args) {
          const memoryType = args.memory_type?.trim() ? parseMemoryType(args.memory_type.trim()) : undefined;
          const syncMode = parseSyncMode((args.sync_mode ?? DEFAULT_SYNC_MODE).trim());

          await syncMemoryIndex(ctx.directory, syncMode, memoryType);
          return JSON.stringify(
            {
              success: true,
              memoryType: memoryType ?? "all",
              syncMode,
            },
            null,
            2,
          );
        },
      }),
      memory_forget: tool({
        description:
          "Delete a DR memory by file path returned from memory_recall. Use this only to remove stale or wrong durable memory.",
        args: {
          file_path: tool.schema.string().describe("Absolute file path returned from memory_recall."),
        },
        async execute(args) {
          await forgetMemory(ctx.directory, args.file_path);
          return JSON.stringify({ success: true, filePath: args.file_path }, null, 2);
        },
      }),
      memory_ingest_pending_outcomes: tool({
        description:
          "Ingest durable pending outcome files from .opencode/state/pending-outcomes into dr-memory.",
        args: {
          limit: tool.schema.number().optional().describe("Maximum number of pending outcome files to ingest."),
        },
        async execute(args) {
          const ingested = await ingestPendingOutcomes(
            ctx.directory,
            Math.min(args.limit ?? MAX_MEMORY_RESULTS, MAX_MEMORY_RESULTS),
          );
          return JSON.stringify(
            {
              success: true,
              count: ingested.length,
              ingested,
            },
            null,
            2,
          );
        },
      }),
    },
  };
};

export default plugin;
