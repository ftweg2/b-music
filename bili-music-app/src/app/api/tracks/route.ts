import { apiEndpoint, apiOptions, ApiError, queryInteger } from "@/lib/api";
import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { listTracks, markExpiredReadyTracks } from "@/lib/db";
import type { TrackStatus } from "@/lib/models";
import { clampNumber } from "@/lib/sanitize";
import { getSyncedTracks } from "@/lib/tracks";
import { toTrackApiResources } from "@/lib/trackApi";

export const runtime = "nodejs";

const TRACK_STATUSES = new Set<TrackStatus>(["pending", "preparing", "ready", "expired", "failed"]);

async function getHandler(request: Request) {
  const url = new URL(request.url);
  const limit = queryInteger(url.searchParams, "limit", 50, 1, 100);
  const offset = queryInteger(url.searchParams, "offset", 0, 0, 100_000);
  const statusValue = url.searchParams.get("status") as TrackStatus | null;
  if (statusValue && !TRACK_STATUSES.has(statusValue)) {
    return NextResponse.json(
      { error: "不支持的 Track 状态", code: "INVALID_TRACK_STATUS" },
      { status: 400 }
    );
  }
  const ownerId = await currentAppOwnerId();
  markExpiredReadyTracks();
  const page = listTracks(limit + 1, ownerId, offset, statusValue || undefined);
  const hasMore = page.length > limit;
  const listed = page.slice(0, limit);
  const preparing = listed.filter((track) => track.status === "preparing").slice(0, 20);
  const syncedPreparing = await getSyncedTracks(preparing.map((track) => track.id), ownerId);
  const syncedById = new Map(syncedPreparing.filter((track) => track !== null).map((track) => [track.id, track]));
  const tracks = toTrackApiResources(listed.map((track) => syncedById.get(track.id) || track));
  return NextResponse.json({
    tracks,
    pagination: {
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + tracks.length : null
    }
  });
}

export const GET = apiEndpoint("GET", getHandler);
export const OPTIONS = apiOptions(["GET"]);
