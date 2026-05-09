import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  closeDatabaseForTests,
  createPreferredCreator,
  resetDatabaseForTests,
  upsertCandidateVideo
} from "../lib/db";

test("candidate metadata upsert updates by bvid", () => {
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `bili-music-app-${Date.now()}-${Math.random()}.sqlite`);
  closeDatabaseForTests();
  resetDatabaseForTests();
  createPreferredCreator({
    biliMid: "111111",
    name: "Star Sea Music",
    priorityWeight: 70
  });
  const first = upsertCandidateVideo({
    bvid: "BV1mock0001A",
    aid: null,
    title: "old title",
    description: null,
    creatorMid: "111111",
    creatorName: "Star Sea Music",
    coverUrl: null,
    durationSeconds: 240,
    pubTime: null,
    sourceUrl: "https://www.bilibili.com/video/BV1mock0001A",
    category: "music",
    tagsJson: "[]",
    searchKeyword: "night",
    sourceProvider: "mock",
    musicLikelihoodScore: 1,
    preferredCreatorBoost: 70,
    finalScore: 80,
    scoreBreakdownJson: "{}"
  });
  const second = upsertCandidateVideo({ ...first, title: "new title" });
  assert.equal(first.id, second.id);
  assert.equal(second.title, "new title");
  closeDatabaseForTests();
});
