import { NextResponse } from "next/server";

import { readKernelJson } from "@/lib/kernelClient";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

type KernelLoginStartResponse = {
  login_session_id: string;
  status: "pending";
  message: string;
  qr_image_url?: string | null;
  qr_image_sha256?: string | null;
  expires_in_seconds?: number | null;
};

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const externalOwnerId = sanitizeText(body.externalOwnerId || body.external_owner_id || "", 128);
    const profileId = sanitizeText(body.profileId || body.profile_id || "", 80);
    if (!externalOwnerId || !profileId) {
      throw new Error("请先填写 external_owner_id 和 profile_id");
    }
    const payload = await readKernelJson<KernelLoginStartResponse>(`/v1/profiles/${encodeURIComponent(profileId)}/login/start`, {
      method: "POST",
      body: JSON.stringify({ external_owner_id: externalOwnerId })
    });
    const qrImageUrl = payload.login_session_id
      ? `/api/kernel/login/qr?profileId=${encodeURIComponent(profileId)}&loginSessionId=${encodeURIComponent(
          payload.login_session_id
        )}&externalOwnerId=${encodeURIComponent(externalOwnerId)}`
      : null;
    return NextResponse.json({
      loginSessionId: payload.login_session_id,
      status: payload.status,
      message: payload.message,
      qrImageUrl,
      qrImageSha256: payload.qr_image_sha256,
      expiresInSeconds: payload.expires_in_seconds
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
