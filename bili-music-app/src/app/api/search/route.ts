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
    const provider = normalizeProvider(body.provider);
    const useRemote = normalizeBoolean(body.useRemote, false);
    const appOwnerId = await currentAppOwnerId();
    assertRateLimit(`app-search:${appOwnerId}`, 12, 60_000);
    const profile = provider === "kernel" ? await ensureDefaultKernelProfile() : null;
    const payload = await runSearch({
      keyword: body.keyword,
      useRemote,
      limit: Number(body.limit || 20),
      page: Number(body.page || 1),
      appOwnerId,
      provider,
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
    return NextResponse.json(
      { error: sanitizeText(error), code: "INVALID_SEARCH_REQUEST" },
      { status: 400 }
    );
  }
}

function normalizeProvider(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("provider 必须是字符串");
  const provider = value.trim().toLowerCase();
  if (!new Set(["bilibili", "kernel", "mock"]).has(provider)) {
    throw new Error("不支持的搜索 provider");
  }
  return provider;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  throw new Error("useRemote 必须是布尔值");
}
