import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRawSearchResult } from "../lib/search/cache";
import { mockProvider } from "../lib/search/mockProvider";

test("mock provider returns deterministic data", async () => {
  const results = await mockProvider.searchVideos("night", { limit: 20, page: 1, timeoutMs: 100 });
  assert.equal(results.length > 0, true);
  assert.equal(results[0].bvid.startsWith("BV"), true);
});

test("normalization stores metadata only", () => {
  const normalized = normalizeRawSearchResult(
    {
      bvid: "BV1mock0001A",
      title: "Night Flight Star original song MV",
      creatorMid: "111111",
      sourceUrl: "https://www.bilibili.com/video/BV1mock0001A?token=secret",
      tags: ["original"]
    },
    "night",
    "mock"
  );
  assert.equal(normalized.bvid, "BV1mock0001A");
  assert.equal(normalized.sourceUrl.includes("token=secret"), false);
});
