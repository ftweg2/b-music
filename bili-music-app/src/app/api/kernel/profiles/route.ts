import { NextResponse } from "next/server";

import { readKernelJson } from "@/lib/kernelClient";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

type KernelProfileResponse = {
  profile_id: string;
  external_owner_id: string;
  status: "created" | "exists";
};

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const externalOwnerId = sanitizeText(body.externalOwnerId || body.external_owner_id || "local", 128);
    const payload = await readKernelJson<KernelProfileResponse>("/v1/profiles", {
      method: "POST",
      body: JSON.stringify({ external_owner_id: externalOwnerId })
    });
    return NextResponse.json({
      profileId: payload.profile_id,
      externalOwnerId: payload.external_owner_id,
      status: payload.status
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
