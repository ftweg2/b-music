import { NextResponse } from "next/server";

import { appOwnerIdFromBiliUid, setAppOwnerCookies } from "@/lib/appOwner";
import { readKernelJson } from "@/lib/kernelClient";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

type KernelLoginStatusResponse = {
  profile_id: string;
  logged_in: boolean;
  bili_uid?: string | null;
  nickname?: string | null;
  last_verified_at?: string | null;
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const profileId = sanitizeText(url.searchParams.get("profileId") || "", 80);
    const externalOwnerId = sanitizeText(url.searchParams.get("externalOwnerId") || "", 128);
    if (!profileId || !externalOwnerId) {
      throw new Error("请先填写 external_owner_id 和 profile_id");
    }
    const payload = await readKernelJson<KernelLoginStatusResponse>(
      `/v1/profiles/${encodeURIComponent(profileId)}/login/status?external_owner_id=${encodeURIComponent(externalOwnerId)}`
    );
    const response = NextResponse.json({
      profileId: payload.profile_id,
      loggedIn: payload.logged_in,
      biliUid: payload.bili_uid,
      nickname: payload.nickname,
      lastVerifiedAt: payload.last_verified_at,
      appOwnerId: payload.logged_in ? appOwnerIdFromBiliUid(payload.bili_uid) : "local"
    });
    if (payload.logged_in) {
      setAppOwnerCookies(response, { biliUid: payload.bili_uid, nickname: payload.nickname });
    }
    return response;
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
