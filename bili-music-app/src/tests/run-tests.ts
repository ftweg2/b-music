import assert from "node:assert/strict";
import "./testEnvironment";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NextResponse } from "next/server";

import {
  closeDatabaseForTests,
  claimTrackPreparation,
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
import type { SearchProvider } from "../lib/search/types";
import { normalizeRawSearchResult, runSearch } from "../lib/search/cache";
import { mockProvider } from "../lib/search/mockProvider";
import { POST as searchPost } from "../app/api/search/route";
import { makeReturnTo, safeInternalReturnTo } from "../lib/navigation";
import { nextIndexOnEnded, nextIndexOnManual, nextPlaybackMode, playbackModeLabel } from "../lib/playback";
import { selectPlayableArtifact } from "../lib/tracks";
import { assertRateLimit, RateLimitError, resetRateLimitsForTests } from "../lib/rateLimit";
import {
  APP_OWNER_COOKIE,
  APP_OWNER_NAME_COOKIE,
  clearAppOwnerCookies,
  setAppOwnerCookies
} from "../lib/appOwner";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const tests: TestCase[] = [
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
      createPreferredCreator({ biliMid: "111111", name: "Star Sea Music" });
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
    name: "API search route returns unscored mock candidates",
    run: async () => {
      process.env.SEARCH_PROVIDER = "mock";
      useTempDatabase("api");
      createPreferredCreator({ biliMid: "111111", name: "Star Sea Music" });
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
    name: "remote search performs one request without creator expansion",
    run: async () => {
      useTempDatabase("search-concurrency");
      createPreferredCreator({ biliMid: "111111", name: "Creator One" });
      createPreferredCreator({ biliMid: "222222", name: "Creator Two" });

      const started: string[] = [];
      let releaseSearches: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseSearches = resolve;
      });
      const provider: SearchProvider = {
        name: "concurrency-test",
        supportsConcurrentSearch: true,
        async searchVideos(keyword) {
          started.push(keyword);
          await gate;
          return [];
        }
      };

      const pending = runSearch({
        keyword: "night",
        useRemote: true,
        limit: 20,
        appOwnerId: "local",
        searchProvider: provider
      });
      await Promise.resolve();

      assert.deepEqual(new Set(started), new Set(["night"]));
      releaseSearches();
      await pending;
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
    name: "tracks are isolated by app owner",
    run: () => {
      useTempDatabase("track-owner");
      const candidate = upsertCandidateVideo({
        bvid: "BV1mockown01",
        aid: null,
        title: "Owner-isolated track",
        description: null,
        creatorMid: "333333",
        creatorName: "Owner Test UP",
        coverUrl: null,
        durationSeconds: 210,
        pubTime: null,
        sourceUrl: "https://www.bilibili.com/video/BV1mockown01",
        category: "music",
        tagsJson: "[]",
        searchKeyword: "owner",
        sourceProvider: "test",
      });

      const ownerOneTrack = createOrReuseTrack(candidate, "bili:1001");
      const ownerTwoTrack = createOrReuseTrack(candidate, "bili:2002");

      assert.notEqual(ownerOneTrack.id, ownerTwoTrack.id);
      assert.equal(ownerOneTrack.externalOwnerId, "bili:1001");
      assert.equal(ownerTwoTrack.externalOwnerId, "bili:2002");
      assert.equal(getTrackByCandidateId(candidate.id, "bili:1001")?.id, ownerOneTrack.id);
      assert.equal(getTrackByCandidateId(candidate.id, "bili:2002")?.id, ownerTwoTrack.id);
      assert.equal(getTrackByCandidateId(candidate.id, "bili:3003"), null);
      closeDatabaseForTests();
    }
  },
  {
    name: "track preparation can only be claimed once",
    run: () => {
      useTempDatabase("track-claim");
      const candidate = upsertCandidateVideo({
        bvid: "BV1mockclaim1",
        aid: null,
        title: "Preparation claim test",
        description: null,
        creatorMid: "333333",
        creatorName: "Claim Test UP",
        coverUrl: null,
        durationSeconds: 210,
        pubTime: null,
        sourceUrl: "https://www.bilibili.com/video/BV1mockclaim1",
        category: "music",
        tagsJson: "[]",
        searchKeyword: "claim",
        sourceProvider: "test",
      });
      const track = createOrReuseTrack(candidate, "local");
      const claimed = claimTrackPreparation(track.id, "job-one", "local", "kernel-owner");
      assert.equal(claimed?.kernelJobId, "job-one");
      assert.equal(claimed?.kernelOwnerId, "kernel-owner");
      assert.equal(claimTrackPreparation(track.id, "job-two", "local"), null);
      assert.equal(getTrackByCandidateId(candidate.id, "local")?.kernelJobId, "job-one");
      closeDatabaseForTests();
    }
  },
  {
    name: "legacy tracks migrate to the local owner without losing metadata",
    run: () => {
      const dbPath = useTempDatabase("track-owner-migration");
      const candidate = upsertCandidateVideo({
        bvid: "BV1mockmigr1",
        aid: null,
        title: "Legacy track",
        description: null,
        creatorMid: null,
        creatorName: null,
        coverUrl: null,
        durationSeconds: 180,
        pubTime: null,
        sourceUrl: "https://www.bilibili.com/video/BV1mockmigr1",
        category: "music",
        tagsJson: "[]",
        searchKeyword: "legacy",
        sourceProvider: "test",
      });
      const track = createOrReuseTrack(candidate);
      getDatabase()
        .prepare("UPDATE tracks SET kernel_job_id=?, artifact_name=?, status=? WHERE id=?")
        .run("legacy_job", "audio.m4a", "ready", track.id);
      closeDatabaseForTests();

      rewriteTracksAsLegacySchema(dbPath);
      const migrated = getTrackByCandidateId(candidate.id);

      assert.equal(migrated?.id, track.id);
      assert.equal(migrated?.externalOwnerId, "local");
      assert.equal(migrated?.kernelOwnerId, "local");
      assert.equal(migrated?.kernelJobId, "legacy_job");
      assert.equal(migrated?.artifactName, "audio.m4a");
      assert.equal(migrated?.status, "ready");
      closeDatabaseForTests();
    }
  },
  {
    name: "logout expires app owner cookies",
    run: () => {
      const response = NextResponse.json({ ok: true });
      setAppOwnerCookies(response, { biliUid: "1001", nickname: "Listener" });
      assert.equal(response.cookies.get(APP_OWNER_COOKIE)?.value, "bili:1001");
      assert.equal(response.cookies.get(APP_OWNER_NAME_COOKIE)?.value, "Listener");

      clearAppOwnerCookies(response);

      assert.equal(response.cookies.get(APP_OWNER_COOKIE)?.value, "");
      assert.equal(response.cookies.get(APP_OWNER_COOKIE)?.maxAge, 0);
      assert.equal(response.cookies.get(APP_OWNER_NAME_COOKIE)?.value, "");
      assert.equal(response.cookies.get(APP_OWNER_NAME_COOKIE)?.maxAge, 0);
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
  },
  {
    name: "rate limiter reports retry timing",
    run: () => {
      resetRateLimitsForTests();
      assertRateLimit("test-owner", 1, 60_000);
      assert.throws(
        () => assertRateLimit("test-owner", 1, 60_000),
        (error) => error instanceof RateLimitError && error.retryAfterSeconds > 0
      );
      resetRateLimitsForTests();
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

function useTempDatabase(name: string): string {
  const dbPath = path.join(os.tmpdir(), `bili-music-app-${name}-${Date.now()}-${Math.random()}.sqlite`);
  process.env.DATABASE_PATH = dbPath;
  closeDatabaseForTests();
  resetDatabaseForTests();
  return dbPath;
}

function rewriteTracksAsLegacySchema(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX IF EXISTS idx_tracks_candidate;
      DROP INDEX IF EXISTS idx_tracks_status;
      ALTER TABLE tracks RENAME TO tracks_owner_aware;
      CREATE TABLE tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id INTEGER NOT NULL UNIQUE,
        bvid TEXT NOT NULL,
        title TEXT NOT NULL,
        source_url TEXT NOT NULL,
        kernel_job_id TEXT,
        artifact_name TEXT,
        artifact_sha256 TEXT,
        artifact_size_bytes INTEGER,
        artifact_mime_type TEXT,
        duration_seconds INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        failure_reason TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(candidate_id) REFERENCES candidate_videos(id) ON DELETE CASCADE
      );
      INSERT INTO tracks (
        id, candidate_id, bvid, title, source_url, kernel_job_id, artifact_name,
        artifact_sha256, artifact_size_bytes, artifact_mime_type, duration_seconds,
        status, failure_reason, expires_at, created_at, updated_at
      )
      SELECT
        id, candidate_id, bvid, title, source_url, kernel_job_id, artifact_name,
        artifact_sha256, artifact_size_bytes, artifact_mime_type, duration_seconds,
        status, failure_reason, expires_at, created_at, updated_at
      FROM tracks_owner_aware;
      DROP TABLE tracks_owner_aware;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    db.close();
  }
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
