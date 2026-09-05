import { apiEndpoint, apiOptions, ApiError, readJsonObject, positiveId as apiPositiveId } from "@/lib/api";
import { NextResponse } from "next/server";

import { editCreator, removeCreator } from "@/lib/creators";
import { creatorPatchInput } from "@/lib/apiInput";
import { currentAppOwnerId } from "@/lib/appOwner";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

async function patchHandler(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const creator = editCreator(apiPositiveId(id), creatorPatchInput(await readJsonObject(request)), await currentAppOwnerId());
    if (!creator) {
      return NextResponse.json({ error: "关注 UP 不存在" }, { status: 404 });
    }
    return NextResponse.json({ creator });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}

async function deleteHandler(_request: Request, { params }: Params) {
  const { id } = await params;
  const deleted = removeCreator(apiPositiveId(id), await currentAppOwnerId());
  if (!deleted) {
    return NextResponse.json({ error: "关注 UP 不存在" }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}

export const PATCH = apiEndpoint("PATCH", patchHandler);
export const DELETE = apiEndpoint("DELETE", deleteHandler);
export const OPTIONS = apiOptions(["PATCH","DELETE"]);
