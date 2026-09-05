import { apiEndpoint, apiOptions, ApiError, positiveId as apiPositiveId } from "@/lib/api";
import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { deleteFavoriteVideo } from "@/lib/db";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ candidateId: string }>;
};

async function deleteHandler(_request: Request, { params }: Params) {
  const { candidateId } = await params;
  const deleted = deleteFavoriteVideo(apiPositiveId(candidateId), await currentAppOwnerId());
  return NextResponse.json({ deleted });
}

export const DELETE = apiEndpoint("DELETE", deleteHandler);
export const OPTIONS = apiOptions(["DELETE"]);
