import { apiEndpoint, apiOptions, ApiError } from "@/lib/api";
import { ensureDefaultKernelProfile } from "@/lib/kernelSession";
import { kernelBaseUrl } from "@/lib/kernelClient";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

async function getHandler(request: Request) {
  try {
    const url = new URL(request.url);
    const profileId = sanitizeText(url.searchParams.get("profileId") || "", 80);
    const loginSessionId = sanitizeText(url.searchParams.get("loginSessionId") || "", 80);
    const externalOwnerId = sanitizeText(url.searchParams.get("externalOwnerId") || "", 128);
    if (!/^ls_[A-Za-z0-9]+$/.test(loginSessionId)) throw new ApiError(400, "INVALID_LOGIN_SESSION", "二维码会话 ID 无效");
    const profile = await ensureDefaultKernelProfile();
    if (profileId !== profile.profile_id || (externalOwnerId && externalOwnerId !== profile.external_owner_id)) {
      throw new ApiError(404, "LOGIN_QR_NOT_FOUND", "二维码不存在或不属于当前音乐库");
    }
    const upstream = await fetch(
      `${kernelBaseUrl()}/v1/profiles/${encodeURIComponent(profileId)}/login/${encodeURIComponent(
        loginSessionId
      )}/qr.png?external_owner_id=${encodeURIComponent(profile.external_owner_id)}`,
      { cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) }
    );
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return Response.json({ error: `二维码暂不可用：HTTP ${upstream.status}`, code: "LOGIN_QR_UNAVAILABLE" }, { status: upstream.status });
    }
    if (!(upstream.headers.get("content-type") || "").startsWith("image/")) { await upstream.body?.cancel(); throw new ApiError(502, "INVALID_QR_RESPONSE", "内核未返回二维码图片", true); }
    return new Response(upstream.body, {
      headers: {
        "content-type": upstream.headers.get("content-type") || "image/png",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "LOGIN_QR_UNAVAILABLE", "暂时无法连接二维码服务", true);
  }
}

export const GET = apiEndpoint("GET", getHandler);
export const OPTIONS = apiOptions(["GET"]);
