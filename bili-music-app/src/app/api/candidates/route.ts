import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { favoriteBvids, listCandidates } from "@/lib/db";
import { toCandidateWithScore } from "@/lib/search/cache";

export const runtime = "nodejs";

export async function GET() {
  const ownerId = await currentAppOwnerId();
  const candidates = listCandidates(100);
  const favorites = favoriteBvids(candidates.map((candidate) => candidate.bvid), ownerId);
  return NextResponse.json({
    ownerId,
    candidates: candidates.map((candidate) => toCandidateWithScore(candidate, undefined, favorites.has(candidate.bvid)))
  });
}
