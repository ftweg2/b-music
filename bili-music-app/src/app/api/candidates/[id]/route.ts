import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { addCandidateInteraction, favoriteBvids, getCandidateById, listCandidateInteractions } from "@/lib/db";
import type { InteractionAction } from "@/lib/models";
import { sanitizeText } from "@/lib/sanitize";
import { toCandidateWithScore } from "@/lib/search/cache";

export const runtime = "nodejs";

const ACTIONS = new Set<InteractionAction>(["viewed", "liked", "disliked", "skipped", "queued", "extraction_failed"]);

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const candidate = getCandidateById(Number(id));
  if (!candidate) {
    return NextResponse.json({ error: "候选视频不存在" }, { status: 404 });
  }
  const ownerId = await currentAppOwnerId();
  return NextResponse.json({
    ownerId,
    candidate: toCandidateWithScore(candidate, undefined, favoriteBvids([candidate.bvid], ownerId).has(candidate.bvid)),
    interactions: listCandidateInteractions(candidate.id, ownerId)
  });
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const candidate = getCandidateById(Number(id));
    if (!candidate) {
      return NextResponse.json({ error: "候选视频不存在" }, { status: 404 });
    }
    const body = await request.json();
    const action = String(body.action || "") as InteractionAction;
    if (!ACTIONS.has(action)) {
      return NextResponse.json({ error: "不支持这个互动动作" }, { status: 400 });
    }
    const ownerId = await currentAppOwnerId();
    return NextResponse.json({ interaction: addCandidateInteraction(candidate.id, action, ownerId) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
