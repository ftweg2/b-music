import { kernelBaseUrl } from "@/lib/kernelClient";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const profileId = sanitizeText(url.searchParams.get("profileId") || "", 80);
    const loginSessionId = sanitizeText(url.searchParams.get("loginSessionId") || "", 80);
    const externalOwnerId = sanitizeText(url.searchParams.get("externalOwnerId") || "", 128);
    if (!profileId || !loginSessionId || !externalOwnerId) {
      return Response.json({ error: "二维码参数不完整" }, { status: 400 });
    }
    const upstream = await fetch(
      `${kernelBaseUrl()}/v1/profiles/${encodeURIComponent(profileId)}/login/${encodeURIComponent(
        loginSessionId
      )}/qr.png?external_owner_id=${encodeURIComponent(externalOwnerId)}`,
      { cache: "no-store" }
    );
    if (!upstream.ok) {
      return Response.json({ error: `二维码暂不可用：HTTP ${upstream.status}` }, { status: upstream.status });
    }
    return new Response(await upstream.arrayBuffer(), {
      headers: {
        "content-type": upstream.headers.get("content-type") || "image/png",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return Response.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
