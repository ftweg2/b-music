import { favoriteBvids, getCandidateByBvid, listPreferredCreators, logSearchQuery, searchLocalCandidates, upsertCandidateVideo } from "../db";
import type { CandidateVideo, CandidateItem } from "../models";
import { sanitizeBvid, sanitizeMid, sanitizeNullableText, sanitizeText, sanitizeUrl } from "../sanitize";
import type { NormalizedCandidate, RawSearchResult, SearchProvider } from "./types";
import { getSearchProvider } from "./provider";
import { followedFirst } from "./order";
import { assertRateLimit, RateLimitError } from "../rateLimit";
import { KernelRequestError } from "../kernelClient";
import { searchSession, readSession, freezeLocalPool, frozenPage, commitPage, SearchSnapshotError, type FrozenSearchPage } from "./sessions";
import { MAX_SEARCH_PAGES, pageLimit } from "./pagination";

export class SearchProviderError extends Error {
  constructor(message: string, public provider: string, public page: number, public retryAfterSeconds?: number, public searchId?: string) {
    super(message);
  }
}

export type SearchRequest = {
  keyword: string; useRemote: boolean; limit: number; page?: number; appOwnerId?: string;
  provider?: string; externalOwnerId?: string; profileId?: string; searchProvider?: SearchProvider; searchId?: string; sessionKey?: string;
};
export type SearchResponsePayload = {
  provider: string; remoteUsed: boolean; source: "remote" | "local" | "direct";
  page: number; limit: number; hasPreviousPage: boolean; hasNextPage: boolean;
  candidates: CandidateItem[]; searchId: string; duplicatesRemoved: number; totalPages?: number; pageLimit: number; cached: boolean;
};

const pendingPages = new Map<string, Promise<FrozenSearchPage>>();

export async function runSearch(request: SearchRequest): Promise<SearchResponsePayload> {
  const keyword = sanitizeText(request.keyword, 200).trim();
  if (!keyword) throw new Error("请先输入关键词");
  const provider = request.searchProvider ?? getSearchProvider(request.provider);
  const maximum = request.useRemote ? Math.min(provider.maxPageSize ?? 20, boundedInteger(Number(process.env.BILIBILI_SEARCH_LIMIT), 20, 1, 50)) : 50;
  const limit = boundedInteger(request.limit, Math.min(20, maximum), 1, maximum);
  const page = boundedInteger(request.page, 1, 1, MAX_SEARCH_PAGES);
  const ownerId = request.appOwnerId || "local";
  let session = searchSession({ ownerId, keyword, provider: provider.name, useRemote: request.useRemote, limit, sessionKey: request.sessionKey }, request.searchId);
  const directBvid = sanitizeBvid(keyword);
  const source = directBvid ? "direct" : request.useRemote ? "remote" : "local";
  let stored = frozenPage(session, page);
  const cached = Boolean(stored);

  if (!stored && source === "direct") {
    const existing = getCandidateByBvid(directBvid);
    const candidates = page !== 1 ? [] : existing ? [existing] : request.useRemote ? [saveCandidateMetadata(normalizeRawSearchResult({
      bvid: directBvid, title: `Bilibili 视频 ${directBvid}`,
    }, keyword, "direct_url"))] : [];
    stored = commitPage(session, page, { candidates, hasNextPage: false, duplicatesRemoved: 0 }, 1);
  } else if (!stored && source === "local") {
    if (!session.localPool) session = freezeLocalPool(session, searchLocalCandidates(keyword, limit * MAX_SEARCH_PAGES + 1, 0, ownerId));
    const pool = session.localPool!;
    const candidates = pool.slice((page - 1) * limit, page * limit);
    stored = commitPage(session, page, { candidates, hasNextPage: page * limit < pool.length, duplicatesRemoved: 0 }, session.totalPages);
  } else if (!stored) {
    const key = session.id + ":" + page;
    let pending = pendingPages.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          assertRateLimit(`app-search-remote:${ownerId}`, 12, 60_000);
          const options = {
            limit, page, timeoutMs: boundedInteger(Number(process.env.BILIBILI_SEARCH_TIMEOUT_MS), 8000, 1000, 30000),
            externalOwnerId: request.externalOwnerId, profileId: request.profileId,
          };
          const response = provider.searchPage ? await provider.searchPage(keyword, options) : {
            results: await provider.searchVideos(keyword, options), hasNextPage: undefined, totalPages: undefined,
          };
          const candidates: CandidateVideo[] = [];
          const seen = new Set<string>();
          let duplicatesRemoved = 0;
          for (const raw of response.results.slice(0, limit)) {
            let normalized: NormalizedCandidate;
            try { normalized = normalizeRawSearchResult(raw, keyword, provider.name); } catch { continue; }
            if (seen.has(normalized.bvid)) { duplicatesRemoved++; continue; }
            seen.add(normalized.bvid);
            candidates.push(saveCandidateMetadata(normalized));
          }
          return commitPage(session, page, {
            candidates, duplicatesRemoved, hasNextPage: response.hasNextPage ?? response.results.length >= limit,
          }, response.totalPages);
        } catch (error) {
          if (error instanceof SearchSnapshotError) throw error;
          const message = sanitizeText(error instanceof Error ? error.message : error);
          logSearchQuery(keyword, 0, false, { provider: provider.name, page, error: message });
          throw new SearchProviderError(message, provider.name, page, error instanceof RateLimitError || error instanceof KernelRequestError ? error.retryAfterSeconds : undefined, session.id);
        }
      })().finally(() => pendingPages.delete(key));
      pendingPages.set(key, pending);
    }
    stored = await pending;
  }

  const frozen = stored!;
  // Repair stale candidate IDs after an independent metadata-cache cleanup, without refetching/reordering pages.
  const candidates = frozen.candidates.map((candidate) => {
    const current = getCandidateByBvid(candidate.bvid);
    return { ...candidate, id: current?.id ?? upsertCandidateVideo(candidate).id };
  });
  const followed = new Set(listPreferredCreators(ownerId).map((creator) => creator.biliMid));
  const favorites = favoriteBvids(candidates.map((candidate) => candidate.bvid), ownerId);
  const items = followedFirst(candidates.map((candidate) => toCandidateItem(candidate, followed.has(candidate.creatorMid || ""), favorites.has(candidate.bvid))), (item) => item.isPreferredCreator);
  const latestSession = readSession(session.context, session.id);
  const maximumPage = pageLimit(latestSession.totalPages);
  logSearchQuery(keyword, items.length, source === "remote", { provider: source === "remote" ? provider.name : source, page });
  return {
    provider: source === "remote" ? provider.name : source, source, remoteUsed: source === "remote",
    page, limit, hasPreviousPage: page > 1, hasNextPage: frozen.hasNextPage && page < maximumPage,
    candidates: items, searchId: session.id, duplicatesRemoved: frozen.duplicatesRemoved,
    totalPages: latestSession.totalPages, pageLimit: maximumPage, cached,
  };
}

export function normalizeRawSearchResult(
  raw: RawSearchResult,
  searchKeyword: string | null,
  sourceProvider: string
): NormalizedCandidate {
  const bvid = sanitizeBvid(raw.bvid || raw.sourceUrl);
  if (!bvid) {
    throw new Error("搜索结果缺少 BV 号");
  }
  return {
    bvid,
    aid: raw.aid ? String(raw.aid) : null,
    title: sanitizeText(raw.title, 500) || bvid,
    description: sanitizeNullableText(raw.description, 1500),
    creatorMid: sanitizeMid(raw.creatorMid),
    creatorName: sanitizeNullableText(raw.creatorName, 300),
    coverUrl: raw.coverUrl ? sanitizeUrl(raw.coverUrl) : null,
    durationSeconds: normalizeDuration(raw.durationSeconds),
    pubTime: normalizePubTime(raw.pubTime),
    sourceUrl: `https://www.bilibili.com/video/${bvid}`,
    category: sanitizeNullableText(raw.category, 200),
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => sanitizeText(tag, 80)).filter(Boolean) : [],
    searchKeyword: searchKeyword ? sanitizeText(searchKeyword, 200) : null,
    sourceProvider
  };
}


export function saveCandidateMetadata(candidate: NormalizedCandidate): CandidateVideo {
  return upsertCandidateVideo({ ...candidate, tagsJson: JSON.stringify(candidate.tags) });
}

export function toCandidateItem(candidate: CandidateVideo, isPreferredCreator = false, isFavorited = false): CandidateItem {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(candidate.tagsJson || "[]");
    tags = Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch { /* Malformed legacy tags are harmless. */ }
  return { ...candidate, tags, isPreferredCreator, isFavorited };
}

export function toCandidateItems(candidates: CandidateVideo[], ownerId: string): CandidateItem[] {
  const followed = new Set(listPreferredCreators(ownerId).map((creator) => creator.biliMid));
  const favorites = favoriteBvids(candidates.map((candidate) => candidate.bvid), ownerId);
  return candidates.map((candidate) => toCandidateItem(candidate, followed.has(candidate.creatorMid || ""), favorites.has(candidate.bvid)));
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function normalizeDuration(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return Math.round(num);
}

function normalizePubTime(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (typeof value === "number") {
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
