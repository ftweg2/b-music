import { ensureDefaultKernelProfile } from "../kernelSession";
import { KernelRequestError, resolveKernelDouyin, type KernelDouyinItem } from "../kernelClient";
import { assertRateLimit } from "../rateLimit";
import { sanitizeNullableText, sanitizeText } from "../sanitize";
import { douyinCoverPath, douyinRef, sourceUrlForVideoRef } from "../videoRef";
import type { NormalizedCandidate } from "./types";

const HASHTAG = /#[^\s#]+/g;

/** Resolve a pasted Douyin link through the kernel into a candidate. One link per call. */
export async function resolveDouyinCandidate(link: string, ownerId: string, searchKeyword: string): Promise<NormalizedCandidate> {
  assertRateLimit(`app-douyin-resolve:${ownerId}`, 12, 60_000);
  const profile = await ensureDefaultKernelProfile();
  let item: KernelDouyinItem;
  try {
    item = await resolveKernelDouyin({ externalOwnerId: profile.external_owner_id, profileId: profile.profile_id, url: link });
  } catch (error) {
    throw new Error(douyinErrorMessage(error));
  }
  return normalizeDouyinItem(item, searchKeyword);
}

export function normalizeDouyinItem(item: KernelDouyinItem, searchKeyword: string | null): NormalizedCandidate {
  if (!/^\d{15,20}$/.test(item.aweme_id)) throw new Error("内核返回了无效的抖音作品编号");
  const ref = douyinRef(item.aweme_id);
  const fullText = sanitizeText(item.title, 1500);
  const tags = [...new Set(fullText.match(HASHTAG) ?? [])].map((tag) => sanitizeText(tag.slice(1), 80)).filter(Boolean).slice(0, 10);
  const musicTitle = sanitizeNullableText(item.music_title, 200);
  const musicAuthor = sanitizeNullableText(item.music_author, 200);
  const title = sanitizeText(fullText.replace(HASHTAG, " ").replace(/\s+/g, " "), 500)
    || musicTitle
    || `抖音作品 ${item.aweme_id}`;
  const musicLine = musicTitle ? `背景音乐：${musicTitle}${musicAuthor ? ` - ${musicAuthor}` : ""}` : null;
  return {
    bvid: ref,
    aid: null,
    title,
    description: [fullText !== title ? fullText : null, musicLine].filter(Boolean).join("\n") || null,
    // Followed creators are Bilibili UP 主 ids; a Douyin author must never match one.
    creatorMid: null,
    creatorName: sanitizeNullableText(item.creator_name, 300),
    // The kernel keeps the cover; the App serves it by reference, never a signed Douyin URL.
    coverUrl: item.has_cover ? douyinCoverPath(ref) : null,
    durationSeconds: typeof item.duration_seconds === "number" && item.duration_seconds > 0 ? Math.round(item.duration_seconds) : null,
    pubTime: null,
    sourceUrl: sourceUrlForVideoRef(ref),
    category: "抖音",
    tags,
    searchKeyword: searchKeyword ? sanitizeText(searchKeyword, 200) : null,
    sourceProvider: "douyin_url",
  };
}

function douyinErrorMessage(error: unknown): string {
  if (error instanceof KernelRequestError) {
    if (error.status === 404) return "这个抖音作品不存在、已删除或仅作者可见";
    if (error.status === 400) return "没能识别这个抖音链接，请复制作品的分享链接后重试";
    if (error.status === 504) return "抖音页面响应超时，请稍后重试";
    if (error.status === 503) return "正在处理其他抖音链接，请几秒后重试";
    if (error.status === null) return "暂时无法连接音频内核，请确认内核已启动";
  }
  return `暂时无法读取这个抖音作品：${sanitizeText(error instanceof Error ? error.message : error, 300)}`;
}
