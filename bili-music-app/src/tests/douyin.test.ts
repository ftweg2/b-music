import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { closeDatabaseForTests, getCandidateByBvid } from "../lib/db";
import { GET as coverGet } from "../app/api/covers/[bvid]/route";
import { ApiError } from "../lib/api";
import { candidateReference } from "../lib/apiInput";
import { douyinIdFromLink, findDouyinLink } from "../lib/douyinLink";
import type { KernelDouyinItem } from "../lib/kernelClient";
import { playbackBvid } from "../lib/playbackRanges";
import { resetRateLimitsForTests } from "../lib/rateLimit";
import { runSearch, saveCandidateMetadata } from "../lib/search/cache";
import { normalizeDouyinItem } from "../lib/search/douyin";
import { prepareTrack, selectPlayableArtifact } from "../lib/tracks";
import { isVideoRef, sanitizeVideoRef, sourceUrlForVideoRef, videoSource, watchOnSourceLabel } from "../lib/videoRef";

const AWEME_ID = "7687946506598968422";
const SHARE_TEXT = `7.94 复制打开抖音，看看【孩百万的作品】视频32分42秒，你大概率不会听完 # 三狗子呀 https://v.douyin.com/iRNBho6x/ abc:/ 12/25 E@v.Fh`;

function database() {
  closeDatabaseForTests();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `b-music-douyin-${crypto.randomUUID()}.sqlite`);
  resetRateLimitsForTests();
}

function kernelItem(overrides: Partial<KernelDouyinItem> = {}): KernelDouyinItem {
  return {
    provider: "kernel_douyin", profile_id: "p_test", aweme_id: AWEME_ID,
    source_url: `https://www.douyin.com/video/${AWEME_ID}`,
    title: "起因是主播正在练《你离开的事实》 #你离开的事实 #小提琴", creator_name: "上音的秋刀鱼",
    duration_seconds: 62, music_title: "@上音的秋刀鱼创作的原声", music_author: "上音的秋刀鱼",
    has_music_audio: true, has_video_audio: true, has_cover: true, ...overrides,
  };
}

type KernelCall = { path: string; body: Record<string, unknown> | null };

async function withKernel<T>(handler: (call: KernelCall) => Response, run: (calls: KernelCall[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: KernelCall[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const call = { path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return handler(call);
  };
  try { return await run(calls); } finally { globalThis.fetch = original; }
}

function kernelHandler(item: KernelDouyinItem | Response) {
  return (call: KernelCall) => {
    if (call.path === "/v1/profiles") return Response.json({ profile_id: "p_test", external_owner_id: "local", status: "exists" });
    if (call.path === "/v1/douyin/resolve") return item instanceof Response ? item : Response.json(item);
    return Response.json({ job_id: "job", status: "queued", stage: "queued" });
  };
}

test("video references cover Bilibili BV ids and DY-prefixed Douyin ids", () => {
  assert.equal(isVideoRef("BV1GJ411x7h7"), true);
  assert.equal(isVideoRef(`DY${AWEME_ID}`), true);
  assert.equal(isVideoRef("DY123"), false);
  assert.equal(isVideoRef(AWEME_ID), false);
  assert.equal(videoSource(`DY${AWEME_ID}`), "douyin");
  assert.equal(videoSource("BV1GJ411x7h7"), "bilibili");
  assert.equal(sourceUrlForVideoRef(`DY${AWEME_ID}`), `https://www.douyin.com/video/${AWEME_ID}`);
  assert.equal(sourceUrlForVideoRef("BV1GJ411x7h7"), "https://www.bilibili.com/video/BV1GJ411x7h7");
  assert.equal(sanitizeVideoRef(`DY${AWEME_ID}`), `DY${AWEME_ID}`);
  assert.equal(sanitizeVideoRef("see https://www.bilibili.com/video/BV1GJ411x7h7?p=2"), "BV1GJ411x7h7");
  assert.equal(watchOnSourceLabel(`DY${AWEME_ID}`), "在抖音观看");
});

test("Douyin links are found inside share text and page URLs", () => {
  assert.equal(findDouyinLink(SHARE_TEXT), "https://v.douyin.com/iRNBho6x/");
  assert.equal(findDouyinLink(`看这个：https://www.douyin.com/jingxuan?modal_id=${AWEME_ID}。`), `https://www.douyin.com/jingxuan?modal_id=${AWEME_ID}`);
  assert.equal(findDouyinLink("https://www.bilibili.com/video/BV1GJ411x7h7"), null);
  assert.equal(findDouyinLink("https://douyin.com.example.com/video/1"), null);
  assert.equal(findDouyinLink("周杰伦"), null);
  assert.equal(douyinIdFromLink(`https://www.douyin.com/video/${AWEME_ID}`), AWEME_ID);
  assert.equal(douyinIdFromLink(`https://www.iesdouyin.com/share/video/${AWEME_ID}/?region=CN`), AWEME_ID);
  assert.equal(douyinIdFromLink(`https://www.douyin.com/jingxuan?modal_id=${AWEME_ID}`), AWEME_ID);
  assert.equal(douyinIdFromLink("https://v.douyin.com/iRNBho6x/"), null);
});

test("kernel metadata becomes a Douyin candidate that never matches a followed UP", () => {
  const candidate = normalizeDouyinItem(kernelItem(), "https://v.douyin.com/iRNBho6x/");
  assert.equal(candidate.bvid, `DY${AWEME_ID}`);
  assert.equal(candidate.title, "起因是主播正在练《你离开的事实》");
  assert.deepEqual(candidate.tags, ["你离开的事实", "小提琴"]);
  assert.match(candidate.description!, /背景音乐：@上音的秋刀鱼创作的原声 - 上音的秋刀鱼/);
  assert.equal(candidate.creatorMid, null);
  assert.equal(candidate.creatorName, "上音的秋刀鱼");
  assert.equal(candidate.sourceUrl, `https://www.douyin.com/video/${AWEME_ID}`);
  assert.equal(candidate.sourceProvider, "douyin_url");
  assert.equal(normalizeDouyinItem(kernelItem({ title: "#只有标签" }), null).title, "@上音的秋刀鱼创作的原声");
  assert.throws(() => normalizeDouyinItem(kernelItem({ aweme_id: "../../x" }), null), /无效/);
});

test("pasting a Douyin share text resolves one candidate through the kernel", async () => {
  database();
  await withKernel(kernelHandler(kernelItem()), async (calls) => {
    const result = await runSearch({ keyword: SHARE_TEXT.slice(0, 200), useRemote: true, limit: 20 });
    assert.equal(result.source, "direct");
    assert.deepEqual(result.candidates.map((item) => item.bvid), [`DY${AWEME_ID}`]);
    const resolve = calls.find((call) => call.path === "/v1/douyin/resolve");
    assert.equal(resolve?.body?.url, "https://v.douyin.com/iRNBho6x/");
    assert.equal(resolve?.body?.profile_id, "p_test");
  });
});

test("a Douyin link with a known item id reuses the saved candidate without the kernel", async () => {
  database();
  saveCandidateMetadata(normalizeDouyinItem(kernelItem(), null));
  await withKernel(() => { throw new Error("kernel must not be called"); }, async (calls) => {
    const result = await runSearch({ keyword: `https://www.douyin.com/jingxuan?modal_id=${AWEME_ID}`, useRemote: true, limit: 20 });
    assert.deepEqual(result.candidates.map((item) => item.bvid), [`DY${AWEME_ID}`]);
    assert.equal(calls.length, 0);
  });
});

test("Douyin candidates point at the App cover route, never at a Douyin image URL", () => {
  const withCover = normalizeDouyinItem(kernelItem(), null);
  const withoutCover = normalizeDouyinItem(kernelItem({ has_cover: false }), null);
  assert.equal(withCover.coverUrl, `/api/covers/DY${AWEME_ID}`);
  assert.equal(withoutCover.coverUrl, null);
});

test("a saved Douyin item without a cover is looked up again to get one", async () => {
  database();
  saveCandidateMetadata(normalizeDouyinItem(kernelItem({ has_cover: false }), null));
  await withKernel(kernelHandler(kernelItem()), async (calls) => {
    const result = await runSearch({ keyword: `https://www.douyin.com/video/${AWEME_ID}`, useRemote: true, limit: 20 });
    assert.equal(result.candidates[0].coverUrl, `/api/covers/DY${AWEME_ID}`);
    assert.equal(calls.filter((call) => call.path === "/v1/douyin/resolve").length, 1);
  });
});

test("cover route streams the kernel's cached Douyin cover", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  await withKernel((call) => {
    assert.equal(call.path, `/v1/douyin/covers/${AWEME_ID}`);
    return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
  }, async () => {
    const response = await coverGet(new Request(`http://app/api/covers/DY${AWEME_ID}`), { params: Promise.resolve({ bvid: `DY${AWEME_ID}` }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg);
  });
});

test("cover route rejects Bilibili refs, missing covers and non-images", async () => {
  const context = (bvid: string) => ({ params: Promise.resolve({ bvid }) });
  await withKernel(() => { throw new Error("kernel must not be called"); }, async (calls) => {
    const bilibili = await coverGet(new Request("http://app/api/covers/BV1GJ411x7h7"), context("BV1GJ411x7h7"));
    const traversal = await coverGet(new Request("http://app/api/covers/x"), context("../../v1/jobs"));
    assert.equal(bilibili.status, 404);
    assert.equal(traversal.status, 404);
    assert.equal(calls.length, 0);
  });
  await withKernel(() => Response.json({ detail: "cover not cached" }, { status: 404 }), async () => {
    const missing = await coverGet(new Request(`http://app/api/covers/DY${AWEME_ID}`), context(`DY${AWEME_ID}`));
    assert.equal(missing.status, 404);
  });
  await withKernel(() => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }), async () => {
    const svg = await coverGet(new Request(`http://app/api/covers/DY${AWEME_ID}`), context(`DY${AWEME_ID}`));
    assert.equal(svg.status, 502);
  });
});

test("local-only search never contacts the kernel for an unknown Douyin link", async () => {
  database();
  await withKernel(() => { throw new Error("kernel must not be called"); }, async (calls) => {
    const result = await runSearch({ keyword: "https://v.douyin.com/iRNBho6x/", useRemote: false, limit: 20 });
    assert.equal(result.source, "direct");
    assert.deepEqual(result.candidates, []);
    assert.equal(calls.length, 0);
  });
});

test("unavailable Douyin items report a readable error", async () => {
  database();
  const unavailable = Response.json({ detail: "DOUYIN_ITEM_UNAVAILABLE: Douyin item is unavailable or private (core_dep)" }, { status: 404 });
  await withKernel(kernelHandler(unavailable), async () => {
    await assert.rejects(runSearch({ keyword: `https://www.douyin.com/video/${AWEME_ID}`, useRemote: true, limit: 20 }), /已删除或仅作者可见/);
  });
});

test("Douyin tracks always use the douyin_music strategy and keep the raw source audio", async () => {
  database();
  const candidate = saveCandidateMetadata(normalizeDouyinItem(kernelItem(), null));
  await withKernel(kernelHandler(kernelItem()), async (calls) => {
    const track = await prepareTrack({
      candidateId: candidate.id, profileId: "p_test", appOwnerId: "local", externalOwnerId: "local",
      strategyMode: "auto", strategyOrder: ["api_dash", "browser_network"],
    });
    assert.equal(track.status, "preparing");
    const job = calls.find((call) => call.path === "/v1/jobs");
    assert.equal(job?.body?.url, `https://www.douyin.com/video/${AWEME_ID}`);
    assert.equal(job?.body?.strategy_mode, "force");
    assert.equal(job?.body?.strategy, "douyin_music");
    assert.equal(job?.body?.strategy_order, undefined);
    assert.deepEqual(job?.body?.outputs, ["raw"]);
  });
});

test("Bilibili tracks keep their requested strategies and m4a output", async () => {
  database();
  const candidate = saveCandidateMetadata({ ...normalizeDouyinItem(kernelItem(), null), bvid: "BV1GJ411x7h7", sourceUrl: "https://www.bilibili.com/video/BV1GJ411x7h7" });
  await withKernel(kernelHandler(kernelItem()), async (calls) => {
    await prepareTrack({ candidateId: candidate.id, profileId: "p_test", appOwnerId: "local", externalOwnerId: "local", strategyMode: "auto", strategyOrder: ["api_dash"] });
    const job = calls.find((call) => call.path === "/v1/jobs");
    assert.deepEqual(job?.body?.strategy_order, ["api_dash"]);
    assert.deepEqual(job?.body?.outputs, ["m4a"]);
  });
});

test("a raw MP3 artifact is playable when no m4a exists", () => {
  const artifact = (name: string, type: string, mime: string | null) => ({ name, type, size_bytes: 1, sha256: "x", created_at: "", producer_strategy: "douyin_music", mime_guess: mime });
  const selected = selectPlayableArtifact([
    artifact("metadata.json", "metadata", "application/json"),
    artifact("raw.mp3", "raw", "audio/mpeg"),
  ]);
  assert.equal(selected?.name, "raw.mp3");
});

test("API inputs and playback ranges accept Douyin references", () => {
  assert.deepEqual(candidateReference({ bvid: `DY${AWEME_ID}` }), { candidateId: undefined, bvid: `DY${AWEME_ID}` });
  assert.equal(playbackBvid(`DY${AWEME_ID}`), `DY${AWEME_ID}`);
  assert.throws(() => candidateReference({ bvid: "DY1" }), ApiError);
  assert.throws(() => playbackBvid(AWEME_ID), ApiError);
  database();
  assert.equal(getCandidateByBvid(`DY${AWEME_ID}`), null);
});
