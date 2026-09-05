import { kernelBaseUrl, KernelRequestError } from "../kernelClient";
import { sanitizeText } from "../sanitize";
import type { RawSearchResult, SearchOptions, SearchProvider } from "./types";
import { validTotalPages } from "./pagination";

type KernelSearchResult = {
  bvid?: string;
  aid?: string | number | null;
  title?: string;
  description?: string | null;
  creator_mid?: string | null;
  creator_name?: string | null;
  cover_url?: string | null;
  duration_seconds?: number | null;
  pub_time?: string | number | null;
  source_url?: string | null;
  category?: string | null;
  tags?: string[];
};

type KernelSearchResponse = {
  provider?: string;
  logged_in?: boolean;
  results?: KernelSearchResult[];
  has_next_page?: boolean;
  total_pages?: number;
  detail?: string;
  error?: string;
};

export const kernelProvider: SearchProvider = {
  name: "kernel",
  maxPageSize: 20,
  searchPage: searchKernelPage,
  async searchVideos(keyword, options) { return (await searchKernelPage(keyword, options)).results; }
};
async function searchKernelPage(keyword: string, options: SearchOptions) {
    const externalOwnerId = options.externalOwnerId || process.env.KERNEL_EXTERNAL_OWNER_ID || "local";
    const profileId = options.profileId || process.env.KERNEL_PROFILE_ID || "";
    if (!profileId) {
      throw new Error("请先填写 kernel profile_id，才能使用内核登录态搜索");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(`${kernelBaseUrl()}/v1/search/videos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          external_owner_id: externalOwnerId,
          profile_id: profileId,
          keyword,
          limit: options.limit,
          page: options.page,
          timeout_seconds: Math.min(30, Math.max(1, options.timeoutMs / 1000 - 1))
        })
      });
      const payload = (await response.json()) as KernelSearchResponse;
      if (!response.ok) {
        throw new KernelRequestError(typeof payload.detail === "string" ? payload.detail : payload.error || `内核搜索失败：HTTP ${response.status}`, response.status, response.status >= 500 || response.status === 429 || response.headers.has("retry-after"), false, Number(response.headers.get("retry-after")) > 0 ? Number(response.headers.get("retry-after")) : undefined);
      }
      if (!Array.isArray(payload.results)) throw new Error("内核搜索返回了无效数据");
      return { results: payload.results.map(mapKernelResult).filter((item) => item.bvid),
        hasNextPage: payload.has_next_page ?? payload.results.length >= options.limit,
        totalPages: validTotalPages(payload.total_pages, payload.results.length) };
    } catch (error) {
      if (error instanceof KernelRequestError) throw error;
      throw new Error(`内核登录态搜索失败：${sanitizeText(error instanceof Error ? error.message : error)}`);
    } finally {
      clearTimeout(timeout);
    }
}

function mapKernelResult(item: KernelSearchResult): RawSearchResult {
  return {
    bvid: item.bvid || "",
    aid: item.aid ?? null,
    title: item.title || item.bvid || "未命名视频",
    description: item.description ?? null,
    creatorMid: item.creator_mid ?? null,
    creatorName: item.creator_name ?? null,
    coverUrl: item.cover_url ?? null,
    durationSeconds: item.duration_seconds ?? null,
    pubTime: item.pub_time ?? null,
    sourceUrl: item.source_url ?? null,
    category: item.category ?? null,
    tags: item.tags || []
  };
}
