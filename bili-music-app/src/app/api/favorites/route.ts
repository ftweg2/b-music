import { NextResponse } from "next/server";

import {
  createFavoriteVideo,
  favoriteBvids,
  getCandidateByBvid,
  getCandidateById,
  listFavoriteVideos
} from "@/lib/db";
import { currentAppOwnerId } from "@/lib/appOwner";
import { sanitizeNullableText, sanitizeText } from "@/lib/sanitize";
import { toCandidateWithScore } from "@/lib/search/cache";

export const runtime = "nodejs";

export async function GET() {
  const ownerId = await currentAppOwnerId();
  const rows = listFavoriteVideos(100, ownerId);
  const candidates = rows.map((row) => row.candidate);
  const favorites = favoriteBvids(candidates.map((candidate) => candidate.bvid), ownerId);
  const items = rows.map((row) => ({
    favorite: row.favorite,
    candidate: toCandidateWithScore(row.candidate, undefined, favorites.has(row.candidate.bvid))
  }));
  return NextResponse.json({
    ownerId,
    favorites: items.map((item) => item.favorite),
    candidates: items.map((item) => item.candidate),
    items
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const candidateId = Number(body.candidateId);
    const ownerId = await currentAppOwnerId();
    const candidate = getCandidateById(candidateId) || getCandidateByBvid(String(body.bvid || ""));
    if (!candidate) {
      return NextResponse.json({ error: "候选视频不存在" }, { status: 404 });
    }
    const favorite = createFavoriteVideo(candidate.id, {
      externalOwnerId: ownerId,
      note: sanitizeNullableText(body.note, 500),
      mood: sanitizeNullableText(body.mood, 80)
    });
    const candidateWithScore = toCandidateWithScore(candidate, undefined, true);
    return NextResponse.json(
      {
        favorite,
        candidate: candidateWithScore,
        item: {
          favorite,
          candidate: candidateWithScore
        }
      },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
