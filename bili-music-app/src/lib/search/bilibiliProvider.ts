import { assertRateLimit } from "../rateLimit";
import { sanitizeBvid, sanitizeMid, sanitizeNullableText, sanitizeText, sanitizeUrl } from "../sanitize";
import type { RawSearchResult, SearchOptions, SearchProvider } from "./types";

type BilibiliSearchPayload = {
  data?: {
    result?: Array<Record<string, unknown>>;
  };
  message?: string;
};

export const bilibiliProvider: SearchProvider = {
  name: "bilibili",
  supportsConcurrentSearch: true,
  async searchVideos(keyword: string, options: SearchOptions): Promise<RawSearchResult[]> {
    assertRateLimit("bilibili-search", 6, 60_000);
    const limit = Math.min(options.limit, Number(process.env.BILIBILI_SEARCH_LIMIT || 20), 20);
    const page = Math.max(1, Math.min(Math.round(options.page || 1), 10));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const url = new URL("https://api.bilibili.com/x/web-interface/search/type");
      url.searchParams.set("search_type", "video");
      url.searchParams.set("keyword", keyword);
      url.searchParams.set("page", String(page));
      url.searchParams.set("page_size", String(limit));

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "bili-music-app metadata search",
          "accept": "application/json"
        },
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`Bilibili 搜索源 HTTP ${response.status}`);
      }
      const payload = (await response.json()) as BilibiliSearchPayload;
      const results = payload.data?.result;
      if (!Array.isArray(results)) {
        throw new Error(`Bilibili 搜索源没有返回视频结果：${sanitizeText(payload.message)}`);
      }
      return results.map(normalizeBilibiliResult).filter((item) => item.bvid).slice(0, limit);
    } catch (error) {
      throw new Error(`Bilibili 搜索源失败：${sanitizeText(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
};

function normalizeBilibiliResult(item: Record<string, unknown>): RawSearchResult {
  const bvid = sanitizeBvid(item.bvid ?? item.arcurl);
  const creatorMid = sanitizeMid(item.mid ?? item.upic);
  return {
    bvid,
    aid: item.aid ? String(item.aid) : null,
    title: stripHtml(sanitizeText(item.title)),
    description: sanitizeNullableText(item.description, 1000),
    creatorMid,
    creatorName: sanitizeNullableText(item.author, 200),
    coverUrl: sanitizeUrl(String(item.pic ?? "")),
    durationSeconds: parseDuration(item.duration),
    pubTime: parsePubTime(item.pubdate),
    sourceUrl: bvid ? `https://www.bilibili.com/video/${bvid}` : sanitizeUrl(String(item.arcurl ?? "")),
    category: sanitizeNullableText(item.typename, 200),
    tags: []
  };
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").trim();
}

function parseDuration(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  const text = String(value ?? "");
  const parts = text.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function parsePubTime(value: unknown): string | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return new Date(num * 1000).toISOString();
}
