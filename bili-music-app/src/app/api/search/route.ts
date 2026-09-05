import { apiEndpoint, apiOptions, ApiError, readJsonObject } from "@/lib/api";
import { NextResponse } from "next/server";

import { searchInput } from "@/lib/apiInput";
import { currentAppOwnerId } from "@/lib/appOwner";
import { assertRateLimit, RateLimitError } from "@/lib/rateLimit";
import { runSearch, SearchProviderError } from "@/lib/search/cache";
import { resolveSearchSelection, SearchSessionError } from "@/lib/search/selection";
import { sanitizeText } from "@/lib/sanitize";
import { SearchSnapshotError } from "@/lib/search/sessions";

export const runtime = "nodejs";

async function postHandler(request: Request) {
  let sessionKey: string | undefined;
  try {
    const body = searchInput(await readJsonObject(request));
    const provider = normalizeProvider(body.provider);
    const useRemote = normalizeBoolean(body.useRemote, false);
    const appOwnerId = await currentAppOwnerId();
    assertRateLimit(`app-search-browse:${appOwnerId}`, 120, 60_000);
    const page = Math.max(1, Math.min(10, Math.floor(Number(body.page) || 1)));
    const selection = await resolveSearchSelection(provider, useRemote, page, typeof body.sessionKey === "string" ? body.sessionKey : undefined);
    sessionKey = selection.sessionKey;
    const payload = await runSearch({
      keyword: body.keyword,
      useRemote,
      limit: Number(body.limit || 20),
      page,
      appOwnerId,
      provider: selection.provider,
      externalOwnerId: selection.externalOwnerId,
      profileId: selection.profileId,
      searchId: typeof body.searchId === "string" ? body.searchId : undefined,
      sessionKey: selection.sessionKey
    });
    return NextResponse.json({ ...payload, sessionKey: selection.sessionKey, selectionNote: selection.selectionNote });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof SearchSnapshotError) return NextResponse.json({ error: error.message, code: "SEARCH_SNAPSHOT_EXPIRED" }, { status: 409 });
    if (error instanceof SearchSessionError) return NextResponse.json({ error: error.message, code: "SEARCH_SESSION_CHANGED" }, { status: 409 });
    if (error instanceof SearchProviderError) return NextResponse.json({
      error: error.message, code: "SEARCH_PROVIDER_FAILED", provider: error.provider, page: error.page, sessionKey, searchId: error.searchId,
    }, { status: error.retryAfterSeconds ? 429 : 502, headers: error.retryAfterSeconds ? { "retry-after": String(error.retryAfterSeconds) } : undefined });
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
  if (!new Set(["auto", "bilibili", "kernel", "mock"]).has(provider)) {
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

export const POST = apiEndpoint("POST", postHandler);
export const OPTIONS = apiOptions(["POST"]);
