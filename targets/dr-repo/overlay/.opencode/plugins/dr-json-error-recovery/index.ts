import type { Plugin } from "@opencode-ai/plugin";

const JSON_ERROR_REMINDER_MARKER = "[DR JSON TOOL ARGUMENT ERROR]";

const JSON_ERROR_TOOL_EXCLUDE_LIST = new Set([
  "bash",
  "read",
  "glob",
  "grep",
  "webfetch",
  "grep_app_search",
  "ast_grep_search",
  "show_helper_sessions",
  "show_helper_activity",
]);

const JSON_ERROR_PATTERNS = [
  /json parse error/i,
  /failed to parse json/i,
  /invalid json/i,
  /malformed json/i,
  /unexpected end of json input/i,
  /syntaxerror:\s*unexpected token.*json/i,
  /json[^\n]*expected '\}'/i,
  /json[^\n]*unexpected eof/i,
];

type ToolExecutionInput = {
  tool?: string;
  sessionID: string;
  callID: string;
};

type ToolExecutionOutput = {
  title?: string;
  output?: string;
  metadata?: Record<string, unknown>;
};

const JSON_ERROR_REMINDER = `
[DR JSON TOOL ARGUMENT ERROR]

The last tool call used invalid JSON arguments.
Stop and fix the JSON before retrying:
1. Check the exact parse error above.
2. Correct the JSON syntax or schema shape.
3. Retry the tool call with valid JSON only.

Do not repeat the same malformed call.
`;

function isErrorShapedOutput(output: ToolExecutionOutput) {
  const title = output.title ?? "";
  if (/error|failed/i.test(title)) {
    return true;
  }

  const metadata = output.metadata ?? {};
  const exitCode = metadata.exitCode ?? metadata.statusCode ?? metadata.code;
  if (typeof exitCode === "number" && exitCode !== 0) {
    return true;
  }

  return false;
}

function hasJsonParseError(outputText: string) {
  return JSON_ERROR_PATTERNS.some((pattern) => pattern.test(outputText));
}

const plugin: Plugin = async () => {
  return {
    "tool.execute.after": async (input: ToolExecutionInput, output: ToolExecutionOutput) => {
      const toolName = input.tool?.toLowerCase() ?? "";
      if (!toolName || JSON_ERROR_TOOL_EXCLUDE_LIST.has(toolName)) {
        return;
      }

      if (typeof output.output !== "string" || !output.output.trim()) {
        return;
      }

      if (output.output.includes(JSON_ERROR_REMINDER_MARKER)) {
        return;
      }

      if (!isErrorShapedOutput(output)) {
        return;
      }

      if (!hasJsonParseError(output.output)) {
        return;
      }

      output.output += `\n${JSON_ERROR_REMINDER}`;
    },
  };
};

export default plugin;

export {
  JSON_ERROR_PATTERNS,
  JSON_ERROR_REMINDER,
  JSON_ERROR_REMINDER_MARKER,
};
