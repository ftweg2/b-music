import { apiEndpoint, apiOptions, ApiError, readJsonObject, positiveId as apiPositiveId } from "@/lib/api";
import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { DEFAULT_TRACK_POLL_AFTER_MS, MAX_TRACK_STATUS_BATCH } from "@/lib/apiCapabilities";
import { getSyncedTracks } from "@/lib/tracks";
import { toTrackApiResources } from "@/lib/trackApi";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

async function postHandler(request: Request) {
  try {
    const body = await readJsonObject(request);
    const trackIds = normalizeTrackIds(body.trackIds ?? body.track_ids);
    if (!trackIds.length) {
      return NextResponse.json(
        { error: "请提供 trackIds", code: "TRACK_IDS_REQUIRED" },
        { status: 400 }
      );
    }
    if (trackIds.length > MAX_TRACK_STATUS_BATCH) {
      return NextResponse.json(
        {
          error: `一次最多查询 ${MAX_TRACK_STATUS_BATCH} 个 Track`,
          code: "TRACK_BATCH_TOO_LARGE",
          maxItems: MAX_TRACK_STATUS_BATCH
        },
        { status: 413 }
      );
    }

    const ownerId = await currentAppOwnerId();
    const synced = await getSyncedTracks(trackIds, ownerId);
    const tracks = toTrackApiResources(synced.filter((track) => track !== null));
    const foundIds = new Set(tracks.map((track) => track.id));
    const missingTrackIds = trackIds.filter((trackId) => !foundIds.has(trackId));
    const stillPreparing = tracks.some((track) => track.status === "preparing");
    return NextResponse.json(
      {
        tracks,
        missingTrackIds,
        pollAfterMs: stillPreparing ? DEFAULT_TRACK_POLL_AFTER_MS : null
      },
      {
        headers: stillPreparing ? { "retry-after": "2" } : undefined
      }
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return NextResponse.json(
      { error: sanitizeText(error), code: "INVALID_REQUEST" },
      { status: 400 }
    );
  }
}

function normalizeTrackIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((value, index) => apiPositiveId(value, `trackIds[${index}]`))
    )
  );
}

export const POST = apiEndpoint("POST", postHandler);
export const OPTIONS = apiOptions(["POST"]);
