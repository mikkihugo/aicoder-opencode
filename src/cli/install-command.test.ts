import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { installTargetAssets, checkTargetAssets } from "./install-command.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "aicoder-install-test-"));
}

// ─── installTargetAssets ───────────────────────────────────────────────

test("installTargetAssets_whenOverlayMissing_createsOverlayAndSymlink", async () => {
  const controlPlaneRoot = await makeTempDir();
  const targetRoot = await makeTempDir();
  const targetName = "test-target";

  await mkdir(path.join(controlPlaneRoot, ".opencode", "agents"), { recursive: true });
  await writeFile(path.join(controlPlaneRoot, ".opencode", "agents", "agent.md"), "hello");
  await mkdir(path.join(controlPlaneRoot, ".opencode", "plugins"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "commands"), { recursive: true });

  const results = await installTargetAssets(controlPlaneRoot, targetName, targetRoot, false);

  assert.equal(results.length, 3);
  const agentsResult = results.find((r) => r.kind === "agents")!;
  assert.ok(agentsResult.copied);
  assert.ok(agentsResult.symlinkCreated);
  assert.ok(agentsResult.symlinkCorrect);

  const overlayAgents = path.join(controlPlaneRoot, "targets", targetName, "overlay", ".opencode", "agents");
  const overlayFile = path.join(overlayAgents, "agent.md");
  assert.equal(await readFile(overlayFile, "utf8"), "hello");

  const targetLink = path.join(targetRoot, ".opencode", "agents");
  const linkTarget = await readFile(path.join(targetLink, "agent.md"), "utf8");
  assert.equal(linkTarget, "hello");

  await rm(controlPlaneRoot, { recursive: true, force: true });
  await rm(targetRoot, { recursive: true, force: true });
});

test("installTargetAssets_whenSymlinkAlreadyCorrect_isIdempotent", async () => {
  const controlPlaneRoot = await makeTempDir();
  const targetRoot = await makeTempDir();
  const targetName = "test-target";

  await mkdir(path.join(controlPlaneRoot, ".opencode", "agents"), { recursive: true });
  await writeFile(path.join(controlPlaneRoot, ".opencode", "agents", "agent.md"), "hello");
  await mkdir(path.join(controlPlaneRoot, ".opencode", "plugins"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "commands"), { recursive: true });

  await installTargetAssets(controlPlaneRoot, targetName, targetRoot, false);
  const results = await installTargetAssets(controlPlaneRoot, targetName, targetRoot, false);

  const agentsResult = results.find((r) => r.kind === "agents")!;
  assert.equal(agentsResult.copied, true);
  assert.equal(agentsResult.symlinkCreated, false);
  assert.equal(agentsResult.symlinkCorrect, true);

  await rm(controlPlaneRoot, { recursive: true, force: true });
  await rm(targetRoot, { recursive: true, force: true });
});

test("installTargetAssets_whenTargetHasRealDirectory_throws", async () => {
  const controlPlaneRoot = await makeTempDir();
  const targetRoot = await makeTempDir();
  const targetName = "test-target";

  await mkdir(path.join(controlPlaneRoot, ".opencode", "agents"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "plugins"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "commands"), { recursive: true });

  await mkdir(path.join(targetRoot, ".opencode", "agents"), { recursive: true });

  await assert.rejects(
    async () => installTargetAssets(controlPlaneRoot, targetName, targetRoot, false),
    /install blocked/,
  );

  await rm(controlPlaneRoot, { recursive: true, force: true });
  await rm(targetRoot, { recursive: true, force: true });
});

test("installTargetAssets_whenSymlinkPointsWrong_repairsSymlink", async () => {
  const controlPlaneRoot = await makeTempDir();
  const targetRoot = await makeTempDir();
  const targetName = "test-target";

  await mkdir(path.join(controlPlaneRoot, ".opencode", "agents"), { recursive: true });
  await writeFile(path.join(controlPlaneRoot, ".opencode", "agents", "agent.md"), "hello");
  await mkdir(path.join(controlPlaneRoot, ".opencode", "plugins"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "commands"), { recursive: true });

  const wrongDir = await makeTempDir();
  await mkdir(path.join(targetRoot, ".opencode"), { recursive: true });
  await symlink(wrongDir, path.join(targetRoot, ".opencode", "agents"));

  const results = await installTargetAssets(controlPlaneRoot, targetName, targetRoot, false);
  const agentsResult = results.find((r) => r.kind === "agents")!;
  assert.equal(agentsResult.symlinkCreated, true);
  assert.equal(agentsResult.symlinkCorrect, true);

  const linkPath = path.join(targetRoot, ".opencode", "agents");
  const stats = await lstat(linkPath);
  assert.ok(stats.isSymbolicLink());
  const resolved = await readlink(linkPath);
  assert.ok(resolved.includes("targets"));
  assert.ok(resolved.includes("test-target"));

  await rm(controlPlaneRoot, { recursive: true, force: true });
  await rm(targetRoot, { recursive: true, force: true });
  await rm(wrongDir, { recursive: true, force: true });
});

test("installTargetAssets_preservesOverlayExtras", async () => {
  const controlPlaneRoot = await makeTempDir();
  const targetRoot = await makeTempDir();
  const targetName = "test-target";

  await mkdir(path.join(controlPlaneRoot, ".opencode", "agents"), { recursive: true });
  await writeFile(path.join(controlPlaneRoot, ".opencode", "agents", "base.md"), "base");
  await mkdir(path.join(controlPlaneRoot, ".opencode", "plugins"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "commands"), { recursive: true });

  // Pre-populate overlay with an extra file not in canonical source
  const overlayAgents = path.join(controlPlaneRoot, "targets", targetName, "overlay", ".opencode", "agents");
  await mkdir(overlayAgents, { recursive: true });
  await writeFile(path.join(overlayAgents, "extra.md"), "extra");

  await installTargetAssets(controlPlaneRoot, targetName, targetRoot, false);

  // Extra file should still exist
  assert.equal(await readFile(path.join(overlayAgents, "extra.md"), "utf8"), "extra");
  // Base file should also exist now
  assert.equal(await readFile(path.join(overlayAgents, "base.md"), "utf8"), "base");

  await rm(controlPlaneRoot, { recursive: true, force: true });
  await rm(targetRoot, { recursive: true, force: true });
});

// ─── checkTargetAssets ─────────────────────────────────────────────────

test("checkTargetAssets_whenEverythingCorrect_returnsNoErrors", async () => {
  const controlPlaneRoot = await makeTempDir();
  const targetRoot = await makeTempDir();
  const targetName = "test-target";

  await mkdir(path.join(controlPlaneRoot, ".opencode", "agents"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "plugins"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "commands"), { recursive: true });

  await installTargetAssets(controlPlaneRoot, targetName, targetRoot, false);
  const results = await checkTargetAssets(controlPlaneRoot, targetName, targetRoot);

  assert.ok(results.every((r) => r.error === null));
  assert.ok(results.every((r) => r.symlinkCorrect));

  await rm(controlPlaneRoot, { recursive: true, force: true });
  await rm(targetRoot, { recursive: true, force: true });
});

test("checkTargetAssets_whenSymlinkMissing_reportsError", async () => {
  const controlPlaneRoot = await makeTempDir();
  const targetRoot = await makeTempDir();
  const targetName = "test-target";

  await mkdir(path.join(controlPlaneRoot, ".opencode", "agents"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "plugins"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "commands"), { recursive: true });

  const results = await checkTargetAssets(controlPlaneRoot, targetName, targetRoot);
  const agentsResult = results.find((r) => r.kind === "agents")!;
  assert.ok(agentsResult.error);
  assert.match(agentsResult.error!, /overlay missing/);

  await rm(controlPlaneRoot, { recursive: true, force: true });
  await rm(targetRoot, { recursive: true, force: true });
});

test("checkTargetAssets_whenRealDirectoryBlocks_reportsError", async () => {
  const controlPlaneRoot = await makeTempDir();
  const targetRoot = await makeTempDir();
  const targetName = "test-target";

  await mkdir(path.join(controlPlaneRoot, ".opencode", "agents"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "plugins"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "commands"), { recursive: true });

  await mkdir(path.join(targetRoot, ".opencode", "agents"), { recursive: true });

  const results = await checkTargetAssets(controlPlaneRoot, targetName, targetRoot);
  const agentsResult = results.find((r) => r.kind === "agents")!;
  assert.ok(agentsResult.error);
  assert.match(agentsResult.error!, /install blocked/);

  await rm(controlPlaneRoot, { recursive: true, force: true });
  await rm(targetRoot, { recursive: true, force: true });
});

test("checkTargetAssets_whenWrongSymlink_reportsError", async () => {
  const controlPlaneRoot = await makeTempDir();
  const targetRoot = await makeTempDir();
  const targetName = "test-target";

  await mkdir(path.join(controlPlaneRoot, ".opencode", "agents"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "plugins"), { recursive: true });
  await mkdir(path.join(controlPlaneRoot, ".opencode", "commands"), { recursive: true });

  const wrongDir = await makeTempDir();
  await mkdir(path.join(targetRoot, ".opencode"), { recursive: true });
  await symlink(wrongDir, path.join(targetRoot, ".opencode", "agents"));

  const results = await checkTargetAssets(controlPlaneRoot, targetName, targetRoot);
  const agentsResult = results.find((r) => r.kind === "agents")!;
  assert.ok(agentsResult.error);
  assert.match(agentsResult.error!, /points to the wrong target/);

  await rm(controlPlaneRoot, { recursive: true, force: true });
  await rm(targetRoot, { recursive: true, force: true });
  await rm(wrongDir, { recursive: true, force: true });
});
