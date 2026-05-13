import { NextResponse } from "next/server";

import { setAppOwnerCookies } from "@/lib/appOwner";
import { getDefaultKernelLoginStatus } from "@/lib/kernelSession";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

export async function GET() {
  try {
    const payload = await getDefaultKernelLoginStatus();
    const response = NextResponse.json(payload);
    if (payload.loggedIn) {
      setAppOwnerCookies(response, { biliUid: payload.biliUid, nickname: payload.nickname });
    }
    return response;
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
