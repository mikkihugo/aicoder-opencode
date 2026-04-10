import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGrepAppAPIURL,
  buildGrepAppSearchURL,
  extractPublicCodeSearchHits,
  normalizePublicCodeSearchLimit,
} from "./library.ts";

test("buildGrepAppSearchURL_when_filters_exist_includes_all_filters", () => {
  const searchURL = buildGrepAppSearchURL("streamText", {
    language: "TypeScript",
    pathPattern: "src/",
    repositoryPattern: "vercel/.*",
    page: 2,
  });

  assert.equal(
    searchURL,
    "https://grep.app/search?q=streamText&f.lang=TypeScript&f.path=src%2F&f.repo=vercel%2F.*&page=2",
  );
});

test("buildGrepAppAPIURL_when_filters_exist_includes_all_filters", () => {
  const apiURL = buildGrepAppAPIURL("streamText", {
    language: "TypeScript",
    repositoryPattern: "vercel/.*",
  });

  assert.equal(
    apiURL,
    "https://grep.app/api/search?q=streamText&f.lang=TypeScript&f.repo=vercel%2F.*",
  );
});

test("normalizePublicCodeSearchLimit_when_limit_is_too_large_clamps_limit", () => {
  assert.equal(normalizePublicCodeSearchLimit(100), 10);
});

test("extractPublicCodeSearchHits_when_payload_has_hits_returns_normalized_hits", () => {
  const hits = extractPublicCodeSearchHits(
    {
      hits: {
        hits: [
          {
            repo: { raw: "vercel/ai" },
            path: { raw: "packages/core/stream.ts" },
            language: { raw: "TypeScript" },
            content: { snippet: "const streamText = () => {}" },
          },
        ],
      },
    },
    5,
  );

  assert.deepEqual(hits, [
    {
      repository: "vercel/ai",
      path: "packages/core/stream.ts",
      language: "TypeScript",
      snippet: "const streamText = () => {}",
      repositoryURL: "https://github.com/vercel/ai",
    },
  ]);
});
