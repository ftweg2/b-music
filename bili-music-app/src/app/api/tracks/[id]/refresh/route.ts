import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { getTrackById } from "@/lib/db";
import { KernelRequestError } from "@/lib/kernelClient";
import { ensureDefaultKernelProfile } from "@/lib/kernelSession";
import { refreshTrack } from "@/lib/tracks";
import { toTrackApiResource } from "@/lib/trackApi";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const trackId = Number(id);
    if (!Number.isSafeInteger(trackId) || trackId <= 0) {
      return NextResponse.json(
        { error: "Track ID 无效", code: "INVALID_TRACK_ID", retryable: false },
        { status: 400 }
      );
    }
    const body = await request.json();
    const appOwnerId = await currentAppOwnerId();
    if (!getTrackById(trackId, appOwnerId)) {
      return NextResponse.json(
        { error: "Track 不存在", code: "TRACK_NOT_FOUND", retryable: false },
        { status: 404 }
      );
    }
    const profile = await ensureDefaultKernelProfile();
    const track = await refreshTrack(trackId, {
      appOwnerId,
      profileId: profile.profile_id,
      externalOwnerId: profile.external_owner_id,
      strategyMode: body.strategyMode || body.strategy_mode,
      strategy: body.strategy,
      strategyOrder: body.strategyOrder || body.strategy_order
    });
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
  } catch (error) {
    if (error instanceof KernelRequestError) {
      return NextResponse.json(
        { error: sanitizeText(error), code: "KERNEL_UNAVAILABLE", retryable: error.retryable },
        { status: 502, headers: error.retryable ? { "retry-after": "2" } : undefined }
      );
    }
    return NextResponse.json(
      { error: sanitizeText(error), code: "INVALID_REFRESH_REQUEST", retryable: false },
      { status: 400 }
    );
  }
}
