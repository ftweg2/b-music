import type { CandidateItem } from "../models";
import { pageLimit as maximumPage } from "./pagination";

export const SEARCH_STATE_KEY = "bili-music-app:search-state:v7";
export type ProviderChoice = "auto" | "bilibili" | "kernel";
export type SearchAttempt = {
  keyword: string; useRemote: boolean; provider: ProviderChoice; limit: number; page: number; sessionKey?: string; searchId?: string;
};
export type SearchSnapshot = {
  request: SearchAttempt; source: "remote" | "local" | "direct";
  candidates: CandidateItem[]; hasNextPage: boolean; selectionNote?: string; updatedAt: string;
  pageLimit: number; totalPages?: number; duplicatesRemoved: number; cached: boolean;
};
export type SearchPayload = {
  provider: string; source: SearchSnapshot["source"]; page: number; limit: number;
  candidates: CandidateItem[]; hasNextPage: boolean; sessionKey?: string; selectionNote?: string;
  searchId?: string; pageLimit?: number; totalPages?: number; duplicatesRemoved?: number; cached?: boolean;
};

export function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(maximum, Math.max(1, Math.floor(number))) : fallback;
}
export function searchEntry(query: string): { request: SearchAttempt; run: boolean } {
  const params = new URLSearchParams(query);
  const provider = params.get("provider");
  return {
    request: {
      keyword: (params.get("q") || "").trim().slice(0, 200),
      useRemote: params.get("remote") !== "0",
      provider: provider === "kernel" || provider === "bilibili" ? provider : "auto",
      limit: positiveInteger(params.get("limit"), 20, 50),
      page: positiveInteger(params.get("page"), 1, 10),
      sessionKey: params.get("sessionKey") || undefined,
      searchId: params.get("searchId") || undefined,
    },
    run: params.get("run") === "1",
  };
}
export function bindSearchResult(request: SearchAttempt, payload: SearchPayload): SearchSnapshot {
  return {
    request: {
      ...request,
      provider: payload.provider === "kernel" ? "kernel" : "bilibili",
      limit: payload.limit, page: payload.page, sessionKey: payload.sessionKey,
      ...(payload.searchId ? { searchId: payload.searchId } : {}),
    },
    source: payload.source, candidates: payload.candidates, hasNextPage: payload.hasNextPage,
    selectionNote: payload.selectionNote, updatedAt: new Date().toISOString(),
    pageLimit: payload.pageLimit ?? maximumPage(payload.totalPages), totalPages: payload.totalPages,
    duplicatesRemoved: payload.duplicatesRemoved ?? 0, cached: Boolean(payload.cached),
  };
}
export function pageAttempt(snapshot: SearchSnapshot, page: number): SearchAttempt {
  return { ...snapshot.request, page: positiveInteger(page, 1, snapshot.pageLimit) };
}
export function failedSearchAttempt(request: SearchAttempt, response: { provider?: string; sessionKey?: string; searchId?: string }): SearchAttempt {
  return {
    ...request,
    provider: response.provider === "kernel" || response.provider === "bilibili" ? response.provider : request.provider,
    sessionKey: response.sessionKey ?? request.sessionKey,
    ...(response.searchId ? { searchId: response.searchId } : {}),
  };
}
export function searchUrl(request: SearchAttempt, run = false): string {
  const params = new URLSearchParams({
    q: request.keyword, remote: request.useRemote ? "1" : "0", provider: request.provider,
    limit: String(request.limit), page: String(request.page),
  });
  if (request.sessionKey) params.set("sessionKey", request.sessionKey);
  if (request.searchId) params.set("searchId", request.searchId);
  if (run) params.set("run", "1");
  return "/search?" + params;
}
export function sameSearch(a: SearchAttempt, b: SearchAttempt): boolean {
  return a.keyword === b.keyword && a.useRemote === b.useRemote && a.provider === b.provider &&
    a.limit === b.limit && a.page === b.page && a.sessionKey === b.sessionKey && a.searchId === b.searchId;
}
export function normalizeSearchSnapshot(value: unknown): SearchSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SearchSnapshot>;
  if (!raw.request || typeof raw.request.keyword !== "string" || !raw.request.keyword.trim() ||
    !["bilibili", "kernel"].includes(raw.request.provider) || !Array.isArray(raw.candidates) ||
    typeof raw.request.searchId !== "string" || !raw.request.searchId ||
    !Number.isInteger(raw.request.page) || raw.request.page < 1 || raw.request.page > 10 ||
    !["remote", "local", "direct"].includes(raw.source || "") ||
    !Number.isFinite(Date.parse(raw.updatedAt || "")) || Date.now() - Date.parse(raw.updatedAt!) > 30 * 60_000) return null;
  if (raw.candidates.some((item) => !item || !Number.isSafeInteger(item.id) || typeof item.title !== "string")) return null;
  return { ...raw, candidates: raw.candidates.slice(0, 50), hasNextPage: Boolean(raw.hasNextPage) } as SearchSnapshot;
}
