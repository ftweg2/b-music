import assert from "node:assert/strict";
import test from "node:test";

import type { PreferredCreator } from "../lib/models";
import { rankCandidate, sortByRank } from "../lib/search/ranker";
import type { NormalizedCandidate } from "../lib/search/types";

const creator: PreferredCreator = {
  id: 1,
  externalOwnerId: "local",
  biliMid: "111111",
  name: "Star Sea Music",
  homepageUrl: null,
  priorityWeight: 70,
  notes: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

const preferred: NormalizedCandidate = {
  bvid: "BV1mock0001A",
  aid: null,
  title: "Night Flight Star original song MV",
  description: "music",
  creatorMid: "111111",
  creatorName: "Star Sea Music",
  coverUrl: null,
  durationSeconds: 260,
  pubTime: new Date().toISOString(),
  sourceUrl: "https://www.bilibili.com/video/BV1mock0001A",
  category: "music",
  tags: ["original"],
  searchKeyword: "night",
  sourceProvider: "mock"
};

test("preferred creator boost is strong", () => {
  const score = rankCandidate(preferred, "night", [creator]);
  assert.equal(score.preferredCreator, 70);
});

test("ranking orders preferred creator first", () => {
  const other = { ...preferred, bvid: "BV1mock0002B", creatorMid: "222222", creatorName: "Other" };
  const ranked = sortByRank([other, preferred], "night", [creator]);
  assert.equal(ranked[0].candidate.creatorMid, "111111");
});
