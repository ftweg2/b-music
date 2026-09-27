import { apiEndpoint, apiOptions, ApiError } from "@/lib/api";
import { fetchKernelDouyinCover } from "@/lib/kernelClient";
import { defaultKernelExternalOwnerId } from "@/lib/kernelSession";
import { douyinAwemeId, isVideoRef } from "@/lib/videoRef";

export const runtime = "nodejs";
type Context = { params: Promise<{ bvid: string }> };

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// Douyin covers are cached by the kernel when a link is resolved; the App only
// streams them. Bilibili candidates keep their public hdslb.com cover URLs.
export const GET = apiEndpoint("GET", async (_request: Request, context: Context) => {
  const ref = (await context.params).bvid;
  const awemeId = isVideoRef(ref) ? douyinAwemeId(ref) : null;
  if (!awemeId) throw new ApiError(404, "COVER_NOT_FOUND", "只有抖音作品使用这个封面地址");
  let upstream: Response;
  try {
    upstream = await fetchKernelDouyinCover(awemeId, defaultKernelExternalOwnerId());
  } catch {
    throw new ApiError(502, "IMAGE_UPSTREAM_ERROR", "封面服务暂不可用", true);
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw upstream.status === 404
      ? new ApiError(404, "COVER_NOT_FOUND", "这个作品没有封面")
      : new ApiError(502, "IMAGE_UPSTREAM_ERROR", "封面暂时无法读取", true);
  }
  const contentType = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) {
    await upstream.body?.cancel();
    throw new ApiError(502, "UNSUPPORTED_IMAGE", "封面必须是受支持的位图图片");
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
});
export const OPTIONS = apiOptions(["GET"]);
