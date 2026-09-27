// A candidate's `bvid` field is its source video reference: a Bilibili BV id, or
// "DY" followed by a Douyin item id. Favorites, playlists, playback ranges and
// tracks are keyed by this value, so they work for both sources unchanged.

export type VideoSource = "bilibili" | "douyin";

const BILIBILI_REF = /^BV[0-9A-Za-z]{10}$/;
const DOUYIN_REF = /^DY(\d{15,20})$/;

export const VIDEO_REF_PATTERN = "^(BV[0-9A-Za-z]{10}|DY[0-9]{15,20})$";

export function isVideoRef(value: unknown): value is string {
  return typeof value === "string" && (BILIBILI_REF.test(value) || DOUYIN_REF.test(value));
}

export function videoSource(ref: string): VideoSource {
  return DOUYIN_REF.test(ref) ? "douyin" : "bilibili";
}

export function douyinRef(awemeId: string): string {
  return `DY${awemeId}`;
}

export function douyinAwemeId(ref: string): string | null {
  return DOUYIN_REF.exec(ref)?.[1] ?? null;
}

/** App-relative cover address for a Douyin reference; the kernel holds the image. */
export function douyinCoverPath(ref: string): string {
  return `/api/covers/${ref}`;
}

export function isAppCoverPath(value: string): boolean {
  return /^\/api\/covers\/DY\d{15,20}$/.test(value);
}

export function sourceUrlForVideoRef(ref: string): string {
  const awemeId = douyinAwemeId(ref);
  return awemeId ? `https://www.douyin.com/video/${awemeId}` : `https://www.bilibili.com/video/${ref}`;
}

export function watchOnSourceLabel(ref: string): string {
  return videoSource(ref) === "douyin" ? "在抖音观看" : "在 B 站观看";
}

export function unknownCreatorLabel(ref: string): string {
  return videoSource(ref) === "douyin" ? "未知作者" : "未知 UP 主";
}

/** An exact Douyin reference, or the first BV id found anywhere in the text. */
export function sanitizeVideoRef(value: unknown): string {
  const text = String(value ?? "").trim();
  if (DOUYIN_REF.test(text)) return text;
  return text.match(/BV[0-9A-Za-z]{10}/)?.[0] ?? "";
}
