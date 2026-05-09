import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { deleteFavoriteVideo } from "@/lib/db";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ candidateId: string }>;
};

export async function DELETE(_request: Request, { params }: Params) {
  const { candidateId } = await params;
  const deleted = deleteFavoriteVideo(Number(candidateId), await currentAppOwnerId());
  return NextResponse.json({ deleted });
}
