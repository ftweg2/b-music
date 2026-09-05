import { apiEndpoint, apiOptions, ApiError } from "@/lib/api";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

const ALLOWED_IMAGE_HOSTS = new Set(["i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/apng"]);

async function getHandler(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    let target: URL;
    try { target = normalizeImageUrl(requestUrl.searchParams.get("url") || ""); }
    catch (error) { throw new ApiError(400, "INVALID_IMAGE_URL", sanitizeText(error)); }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const upstream = await fetch(target.toString(), {
        redirect: "error",
        signal: controller.signal,
        cache: "no-store",
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
          referer: "https://www.bilibili.com/",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        }
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw new ApiError(upstream.status === 404 ? 404 : 502, "IMAGE_UPSTREAM_ERROR", "封面暂时无法读取", upstream.status !== 404);
      }
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      if (!IMAGE_TYPES.has(contentType.split(";")[0].trim().toLowerCase())) {
        await upstream.body?.cancel();
        throw new ApiError(415, "UNSUPPORTED_IMAGE", "封面必须是受支持的位图图片");
      }
      return new Response(upstream.body, {
        headers: {
          "content-type": contentType,
          "cache-control": "public, max-age=3600"
        }
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "IMAGE_UPSTREAM_ERROR", "封面服务暂不可用", true);
  }
}

function normalizeImageUrl(value: string): URL {
  if (!value) {
    throw new Error("缺少封面 URL");
  }
  const url = new URL(value.startsWith("//") ? `https:${value}` : value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("封面 URL 协议不允许");
  }
  if (!ALLOWED_IMAGE_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw new Error("封面 URL 域名不允许");
  }
  if (!url.pathname.startsWith("/bfs/")) {
    throw new Error("封面 URL 路径不允许");
  }
  url.protocol = "https:";
  return url;
}

export const GET = apiEndpoint("GET", getHandler);
export const OPTIONS = apiOptions(["GET"]);
