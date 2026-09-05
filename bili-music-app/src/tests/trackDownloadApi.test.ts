import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimTrackPreparation,
  closeDatabaseForTests,
  createOrReuseTrack,
  resetDatabaseForTests,
  updateTrack,
  upsertCandidateVideo
} from "../lib/db";
import { proxyTrackMedia } from "../lib/trackMediaProxy";
import { toTrackApiResource } from "../lib/trackApi";
import { POST as batchStatusPost } from "../app/api/tracks/status/route";
import { POST as prepareTrackPost } from "../app/api/tracks/prepare/route";
import { GET as trackListGet } from "../app/api/tracks/route";

test("download proxy forwards ranges with kernel owner and returns safe attachment metadata", async () => {
  const track = seedReadyTrack("download-range", "kernel-owner");
  const originalFetch = globalThis.fetch;
  let upstreamUrl = "";
  let upstreamInit: RequestInit | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    upstreamUrl = String(input);
    upstreamInit = init;
    return new Response("2345", {
      status: 206,
      headers: {
        "content-type": "audio/mp4",
        "content-length": "4",
        "content-range": "bytes 2-5/10",
        "accept-ranges": "bytes"
      }
    });
  }) as typeof fetch;
  try {
    const response = await proxyTrackMedia({
      request: new Request(`http://localhost/api/tracks/${track.id}/download`, {
        headers: { range: "bytes=2-5", "if-range": `"sha256-${"a".repeat(64)}"` }
      }),
      trackId: track.id,
      appOwnerId: "local",
      disposition: "attachment"
    });

    assert.equal(response.status, 206);
    assert.equal(await response.text(), "2345");
    assert.equal(new URL(upstreamUrl).searchParams.get("external_owner_id"), "kernel-owner");
    assert.equal(new Headers(upstreamInit?.headers).get("range"), "bytes=2-5");
    assert.equal(new Headers(upstreamInit?.headers).get("if-range"), `"sha256-${"a".repeat(64)}"`);
    assert.match(response.headers.get("content-disposition") || "", /^attachment;/);
    assert.match(response.headers.get("content-disposition") || "", /filename\*=UTF-8''/);
    assert.equal(response.headers.get("x-content-sha256"), "a".repeat(64));
    assert.equal(response.headers.get("etag"), `"sha256-${"a".repeat(64)}"`);
    assert.equal(response.headers.get("x-file-size"), "10");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabaseForTests();
  }
});

test("download HEAD returns metadata without buffering a body", async () => {
  const track = seedReadyTrack("download-head", "kernel-head-owner");
  const originalFetch = globalThis.fetch;
  let upstreamMethod = "";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    upstreamMethod = String(init?.method || "GET");
    return new Response(null, {
      status: 200,
      headers: { "content-type": "audio/mp4", "content-length": "10", "accept-ranges": "bytes" }
    });
  }) as typeof fetch;
  try {
    const response = await proxyTrackMedia({
      request: new Request(`http://localhost/api/tracks/${track.id}/download`, { method: "HEAD" }),
      trackId: track.id,
      appOwnerId: "local",
      disposition: "attachment",
      headOnly: true
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamMethod, "HEAD");
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("content-length"), "10");
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabaseForTests();
  }
});

test("download proxy enforces app owner isolation before contacting kernel", async () => {
  const track = seedReadyTrack("download-owner", "kernel-owner");
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("must not be called");
  }) as typeof fetch;
  try {
    const response = await proxyTrackMedia({
      request: new Request(`http://localhost/api/tracks/${track.id}/download`),
      trackId: track.id,
      appOwnerId: "another-owner",
      disposition: "attachment"
    });
    const payload = await response.json();
    assert.equal(response.status, 404);
    assert.equal(payload.code, "TRACK_NOT_FOUND");
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabaseForTests();
  }
});

test("public track resource exposes download metadata without kernel owner", () => {
  const track = seedReadyTrack("public-track", "private-kernel-owner");
  try {
    const resource = toTrackApiResource(track);
    assert.equal("kernelOwnerId" in resource, false);
    assert.equal(resource.media.downloadUrl, `/api/tracks/${track.id}/download`);
    assert.equal(resource.media.streamUrl, `/api/tracks/${track.id}/stream`);
    assert.equal(resource.media.resumable, true);
    assert.equal(JSON.stringify(resource).includes("private-kernel-owner"), false);
  } finally {
    closeDatabaseForTests();
  }
});

test("batch track status deduplicates ids and reports missing tracks", async () => {
  const track = seedReadyTrack("batch-status", "kernel-batch-owner");
  try {
    const response = await batchStatusPost(
      new Request("http://localhost/api/tracks/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trackIds: [track.id, track.id, 999_999] })
      })
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.tracks.length, 1);
    assert.deepEqual(payload.missingTrackIds, [999_999]);
    assert.equal("kernelOwnerId" in payload.tracks[0], false);
    assert.equal(payload.tracks[0].media.downloadUrl, `/api/tracks/${track.id}/download`);
  } finally {
    closeDatabaseForTests();
  }
});

test("track list is paginated and owner scoped", async () => {
  seedReadyTrack("list-first", "kernel-owner");
  seedReadyTrack("list-second", "kernel-owner", true);
  try {
    const response = await trackListGet(new Request("http://localhost/api/tracks?limit=1&offset=0"));
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.tracks.length, 1);
    assert.equal(payload.pagination.hasMore, true);
    assert.equal(payload.pagination.nextOffset, 1);
  } finally {
    closeDatabaseForTests();
  }
});

test("track list detects a sentinel row at the public 100 item limit", async () => {
  seedReadyTrack("list-max-first", "kernel-owner");
  for (let index = 1; index < 101; index += 1) {
    seedReadyTrack(`list-max-${index}`, "kernel-owner", true);
  }
  try {
    const response = await trackListGet(new Request("http://localhost/api/tracks?limit=100&offset=0"));
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.tracks.length, 100);
    assert.equal(payload.pagination.hasMore, true);
    assert.equal(payload.pagination.nextOffset, 100);
  } finally {
    closeDatabaseForTests();
  }
});

test("prepare API reuses a ready track without contacting the kernel", async () => {
  const track = seedReadyTrack("prepare-reuse", "kernel-owner");
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("kernel must not be called for a reusable track");
  }) as typeof fetch;
  try {
    const response = await prepareTrackPost(
      new Request("http://localhost/api/tracks/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateId: track.candidateId, strategyMode: "auto" })
      })
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.track.id, track.id);
    assert.equal(payload.track.media.downloadUrl, `/api/tracks/${track.id}/download`);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabaseForTests();
  }
});

function seedReadyTrack(name: string, kernelOwnerId: string, reuseDatabase = false) {
  process.env.APP_SINGLE_USER_MODE = "1";
  process.env.APP_OWNER_ID = "local";
  if (!reuseDatabase) {
    process.env.DATABASE_PATH = path.join(
      os.tmpdir(),
      `bili-music-app-${name}-${Date.now()}-${Math.random()}.sqlite`
    );
    closeDatabaseForTests();
    resetDatabaseForTests();
  }
  const suffix = Math.random().toString(36).slice(2, 12).padEnd(10, "0").slice(0, 10);
  const bvid = `BV${suffix}`;
  const candidate = upsertCandidateVideo({
    bvid,
    aid: null,
    title: `离线歌曲 ${name}`,
    description: null,
    creatorMid: "123",
    creatorName: "Test UP",
    coverUrl: null,
    durationSeconds: 180,
    pubTime: null,
    sourceUrl: `https://www.bilibili.com/video/${bvid}`,
    category: "music",
    tagsJson: "[]",
    searchKeyword: "offline",
    sourceProvider: "test",
  });
  const created = createOrReuseTrack(candidate, "local");
  claimTrackPreparation(created.id, `job-${name}`, "local", kernelOwnerId);
  return updateTrack(
    created.id,
    {
      artifactName: "audio.m4a",
      artifactSha256: "a".repeat(64),
      artifactSizeBytes: 10,
      artifactMimeType: "audio/mp4",
      status: "ready",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    },
    "local"
  );
}
