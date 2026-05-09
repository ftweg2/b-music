import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

const ALLOWED_IMAGE_HOSTS = new Set(["i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com"]);

export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const target = normalizeImageUrl(requestUrl.searchParams.get("url") || "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const upstream = await fetch(target.toString(), {
        signal: controller.signal,
        cache: "no-store",
        headers: {
          accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          referer: "https://www.bilibili.com/",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        }
      });
      if (!upstream.ok) {
        return Response.json({ error: `封面代理失败：HTTP ${upstream.status}` }, { status: upstream.status });
      }
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      if (!contentType.toLowerCase().startsWith("image/")) {
        return Response.json({ error: "目标不是图片资源" }, { status: 400 });
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
    return Response.json({ error: sanitizeText(error) }, { status: 400 });
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
  if (!ALLOWED_IMAGE_HOSTS.has(url.hostname)) {
    throw new Error("封面 URL 域名不允许");
  }
  if (!url.pathname.startsWith("/bfs/")) {
    throw new Error("封面 URL 路径不允许");
  }
  return url;
}
