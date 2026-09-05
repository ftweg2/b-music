import { apiEndpoint, apiOptions, ApiError, readJsonObject, queryInteger } from "@/lib/api";
import { candidateReference } from "@/lib/apiInput";
import { optionalString } from "@/lib/api";
import { NextResponse } from "next/server";

import {
  createFavoriteVideo,
  favoriteBvids,
  getCandidateByBvid,
  getCandidateById,
  listFavoriteVideos
} from "@/lib/db";
import { currentAppOwnerId } from "@/lib/appOwner";
import { clampNumber, sanitizeNullableText, sanitizeText } from "@/lib/sanitize";
import { toCandidateItems } from "@/lib/search/cache";

export const runtime = "nodejs";

async function getHandler(request: Request) {
  const ownerId = await currentAppOwnerId();
  const url = new URL(request.url);
  const limit = queryInteger(url.searchParams, "limit", 100, 1, 100);
  const offset = queryInteger(url.searchParams, "offset", 0, 0, 100_000);
  const page = listFavoriteVideos(limit + 1, ownerId, offset);
  const hasMore = page.length > limit;
  const rows = page.slice(0, limit);
  const candidates = rows.map((row) => row.candidate);
  const favorites = favoriteBvids(candidates.map((candidate) => candidate.bvid), ownerId);
  const decorated = new Map(toCandidateItems(candidates, ownerId).map((candidate) => [candidate.id, candidate]));
  const items = rows.map((row) => ({
    favorite: row.favorite,
    candidate: decorated.get(row.candidate.id)!
  }));
  return NextResponse.json({
    ownerId,
    favorites: items.map((item) => item.favorite),
    candidates: items.map((item) => item.candidate),
    items,
    pagination: {
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + items.length : null
    }
  });
}

async function postHandler(request: Request) {
  try {
    const body = await readJsonObject(request);
    const reference = candidateReference(body);
    const candidateId = reference.candidateId ?? NaN;
    optionalString(body, "note", 500); optionalString(body, "mood", 80);
    const ownerId = await currentAppOwnerId();
    const candidate = getCandidateById(candidateId) || getCandidateByBvid(String(body.bvid || ""));
    if (!candidate) {
      return NextResponse.json({ error: "候选视频不存在" }, { status: 404 });
    }
    const favorite = createFavoriteVideo(candidate.id, {
      externalOwnerId: ownerId,
      ...(Object.hasOwn(body, "note") ? { note: sanitizeNullableText(body.note, 500) } : {}),
      ...(Object.hasOwn(body, "mood") ? { mood: sanitizeNullableText(body.mood, 80) } : {})
    });
    const itemCandidate = toCandidateItems([candidate], ownerId)[0];
    return NextResponse.json(
      {
        favorite,
        candidate: itemCandidate,
        item: {
          favorite,
          candidate: itemCandidate
        }
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}

export const GET = apiEndpoint("GET", getHandler);
export const POST = apiEndpoint("POST", postHandler);
export const OPTIONS = apiOptions(["GET","POST"]);
