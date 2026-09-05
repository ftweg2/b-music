import { apiEndpoint, apiOptions, ApiError, queryInteger } from "@/lib/api";
import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { favoriteBvids, listCandidates } from "@/lib/db";
import { clampNumber } from "@/lib/sanitize";
import { toCandidateItems } from "@/lib/search/cache";

export const runtime = "nodejs";

async function getHandler(request: Request) {
  const ownerId = await currentAppOwnerId();
  const url = new URL(request.url);
  const limit = queryInteger(url.searchParams, "limit", 100, 1, 100);
  const offset = queryInteger(url.searchParams, "offset", 0, 0, 100_000);
  const page = listCandidates(limit + 1, offset);
  const hasMore = page.length > limit;
  const candidates = page.slice(0, limit);
  const favorites = favoriteBvids(candidates.map((candidate) => candidate.bvid), ownerId);
  return NextResponse.json({
    ownerId,
    candidates: toCandidateItems(candidates, ownerId),
    pagination: {
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + candidates.length : null
    }
  });
}

export const GET = apiEndpoint("GET", getHandler);
export const OPTIONS = apiOptions(["GET"]);
