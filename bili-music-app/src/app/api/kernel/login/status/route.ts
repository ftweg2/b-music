import { apiEndpoint, apiOptions, ApiError } from "@/lib/api";
import { NextResponse } from "next/server";

import { clearAppOwnerCookies, setAppOwnerCookies } from "@/lib/appOwner";
import { getDefaultKernelLoginStatus } from "@/lib/kernelSession";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

async function getHandler() {
  try {
    const payload = await getDefaultKernelLoginStatus();
    const response = NextResponse.json(payload);
    if (payload.loggedIn) {
      setAppOwnerCookies(response, { biliUid: payload.biliUid, nickname: payload.nickname });
    } else {
      clearAppOwnerCookies(response);
    }
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}

export const GET = apiEndpoint("GET", getHandler);
export const OPTIONS = apiOptions(["GET"]);
