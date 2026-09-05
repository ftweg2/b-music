import { apiEndpoint, apiOptions, ApiError } from "@/lib/api";
import { NextResponse } from "next/server";

import { startDefaultKernelLogin } from "@/lib/kernelSession";
import { assertAccountContext } from "@/lib/appOwner";
import { loginErrorResponse } from "@/lib/loginApi";

export const runtime = "nodejs";

async function postHandler(request: Request) {
  try {
    await assertAccountContext();
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
    if (error instanceof ApiError) throw error;
    return loginErrorResponse(error);
  }
}

export const POST = apiEndpoint("POST", postHandler);
export const OPTIONS = apiOptions(["POST"]);
