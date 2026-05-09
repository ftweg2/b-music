import { NextResponse } from "next/server";

import { prepareTrack } from "@/lib/tracks";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const track = await prepareTrack({
      candidateId: Number(body.candidateId),
      profileId: body.profileId || body.profile_id || "",
      externalOwnerId: body.externalOwnerId || body.external_owner_id,
      strategyMode: body.strategyMode || body.strategy_mode,
      strategy: body.strategy,
      strategyOrder: body.strategyOrder || body.strategy_order
    });
    return NextResponse.json({ track });
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
