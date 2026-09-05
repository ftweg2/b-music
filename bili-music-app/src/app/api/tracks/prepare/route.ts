import { apiEndpoint, apiOptions, ApiError, readJsonObject } from "@/lib/api";
import { NextResponse } from "next/server";

import { candidateReference, strategyInput } from "@/lib/apiInput";
import { currentAppOwnerId } from "@/lib/appOwner";
import { KernelRequestError } from "@/lib/kernelClient";
import { ensureDefaultKernelProfile } from "@/lib/kernelSession";
import { getReusablePreparedTrack, prepareTrack } from "@/lib/tracks";
import { toTrackApiResource } from "@/lib/trackApi";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

async function postHandler(request: Request) {
  try {
    const body = await readJsonObject(request);
    const appOwnerId = await currentAppOwnerId();
    const prepareInput = {
      ...candidateReference(body),
      ...strategyInput(body),
      appOwnerId
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
    if (error instanceof ApiError) throw error;
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

export const POST = apiEndpoint("POST", postHandler);
export const OPTIONS = apiOptions(["POST"]);
