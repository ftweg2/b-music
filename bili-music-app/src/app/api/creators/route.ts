import { apiEndpoint, apiOptions, ApiError, readJsonObject } from "@/lib/api";
import { NextResponse } from "next/server";

import { creatorInput } from "@/lib/apiInput";
import { addCreator, listCreators } from "@/lib/creators";
import { currentAppOwnerId } from "@/lib/appOwner";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

async function getHandler() {
  const ownerId = await currentAppOwnerId();
  return NextResponse.json({ ownerId, creators: await listCreators(ownerId) });
}

async function postHandler(request: Request) {
  try {
    const body = creatorInput(await readJsonObject(request));
    const creator = await addCreator(body, await currentAppOwnerId());
    return NextResponse.json({ creator }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}

export const GET = apiEndpoint("GET", getHandler);
export const POST = apiEndpoint("POST", postHandler);
export const OPTIONS = apiOptions(["GET","POST"]);
