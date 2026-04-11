import test from "node:test";
import assert from "node:assert/strict";

import {
  loadControlPlaneTargets,
  matchTargetForTask,
  recommendSpecialists,
} from "./control-plane-specialist-routing.js";

test("loadControlPlaneTargets_whenRegistryExists_returnsKnownTargets", async () => {
  const targets = await loadControlPlaneTargets();

  assert.equal(targets.some((target) => target.name === "aicoder-opencode"), true);
  assert.equal(targets.some((target) => target.name === "dr-repo"), true);
  assert.equal(targets.some((target) => target.name === "letta-workspace"), true);
});

test("matchTargetForTask_whenTaskNamesDrRepo_returnsDrRepoTarget", async () => {
  const targets = await loadControlPlaneTargets();
  const matchedTarget = matchTargetForTask(
    "Deepen dr-repo prompt routing so portal and dr-agent checks stop staying shallow.",
    targets,
  );

  assert.equal(matchedTarget?.name, "dr-repo");
});

test("recommendSpecialists_whenTaskTargetsPromptWork_returnsPromptSpecialistsAndTargetReader", async () => {
  const targets = await loadControlPlaneTargets();
  const recommendations = recommendSpecialists(
    "Rework dr-repo prompt doctrine and plugin command surfaces in the shared control plane.",
    targets,
  );

  assert.deepEqual(
    recommendations.map((recommendation) => recommendation.agent),
    ["target_context_reader", "prompt_architect", "prompt_critic"],
  );
});
