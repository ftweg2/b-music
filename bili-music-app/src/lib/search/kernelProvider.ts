import { kernelBaseUrl } from "../kernelClient";
import { sanitizeText } from "../sanitize";
import type { RawSearchResult, SearchOptions, SearchProvider } from "./types";

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
  detail?: string;
  error?: string;
};

export const kernelProvider: SearchProvider = {
  name: "kernel",
  async searchVideos(keyword: string, options: SearchOptions): Promise<RawSearchResult[]> {
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
          page: options.page
        })
      });
      const payload = (await response.json()) as KernelSearchResponse;
      if (!response.ok) {
        throw new Error(payload.detail || payload.error || `内核搜索失败：HTTP ${response.status}`);
      }
      return (payload.results || []).map(mapKernelResult).filter((item) => item.bvid);
    } catch (error) {
      throw new Error(`内核登录态搜索失败：${sanitizeText(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
};

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
