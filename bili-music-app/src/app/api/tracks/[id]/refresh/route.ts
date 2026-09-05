import { apiEndpoint, apiOptions, ApiError, readJsonObject, positiveId as apiPositiveId } from "@/lib/api";
import { NextResponse } from "next/server";

import { strategyInput } from "@/lib/apiInput";
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

async function postHandler(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const trackId = apiPositiveId(id);
    if (!Number.isSafeInteger(trackId) || trackId <= 0) {
      return NextResponse.json(
        { error: "Track ID 无效", code: "INVALID_TRACK_ID", retryable: false },
        { status: 400 }
      );
    }
    const body = await readJsonObject(request);
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
      ...strategyInput(body)
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
    if (error instanceof ApiError) throw error;
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

export const POST = apiEndpoint("POST", postHandler);
export const OPTIONS = apiOptions(["POST"]);
