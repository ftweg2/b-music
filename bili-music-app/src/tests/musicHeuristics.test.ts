import assert from "node:assert/strict";
import test from "node:test";

import { musicLikelihood } from "../lib/search/musicHeuristics";

test("music heuristic boosts music-like titles and duration", () => {
  const score = musicLikelihood({
    title: "Night Flight Star original song MV",
    category: "music",
    durationSeconds: 260,
    tags: ["original", "MV"]
  });
  assert.equal(score > 30, true);
});

test("music heuristic penalizes reaction/tutorial content", () => {
  const score = musicLikelihood({
    title: "Night Flight Star reaction analysis",
    category: "commentary",
    durationSeconds: 3600,
    tags: ["reaction", "analysis"]
  });
  assert.equal(score < 0, true);
});
