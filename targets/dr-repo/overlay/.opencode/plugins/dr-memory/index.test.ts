import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access, chmod, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  formatOutcomeMemoryContent,
  ingestPendingOutcomes,
  isSecretLikeMaterial,
  memoryRoot,
  parseMemoryType,
  parseOutcomeMemoryType,
  pendingOutcomeRoot,
} from "./test-helpers.ts";

test("parseMemoryType_when_known_type_returns_same_value", () => {
  assert.equal(parseMemoryType("known-gap"), "known-gap");
});

test("parseMemoryType_when_research_finding_returns_same_value", () => {
  assert.equal(parseMemoryType("research-finding"), "research-finding");
});

test("parseMemoryType_when_feature_outcome_returns_same_value", () => {
  assert.equal(parseMemoryType("feature-outcome"), "feature-outcome");
});

test("parseMemoryType_when_unknown_type_throws", () => {
  assert.throws(() => parseMemoryType("random-note"));
});

test("parseOutcomeMemoryType_when_smoke_regression_returns_same_value", () => {
  assert.equal(parseOutcomeMemoryType("smoke-regression"), "smoke-regression");
});

test("parseOutcomeMemoryType_when_non_outcome_type_throws", () => {
  assert.throws(() => parseOutcomeMemoryType("research-finding"));
});

test("isSecretLikeMaterial_when_api_key_pattern_present_returns_true", () => {
  assert.equal(isSecretLikeMaterial("sk-test_abcdefghijklmnopqrstuvwxyz"), true);
});

test("isSecretLikeMaterial_when_normal_text_present_returns_false", () => {
  assert.equal(isSecretLikeMaterial("Known failover gap in gateway health checks."), false);
});

test("formatOutcomeMemoryContent_when_optional_fields_present_serializes_sections", () => {
  assert.equal(
    formatOutcomeMemoryContent({
      summary: "Smoke failed after deploy.",
      userImpact: "Operators cannot verify login flow.",
      environment: "hetzner-beta",
      verificationCommand: "make hetzner-smoke-test",
      evidence: ["Login page returned 500", "Health endpoint stayed green"],
      followUp: "Check auth middleware wiring.",
    }),
    [
      "## Summary",
      "Smoke failed after deploy.",
      "",
      "## User Impact",
      "Operators cannot verify login flow.",
      "",
      "## Environment",
      "hetzner-beta",
      "",
      "## Verification Command",
      "make hetzner-smoke-test",
      "",
      "## Evidence",
      "- Login page returned 500",
      "- Health endpoint stayed green",
      "",
      "## Follow-up",
      "Check auth middleware wiring.",
    ].join("\n"),
  );
});

test("formatOutcomeMemoryContent_when_optional_fields_missing_omits_empty_sections", () => {
  assert.equal(
    formatOutcomeMemoryContent({
      summary: "Feature outcome remembered.",
    }),
    ["## Summary", "Feature outcome remembered."].join("\n"),
  );
});

test("ingestPendingOutcomes_when_pending_file_exists_persists_memory_and_removes_pending_file", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "dr-memory-test-"));
  const fakeQmdDirectory = path.join(temporaryDirectory, "bin");
  const fakeQmdPath = path.join(fakeQmdDirectory, "qmd");
  await mkdir(fakeQmdDirectory, { recursive: true });
  await writeFile(
    fakeQmdPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ \"${1:-}\" == \"--help\" ]]; then",
      "  exit 0",
      "fi",
      "if [[ \"${1:-}\" == \"collection\" && \"${2:-}\" == \"list\" ]]; then",
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeQmdPath, 0o755);

  const pendingDirectory = pendingOutcomeRoot(temporaryDirectory);
  const pendingFilePath = path.join(pendingDirectory, "2026-04-09-smoke.json");
  await mkdir(pendingDirectory, { recursive: true });
  await writeFile(
    pendingFilePath,
    JSON.stringify(
      {
        title: "Hetzner smoke regression after portal deploy",
        content: "Login page returned 500 while /healthz stayed green.",
        memoryType: "smoke-regression",
        tags: ["smoke", "hetzner"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${fakeQmdDirectory}:${originalPath}`;

  try {
    const ingested = await ingestPendingOutcomes(temporaryDirectory, 1);
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].memoryType, "smoke-regression");
    await assert.rejects(access(pendingFilePath));

    const memoryDirectory = path.join(memoryRoot(temporaryDirectory), "smoke-regression");
    const memoryFiles = await readdir(memoryDirectory);
    assert.equal(memoryFiles.length, 1);
    const memoryFilePath = path.join(memoryDirectory, memoryFiles[0]);
    const memoryContent = await readFile(memoryFilePath, "utf8");
    assert.match(memoryContent, /Hetzner smoke regression after portal deploy/);
    assert.match(memoryContent, /memory_type: smoke-regression/);
  } finally {
    process.env.PATH = originalPath;
  }
});
