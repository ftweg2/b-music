import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  closeDatabaseForTests,
  createOrReuseTrack,
  favoriteBvids,
  createFavoriteVideo,
  createPreferredCreator,
  favoriteCandidateIds,
  getDatabase,
  getTrackByCandidateId,
  listFavoriteVideos,
  resetDatabaseForTests,
  upsertCandidateVideo
} from "../lib/db";
import { musicLikelihood } from "../lib/search/musicHeuristics";
import { rankCandidate, sortByRank } from "../lib/search/ranker";
import type { PreferredCreator } from "../lib/models";
import type { NormalizedCandidate } from "../lib/search/types";
import { normalizeRawSearchResult } from "../lib/search/cache";
import { mockProvider } from "../lib/search/mockProvider";
import { POST as searchPost } from "../app/api/search/route";
import { makeReturnTo, safeInternalReturnTo } from "../lib/navigation";
import { nextIndexOnEnded, nextIndexOnManual, nextPlaybackMode, playbackModeLabel } from "../lib/playback";
import { buildRecommendationReasons } from "../lib/recommendationReasons";
import { selectPlayableArtifact } from "../lib/tracks";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

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

const tests: TestCase[] = [
  {
    name: "music heuristic boosts music-like titles and duration",
    run: () => {
      const score = musicLikelihood({
        title: "Night Flight Star original song MV",
        category: "music",
        durationSeconds: 260,
        tags: ["original", "MV"]
      });
      assert.equal(score > 30, true);
    }
  },
  {
    name: "music heuristic penalizes reaction/tutorial content",
    run: () => {
      const score = musicLikelihood({
        title: "Night Flight Star reaction analysis",
        category: "commentary",
        durationSeconds: 3600,
        tags: ["reaction", "analysis"]
      });
      assert.equal(score < 0, true);
    }
  },
  {
    name: "preferred creator boost is strong",
    run: () => {
      const score = rankCandidate(preferred, "night", [creator]);
      assert.equal(score.preferredCreator, 70);
    }
  },
  {
    name: "ranking orders preferred creator first",
    run: () => {
      const other = { ...preferred, bvid: "BV1mock0002B", creatorMid: "222222", creatorName: "Other" };
      const ranked = sortByRank([other, preferred], "night", [creator]);
      assert.equal(ranked[0].candidate.creatorMid, "111111");
    }
  },
  {
    name: "favorite interaction boosts ranking",
    run: () => {
      const score = rankCandidate(preferred, "night", [], { favorite: 1 });
      assert.equal(score.interaction >= 28, true);
    }
  },
  {
    name: "recommendation reasons hide raw score math from cards",
    run: () => {
      const score = rankCandidate(preferred, "night", [creator]);
      const reasons = buildRecommendationReasons({
        durationSeconds: preferred.durationSeconds,
        scoreBreakdown: score,
        isPreferredCreator: true
      });
      assert.equal(reasons.includes("关注 UP 优先"), true);
      assert.equal(reasons.includes("标题强相关"), true);
    }
  },
  {
    name: "mock provider returns deterministic data",
    run: async () => {
      const results = await mockProvider.searchVideos("night", { limit: 20, page: 1, timeoutMs: 100 });
      assert.equal(results.length > 0, true);
      assert.equal(results[0].bvid.startsWith("BV"), true);
    }
  },
  {
    name: "mock provider supports explicit pagination",
    run: async () => {
      const first = await mockProvider.searchVideos("night", { limit: 2, page: 1, timeoutMs: 100 });
      const second = await mockProvider.searchVideos("night", { limit: 2, page: 2, timeoutMs: 100 });
      assert.equal(first.length, 2);
      assert.equal(second.length, 2);
      assert.notEqual(first[0].bvid, second[0].bvid);
    }
  },
  {
    name: "provider normalization stores metadata only",
    run: () => {
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
    }
  },
  {
    name: "candidate metadata upsert updates by bvid",
    run: () => {
      useTempDatabase("db");
      createPreferredCreator({ biliMid: "111111", name: "Star Sea Music", priorityWeight: 70 });
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
    }
  },
  {
    name: "favorite videos are stored as metadata only",
    run: () => {
      useTempDatabase("favorite");
      const candidate = upsertCandidateVideo({
        bvid: "BV1mockfav01",
        aid: null,
        title: "Favorite local candidate",
        description: null,
        creatorMid: "444444",
        creatorName: "Favorite UP",
        coverUrl: null,
        durationSeconds: 240,
        pubTime: null,
        sourceUrl: "https://www.bilibili.com/video/BV1mockfav01",
        category: "music",
        tagsJson: "[]",
        searchKeyword: "favorite",
        sourceProvider: "test",
        musicLikelihoodScore: 10,
        preferredCreatorBoost: 0,
        finalScore: 20,
        scoreBreakdownJson: "{}"
      });
      const favorite = createFavoriteVideo(candidate.id, { note: "keep" });
      assert.equal(favorite.candidateId, candidate.id);
      assert.equal(favoriteCandidateIds([candidate.id]).has(candidate.id), true);
      assert.equal(listFavoriteVideos(10).length, 1);
      closeDatabaseForTests();
    }
  },
  {
    name: "favorite list repairs missing candidate id when candidate row still exists",
    run: () => {
      useTempDatabase("favorite-link");
      const candidate = upsertCandidateVideo({
        bvid: "BV1mockfav03",
        aid: null,
        title: "Linked favorite candidate",
        description: null,
        creatorMid: "666666",
        creatorName: "Linked UP",
        coverUrl: null,
        durationSeconds: 200,
        pubTime: null,
        sourceUrl: "https://www.bilibili.com/video/BV1mockfav03",
        category: "music",
        tagsJson: "[]",
        searchKeyword: "favorite",
        sourceProvider: "test",
        musicLikelihoodScore: 10,
        preferredCreatorBoost: 0,
        finalScore: 20,
        scoreBreakdownJson: "{}"
      });
      const favorite = createFavoriteVideo(candidate.id, { note: "keep" });
      getDatabase().prepare("UPDATE favorite_videos SET candidate_id=NULL WHERE id=?").run(favorite.id);
      const rows = listFavoriteVideos(10);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].favorite.candidateId, rows[0].candidate.id);
      assert.equal(rows[0].candidate.id, candidate.id);
      closeDatabaseForTests();
    }
  },
  {
    name: "favorite survives candidate cache deletion by bvid snapshot",
    run: () => {
      useTempDatabase("favorite-bvid");
      const candidate = upsertCandidateVideo({
        bvid: "BV1mockfav02",
        aid: null,
        title: "Durable favorite candidate",
        description: null,
        creatorMid: "555555",
        creatorName: "Durable UP",
        coverUrl: null,
        durationSeconds: 180,
        pubTime: null,
        sourceUrl: "https://www.bilibili.com/video/BV1mockfav02",
        category: "music",
        tagsJson: "[]",
        searchKeyword: "favorite",
        sourceProvider: "test",
        musicLikelihoodScore: 10,
        preferredCreatorBoost: 0,
        finalScore: 20,
        scoreBreakdownJson: "{}"
      });
      createFavoriteVideo(candidate.id, { note: "keep" });
      getDatabase().prepare("DELETE FROM candidate_videos WHERE id=?").run(candidate.id);
      const rows = listFavoriteVideos(10);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].favorite.candidateId, rows[0].candidate.id);
      assert.equal(rows[0].candidate.bvid, candidate.bvid);
      assert.equal(rows[0].candidate.title, "Durable favorite candidate");
      assert.equal(favoriteBvids([candidate.bvid]).has(candidate.bvid), true);
      closeDatabaseForTests();
    }
  },
  {
    name: "API search route returns ranked mock candidates",
    run: async () => {
      process.env.SEARCH_PROVIDER = "mock";
      useTempDatabase("api");
      createPreferredCreator({ biliMid: "111111", name: "Star Sea Music", priorityWeight: 70 });
      const request = new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyword: "night", useRemote: true, limit: 20 })
      });
      const response = await searchPost(request);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.candidates.length > 0, true);
      assert.equal(payload.candidates[0].creatorMid, "111111");
      closeDatabaseForTests();
    }
  },
  {
    name: "detail return path preserves internal search URL",
    run: () => {
      const returnTo = makeReturnTo("/", "?q=flower&provider=bilibili&remote=1");
      assert.equal(returnTo, "/?q=flower&provider=bilibili&remote=1");
      assert.equal(safeInternalReturnTo(returnTo), returnTo);
    }
  },
  {
    name: "detail return path rejects external or API targets",
    run: () => {
      assert.equal(safeInternalReturnTo("https://evil.example/search"), "/search");
      assert.equal(safeInternalReturnTo("//evil.example/search"), "/search");
      assert.equal(safeInternalReturnTo("/api/search?q=flower"), "/search");
    }
  },
  {
    name: "track metadata is created without audio storage fields",
    run: () => {
      useTempDatabase("track");
      const candidate = upsertCandidateVideo({
        bvid: "BV1mock0005E",
        aid: null,
        title: "Flower Dance cover",
        description: null,
        creatorMid: "333333",
        creatorName: "Piano UP",
        coverUrl: "https://i0.hdslb.com/bfs/archive/example.jpg",
        durationSeconds: 210,
        pubTime: null,
        sourceUrl: "https://www.bilibili.com/video/BV1mock0005E",
        category: "music",
        tagsJson: "[]",
        searchKeyword: "flower",
        sourceProvider: "test",
        musicLikelihoodScore: 20,
        preferredCreatorBoost: 0,
        finalScore: 30,
        scoreBreakdownJson: "{}"
      });
      const track = createOrReuseTrack(candidate);
      assert.equal(track.candidateId, candidate.id);
      assert.equal(track.status, "pending");
      assert.equal(track.artifactName, null);
      assert.equal(track.artifactSha256, null);
      assert.equal(getTrackByCandidateId(candidate.id)?.id, track.id);
      closeDatabaseForTests();
    }
  },
  {
    name: "playable artifact selection prefers audio.m4a",
    run: () => {
      const selected = selectPlayableArtifact([
        artifact("raw.m4s", "raw", "video/iso.segment"),
        artifact("metadata.json", "metadata", "application/json"),
        artifact("audio.m4a", "m4a", "audio/mp4")
      ]);
      assert.equal(selected?.name, "audio.m4a");
    }
  },
  {
    name: "playback modes advance predictably",
    run: () => {
      assert.equal(nextIndexOnEnded(1, 3, "sequence"), 2);
      assert.equal(nextIndexOnEnded(2, 3, "sequence"), null);
      assert.equal(nextIndexOnEnded(2, 3, "list_loop"), 0);
      assert.equal(nextIndexOnEnded(2, 3, "single_loop"), 2);
      assert.equal(nextIndexOnManual(0, 3, "list_loop", "previous"), 2);
      assert.equal(nextIndexOnManual(2, 3, "sequence", "next"), null);
    }
  },
  {
    name: "shuffle avoids current item when possible",
    run: () => {
      assert.equal(nextIndexOnEnded(1, 4, "shuffle", () => 0), 0);
      assert.equal(nextIndexOnEnded(0, 4, "shuffle", () => 0.99), 3);
    }
  },
  {
    name: "playback mode labels cycle through all modes",
    run: () => {
      assert.equal(playbackModeLabel("sequence"), "顺序播放");
      assert.equal(nextPlaybackMode("sequence"), "list_loop");
      assert.equal(nextPlaybackMode("shuffle"), "sequence");
    }
  }
];

void main();

async function main(): Promise<void> {
  for (const testCase of tests) {
    try {
      await testCase.run();
      console.log(`ok - ${testCase.name}`);
    } catch (error) {
      console.error(`not ok - ${testCase.name}`);
      throw error;
    }
  }

  console.log(`${tests.length} tests passed`);
}

function useTempDatabase(name: string): void {
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `bili-music-app-${name}-${Date.now()}-${Math.random()}.sqlite`);
  closeDatabaseForTests();
  resetDatabaseForTests();
}

function artifact(name: string, type: string, mime: string) {
  return {
    name,
    type,
    size_bytes: 123,
    sha256: "a".repeat(64),
    created_at: new Date().toISOString(),
    producer_strategy: "test",
    mime_guess: mime
  };
}
