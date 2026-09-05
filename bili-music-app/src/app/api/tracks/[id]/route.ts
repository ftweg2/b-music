import { apiEndpoint, apiOptions, ApiError, positiveId as apiPositiveId } from "@/lib/api";
import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { getSyncedTrack } from "@/lib/tracks";
import { toTrackApiResource } from "@/lib/trackApi";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

async function getHandler(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const track = await getSyncedTrack(apiPositiveId(id), await currentAppOwnerId());
    if (!track) {
      return NextResponse.json({ error: "Track 不存在" }, { status: 404 });
    }
    return NextResponse.json(
      {
        track: toTrackApiResource(track),
        pollAfterMs: track.status === "preparing" ? 1500 : null
      },
      {
        headers: track.status === "preparing" ? { "retry-after": "2" } : undefined
      }
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}

export const GET = apiEndpoint("GET", getHandler);
export const OPTIONS = apiOptions(["GET"]);
