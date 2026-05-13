import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { favoriteBvids, listFavoriteVideos } from "@/lib/db";
import { toCandidateWithScore } from "@/lib/search/cache";

export const runtime = "nodejs";

export async function GET() {
  const ownerId = await currentAppOwnerId();
  const rows = listFavoriteVideos(100, ownerId);
  const candidates = rows.map((row) => row.candidate);
  const favorites = favoriteBvids(candidates.map((candidate) => candidate.bvid), ownerId);

  return NextResponse.json({
    mode: "favorites",
    ownerId,
    candidates: candidates.map((candidate) => toCandidateWithScore(candidate, undefined, favorites.has(candidate.bvid))),
    emptyState: candidates.length ? undefined : "收藏夹还空着。搜索结果里点“收藏”就会加入这里。"
  });
}
