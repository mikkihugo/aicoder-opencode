import test from "node:test";
import assert from "node:assert/strict";

import pluginFactory, {
  JSON_ERROR_REMINDER,
  JSON_ERROR_REMINDER_MARKER,
} from "./index.ts";

type ToolExecuteAfterHandler = NonNullable<
  Awaited<ReturnType<typeof pluginFactory>>["tool.execute.after"]
>;

type ToolExecutionInput = Parameters<ToolExecuteAfterHandler>[0];
type ToolExecutionOutput = Parameters<ToolExecuteAfterHandler>[1];

async function createHook() {
  const plugin = await pluginFactory({} as never);
  return plugin["tool.execute.after"] as ToolExecuteAfterHandler;
}

function createInput(tool = "Edit"): ToolExecutionInput {
  return {
    tool,
    sessionID: "ses_test",
    callID: "call_test",
    args: {},
  };
}

function createOutput(
  output: string,
  overrides: Partial<ToolExecutionOutput> = {},
): ToolExecutionOutput {
  return {
    title: "Tool Error",
    output,
    metadata: {},
    ...overrides,
  };
}

test("json_error_recovery_when_json_parse_error_on_error_output_appends_reminder", async () => {
  const hook = await createHook();
  const output = createOutput("JSON parse error: expected '}' in JSON body");

  await hook(createInput("Edit"), output);

  assert.match(output.output ?? "", /\[DR JSON TOOL ARGUMENT ERROR\]/);
});

test("json_error_recovery_when_output_is_not_error_shaped_skips_reminder", async () => {
  const hook = await createHook();
  const output = createOutput("JSON parse error in matched source snippet", { title: "Result" });

  await hook(createInput("ast_grep_search"), output);

  assert.equal(output.output, "JSON parse error in matched source snippet");
});

test("json_error_recovery_when_tool_is_excluded_skips_reminder", async () => {
  const hook = await createHook();
  const output = createOutput("JSON parse error: invalid json");

  await hook(createInput("grep_app_search"), output);

  assert.equal(output.output, "JSON parse error: invalid json");
});

test("json_error_recovery_when_reminder_already_present_does_not_duplicate", async () => {
  const hook = await createHook();
  const output = createOutput(`invalid json\n${JSON_ERROR_REMINDER}`);

  await hook(createInput("Edit"), output);

  const reminderCount = (output.output ?? "").split(JSON_ERROR_REMINDER_MARKER).length - 1;
  assert.equal(reminderCount, 1);
});
