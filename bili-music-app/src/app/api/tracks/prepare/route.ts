import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { KernelRequestError } from "@/lib/kernelClient";
import { ensureDefaultKernelProfile } from "@/lib/kernelSession";
import { getReusablePreparedTrack, prepareTrack } from "@/lib/tracks";
import { toTrackApiResource } from "@/lib/trackApi";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const appOwnerId = await currentAppOwnerId();
    const prepareInput = {
      candidateId: Number(body.candidateId),
      bvid: body.bvid,
      appOwnerId,
      strategyMode: body.strategyMode || body.strategy_mode,
      strategy: body.strategy,
      strategyOrder: body.strategyOrder || body.strategy_order
    };
    const reusable = getReusablePreparedTrack(prepareInput);
    if (reusable) {
      return trackResponse(reusable);
    }
    const profile = await ensureDefaultKernelProfile();
    const track = await prepareTrack({
      ...prepareInput,
      profileId: profile.profile_id,
      externalOwnerId: profile.external_owner_id
    });
    return trackResponse(track);
  } catch (error) {
    if (error instanceof KernelRequestError) {
      return NextResponse.json(
        { error: sanitizeText(error), code: "KERNEL_UNAVAILABLE", retryable: error.retryable },
        { status: 502, headers: error.retryable ? { "retry-after": "2" } : undefined }
      );
    }
    return NextResponse.json(
      { error: sanitizeText(error), code: "INVALID_PREPARE_REQUEST", retryable: false },
      { status: 400 }
    );
  }
}

function trackResponse(track: Parameters<typeof toTrackApiResource>[0]) {
  return NextResponse.json(
    {
      track: toTrackApiResource(track),
      pollAfterMs: track.status === "preparing" ? 1500 : null
    },
    {
      headers: {
        location: `/api/tracks/${track.id}`,
        ...(track.status === "preparing" ? { "retry-after": "2" } : {})
      }
    }
  );
}
