import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAstGrepArguments,
  extractAstGrepMatches,
  normalizeAstGrepGlobs,
  normalizeAstGrepLimit,
  normalizeAstGrepPaths,
  normalizeAstGrepStrictness,
} from "./library.ts";

const REPO_DIRECTORY = "/home/mhugo/code/dr-repo";

test("normalizeAstGrepLimit_when_limit_is_too_large_clamps_limit", () => {
  assert.equal(normalizeAstGrepLimit(100), 25);
});

test("normalizeAstGrepPaths_when_absolute_path_is_used_throws", () => {
  assert.throws(() => normalizeAstGrepPaths(REPO_DIRECTORY, ["/tmp"]), /repo-relative/);
});

test("normalizeAstGrepPaths_when_parent_escape_is_used_throws", () => {
  assert.throws(() => normalizeAstGrepPaths(REPO_DIRECTORY, ["../other"]), /inside the repo/);
});

test("normalizeAstGrepStrictness_when_unknown_value_throws", () => {
  assert.throws(() => normalizeAstGrepStrictness("weird"), /strictness must be one of/);
});

test("buildAstGrepArguments_when_full_options_present_builds_expected_argument_order", () => {
  const argumentsList = buildAstGrepArguments({
    pattern: "func $NAME($$$ARGS) { $$$BODY }",
    language: "Go",
    selector: "function_declaration",
    strictness: "ast",
    paths: ["portal"],
    globs: ["*.go", "!**/*_test.go"],
    limit: 5,
  });

  assert.deepEqual(argumentsList, [
    "run",
    "--pattern",
    "func $NAME($$$ARGS) { $$$BODY }",
    "--json=compact",
    "--max-results",
    "5",
    "--strictness",
    "ast",
    "--lang",
    "Go",
    "--selector",
    "function_declaration",
    "--globs",
    "*.go",
    "--globs",
    "!**/*_test.go",
    "portal",
  ]);
});

test("normalizeAstGrepGlobs_when_duplicates_exist_keeps_unique_values", () => {
  assert.deepEqual(normalizeAstGrepGlobs(["*.go", "*.go", "!**/*_test.go"]), ["*.go", "!**/*_test.go"]);
});

test("extractAstGrepMatches_when_payload_has_matches_returns_normalized_matches", () => {
  const matches = extractAstGrepMatches(
    [
      {
        file: "portal/handlers_gin.go",
        language: "Go",
        lines: "func handleMetricsGin(c *gin.Context) {\n\tpromhttp.Handler().ServeHTTP(c.Writer, c.Request)\n}",
        range: {
          start: { line: 3454, column: 0 },
          end: { line: 3456, column: 1 },
        },
        metaVariables: {
          single: {
            NAME: {},
          },
          multi: {
            BODY: [],
            ARGS: [],
          },
        },
      },
    ],
    5,
  );

  assert.deepEqual(matches, [
    {
      file: "portal/handlers_gin.go",
      language: "Go",
      startLine: 3455,
      startColumn: 1,
      endLine: 3457,
      endColumn: 2,
      snippet: "func handleMetricsGin(c *gin.Context) { promhttp.Handler().ServeHTTP(c.Writer, c.Request) }",
      captureNames: ["NAME", "BODY", "ARGS"],
    },
  ]);
});
