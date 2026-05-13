import { NextResponse } from "next/server";

import { startDefaultKernelLogin } from "@/lib/kernelSession";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

export async function POST() {
  try {
    const payload = await startDefaultKernelLogin();
    return NextResponse.json({
      loginSessionId: payload.loginSessionId,
      status: payload.status,
      message: payload.message,
      qrImageUrl: `/api/kernel/login/qr?profileId=${encodeURIComponent(payload.profileId)}&loginSessionId=${encodeURIComponent(
        payload.loginSessionId
      )}&externalOwnerId=${encodeURIComponent(payload.externalOwnerId)}`,
      qrImageSha256: payload.qrImageSha256,
      expiresInSeconds: payload.expiresInSeconds
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
