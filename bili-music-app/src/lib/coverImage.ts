// Bilibili search returns full-size originals (often 2560×1440, 250–550 KB) while
// the UI shows at most a few hundred pixels. Bilibili's image CDN serves resized
// WebP copies for an `@{w}w_{h}h_1c.webp` suffix (the same one bilibili.com uses),
// typically 20–100× smaller. Other covers, such as the App's Douyin cover route,
// are returned unchanged.

export const COVER_SIZES = {
  card: [440, 400],
  detail: [600, 600],
  playlist: [400, 400],
  player: [120, 120],
} as const;

export type CoverSize = keyof typeof COVER_SIZES;

export function coverThumbnail(url: string | null | undefined, size: CoverSize): string | null {
  if (!url) return null;
  const normalized = url.startsWith("//") ? `https:${url}` : url;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return normalized;
  }
  if (!/^i\d\.hdslb\.com$/.test(parsed.hostname) || !parsed.pathname.startsWith("/bfs/")) return normalized;
  // Already resized, or carrying parameters we should not alter.
  if (parsed.pathname.includes("@") || parsed.search) return normalized;
  const [width, height] = COVER_SIZES[size];
  return `${parsed.origin}${parsed.pathname}@${width}w_${height}h_1c.webp`;
}
