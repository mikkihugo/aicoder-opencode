import test from "node:test";
import assert from "node:assert/strict";

import {
  filterUnstableRecommendations,
  markUnstableRecommendations,
  recommend,
} from "./index.ts";

test("recommend_when_advanced_search_prefers_long_context_reader", () => {
  const recommendations = recommend(
    "Run an advanced search and deep audit across many files in the subsystem.",
  );

  assert.equal(recommendations[0]?.agent, "long_context_reader");
});

test("recommend_when_basic_code_path_search_prefers_codebase_explorer", () => {
  const recommendations = recommend(
    "Find the entry point and map which file owns this route.",
  );

  assert.equal(recommendations[0]?.agent, "codebase_explorer");
});

test("recommend_when_repeated_failed_fixes_prefers_oracle", () => {
  const recommendations = recommend(
    "We are stuck after two failed fix attempts and need a second opinion before trying again.",
  );

  assert.equal(recommendations[0]?.agent, "oracle");
});

test("markUnstableRecommendations_when_agent_is_unstable_marks_recommendation", () => {
  const recommendations = markUnstableRecommendations(
    recommend("Find the entry point and map which file owns this route."),
    [
      {
        agent: "codebase_explorer",
        failureCount: 2,
        fallbackAgent: "long_context_reader",
        recoveryHint: "Prefer long_context_reader for this blind spot in the current session.",
      },
    ],
  );

  assert.equal(recommendations[0]?.unstable, true);
  assert.equal(recommendations[0]?.fallbackAgent, "long_context_reader");
});

test("filterUnstableRecommendations_when_stable_recommendation_exists_drops_unstable_one", () => {
  const recommendations = filterUnstableRecommendations(
    markUnstableRecommendations(
      recommend("Find the entry point and map which file owns this route and review correctness."),
      [
        {
          agent: "codebase_explorer",
          failureCount: 2,
          fallbackAgent: "long_context_reader",
          recoveryHint: "Prefer long_context_reader for this blind spot in the current session.",
        },
      ],
    ),
  );

  assert.equal(recommendations.some((recommendation) => recommendation.agent === "codebase_explorer"), false);
});
