import { apiEndpoint, apiOptions, ApiError, readJsonObject, positiveId as apiPositiveId } from "@/lib/api";
import { NextResponse } from "next/server";

import { recordInteraction } from "@/lib/interactions";
import { currentAppOwnerId } from "@/lib/appOwner";
import { addCandidateInteraction, favoriteBvids, getCandidateById, listCandidateInteractions } from "@/lib/db";
import type { InteractionAction } from "@/lib/models";
import { sanitizeText } from "@/lib/sanitize";
import { toCandidateItems } from "@/lib/search/cache";

export const runtime = "nodejs";

const ACTIONS = new Set<InteractionAction>(["viewed", "liked", "disliked", "skipped", "queued", "extraction_failed"]);

type Params = {
  params: Promise<{ id: string }>;
};

async function getHandler(_request: Request, { params }: Params) {
  const { id } = await params;
  const candidate = getCandidateById(apiPositiveId(id));
  if (!candidate) {
    return NextResponse.json({ error: "候选视频不存在" }, { status: 404 });
  }
  const ownerId = await currentAppOwnerId();
  return NextResponse.json({
    ownerId,
    candidate: toCandidateItems([candidate], ownerId)[0],
    interactions: listCandidateInteractions(candidate.id, ownerId)
  });
}

async function postHandler(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const candidate = getCandidateById(apiPositiveId(id));
    if (!candidate) {
      return NextResponse.json({ error: "候选视频不存在" }, { status: 404 });
    }
    const body = await readJsonObject(request);
    const action = body.action as InteractionAction;
    if (typeof action !== "string" || !ACTIONS.has(action)) {
      return NextResponse.json({ error: "不支持这个互动动作" }, { status: 400 });
    }
    const ownerId = await currentAppOwnerId();
    return NextResponse.json({ interaction: recordInteraction(candidate.id, action, ownerId, request.headers.get("idempotency-key") || undefined) }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}

export const GET = apiEndpoint("GET", getHandler);
export const POST = apiEndpoint("POST", postHandler);
export const OPTIONS = apiOptions(["GET","POST"]);
