import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { favoriteBvids, listCandidates } from "@/lib/db";
import { clampNumber } from "@/lib/sanitize";
import { toCandidateWithScore } from "@/lib/search/cache";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const ownerId = await currentAppOwnerId();
  const url = new URL(request.url);
  const limit = Math.round(clampNumber(url.searchParams.get("limit"), 1, 100, 100));
  const offset = Math.round(clampNumber(url.searchParams.get("offset"), 0, 100_000, 0));
  const page = listCandidates(limit + 1, offset);
  const hasMore = page.length > limit;
  const candidates = page.slice(0, limit);
  const favorites = favoriteBvids(candidates.map((candidate) => candidate.bvid), ownerId);
  return NextResponse.json({
    ownerId,
    candidates: candidates.map((candidate) => toCandidateWithScore(candidate, undefined, favorites.has(candidate.bvid))),
    pagination: {
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + candidates.length : null
    }
  });
}
