import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { favoriteCandidateIds, listFavoriteVideos } from "@/lib/db";
import { toCandidateWithScore } from "@/lib/search/cache";

export const runtime = "nodejs";

export async function GET() {
  const ownerId = await currentAppOwnerId();
  const rows = listFavoriteVideos(100, ownerId);
  const candidates = rows.map((row) => row.candidate);
  const favorites = favoriteCandidateIds(candidates.map((candidate) => candidate.id), ownerId);

  return NextResponse.json({
    mode: "favorites",
    ownerId,
    candidates: candidates.map((candidate) => toCandidateWithScore(candidate, undefined, favorites.has(candidate.id))),
    emptyState: candidates.length ? undefined : "收藏夹还空着。搜索结果里点“收藏”就会加入这里。"
  });
}
