import { NextResponse } from "next/server";

import { currentAppOwnerId } from "@/lib/appOwner";
import { ensureDefaultKernelProfile } from "@/lib/kernelSession";
import { assertRateLimit, RateLimitError } from "@/lib/rateLimit";
import { runSearch } from "@/lib/search/cache";
import { sanitizeText } from "@/lib/sanitize";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const appOwnerId = await currentAppOwnerId();
    assertRateLimit(`app-search:${appOwnerId}`, 12, 60_000);
    const profile = body.provider === "kernel" ? await ensureDefaultKernelProfile() : null;
    const payload = await runSearch({
      keyword: body.keyword,
      useRemote: Boolean(body.useRemote),
      limit: Number(body.limit || 20),
      page: Number(body.page || 1),
      appOwnerId,
      provider: body.provider,
      externalOwnerId: profile?.external_owner_id,
      profileId: profile?.profile_id
    });
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: sanitizeText(error) },
        { status: 429, headers: { "retry-after": String(error.retryAfterSeconds) } }
      );
    }
    return NextResponse.json({ error: sanitizeText(error) }, { status: 400 });
  }
}
