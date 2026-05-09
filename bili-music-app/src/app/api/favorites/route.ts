import { NextResponse } from "next/server";

import {
  createFavoriteVideo,
  favoriteCandidateIds,
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
  const favorites = favoriteCandidateIds(candidates.map((candidate) => candidate.id), ownerId);
  return NextResponse.json({
    ownerId,
    favorites: rows.map((row) => row.favorite),
    candidates: candidates.map((candidate) => toCandidateWithScore(candidate, undefined, favorites.has(candidate.id)))
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const candidateId = Number(body.candidateId);
    const ownerId = await currentAppOwnerId();
    const candidate = getCandidateById(candidateId);
    if (!candidate) {
      return NextResponse.json({ error: "候选视频不存在" }, { status: 404 });
    }
    const favorite = createFavoriteVideo(candidate.id, {
      externalOwnerId: ownerId,
      note: sanitizeNullableText(body.note, 500),
      mood: sanitizeNullableText(body.mood, 80)
    });
    return NextResponse.json(
      {
        favorite,
        candidate: toCandidateWithScore(candidate, undefined, true)
      },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
