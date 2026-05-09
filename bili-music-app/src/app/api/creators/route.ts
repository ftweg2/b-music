import { NextResponse } from "next/server";

import { addCreator, listCreators } from "@/lib/creators";
import { currentAppOwnerId } from "@/lib/appOwner";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

export async function GET() {
  const ownerId = await currentAppOwnerId();
  return NextResponse.json({ ownerId, creators: await listCreators(ownerId) });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const creator = await addCreator(body, await currentAppOwnerId());
    return NextResponse.json({ creator }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
