import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { getSyncedTrack } from "@/lib/tracks";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const track = await getSyncedTrack(Number(id), await currentAppOwnerId());
    if (!track) {
      return NextResponse.json({ error: "Track 不存在" }, { status: 404 });
    }
    return NextResponse.json({ track });
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
