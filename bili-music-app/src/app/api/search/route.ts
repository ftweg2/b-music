import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { runSearch } from "@/lib/search/cache";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const payload = await runSearch({
      keyword: body.keyword,
      useRemote: Boolean(body.useRemote),
      limit: Number(body.limit || 20),
      page: Number(body.page || 1),
      appOwnerId: await currentAppOwnerId(),
      provider: body.provider,
      externalOwnerId: body.externalOwnerId,
      profileId: body.profileId
    });
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
