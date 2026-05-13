import {
  favoriteBvids,
  getCandidateByBvid,
  interactionCounts,
  listPreferredCreators,
  logSearchQuery,
  searchFavoriteCandidates,
  searchFollowedCreatorCandidates,
  searchLocalCandidates,
  updateCandidateScore,
  upsertCandidateVideo
} from "../db";
import type { CandidateVideo, CandidateWithScore } from "../models";
import { sanitizeBvid, sanitizeMid, sanitizeNullableText, sanitizeText, sanitizeUrl } from "../sanitize";
import { rankCandidate, sortByRank, tagsOf } from "./ranker";
import type { NormalizedCandidate, RawSearchResult } from "./types";
import { getSearchProvider } from "./provider";

export type SearchRequest = {
  keyword: string;
  useRemote: boolean;
  limit: number;
  page?: number;
  appOwnerId?: string;
  provider?: string;
  externalOwnerId?: string;
  profileId?: string;
};

export type SearchResponsePayload = {
  provider: string;
  remoteUsed: boolean;
  page: number;
  limit: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  candidates: CandidateWithScore[];
  providerError?: string;
};

export async function runSearch(request: SearchRequest): Promise<SearchResponsePayload> {
  const keyword = sanitizeText(request.keyword, 200);
  if (!keyword) {
    throw new Error("请先输入关键词");
  }
  const limit = Math.max(1, Math.min(request.limit || 20, 50));
  const page = Math.max(1, Math.min(Math.round(request.page || 1), 10));
  const offset = request.useRemote ? 0 : (page - 1) * limit;
  const poolLimit = Math.min(page * limit, 500);
  const provider = getSearchProvider(request.provider);
  const appOwnerId = request.appOwnerId || "local";
  const preferredCreators = listPreferredCreators(appOwnerId);
  const directBvid = sanitizeBvid(keyword);
  const directCandidate = directBvid && page === 1 ? directCandidateFromKeyword(keyword, directBvid, preferredCreators) : null;
  const includeLocalDiscovery = !request.useRemote || page === 1;
  const local = includeLocalDiscovery
    ? mergeCandidates(
        directCandidate ? [directCandidate] : [],
        searchLocalCandidates(keyword, poolLimit),
        searchFollowedCreatorCandidates(keyword, preferredCreators, poolLimit),
        searchFavoriteCandidates(keyword, poolLimit, appOwnerId)
      )
    : [];
  let candidates = [...local];
  let providerError: string | undefined;

  if (request.useRemote) {
    try {
      const raw = await provider.searchVideos(keyword, {
        limit: Math.min(limit, Number(process.env.BILIBILI_SEARCH_LIMIT || 20)),
        page,
        timeoutMs: Number(process.env.BILIBILI_SEARCH_TIMEOUT_MS || 8000),
        externalOwnerId: request.externalOwnerId,
        profileId: request.profileId
      });
      const creatorRaw = await searchFollowedCreatorsRemote({
        provider,
        keyword,
        preferredCreators,
        request,
        limit,
        page
      });
      const normalized = [...raw, ...creatorRaw].map((item) => normalizeRawSearchResult(item, keyword, provider.name));
      const upserted = normalized.map((item) => upsertRankedCandidate(item, preferredCreators, keyword));
      candidates = mergeCandidates(local, upserted);
    } catch (error) {
      providerError = sanitizeText(error);
    }
  }

  const interactions = interactionCounts(candidates.map((candidate) => candidate.id), appOwnerId);
  const favorites = favoriteBvids(candidates.map((candidate) => candidate.bvid), appOwnerId);
  const allRanked = pinBvidFirst(sortByRank(candidates, keyword, preferredCreators, interactions), directBvid);
  const pageItems = allRanked.slice(offset, offset + limit);
  const ranked = pageItems
    .map(({ candidate, scoreBreakdown, isPreferredCreator }) => {
      updateCandidateScore(candidate.id, {
        musicLikelihoodScore: scoreBreakdown.musicLikelihood,
        preferredCreatorBoost: scoreBreakdown.preferredCreator,
        finalScore: scoreBreakdown.final,
        scoreBreakdownJson: JSON.stringify(scoreBreakdown)
      });
      return toCandidateWithScore(
        {
          ...candidate,
          musicLikelihoodScore: scoreBreakdown.musicLikelihood,
          preferredCreatorBoost: scoreBreakdown.preferredCreator,
          finalScore: scoreBreakdown.final,
          scoreBreakdownJson: JSON.stringify(scoreBreakdown)
        },
        isPreferredCreator,
        favorites.has(candidate.bvid)
      );
    });

  logSearchQuery(keyword, ranked.length, request.useRemote);
  return {
    provider: provider.name,
    remoteUsed: request.useRemote,
    page,
    limit,
    hasPreviousPage: page > 1,
    hasNextPage: ranked.length === limit && page < 10,
    candidates: ranked,
    providerError
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
    sourceUrl: raw.sourceUrl ? sanitizeUrl(raw.sourceUrl) : `https://www.bilibili.com/video/${bvid}`,
    category: sanitizeNullableText(raw.category, 200),
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => sanitizeText(tag, 80)).filter(Boolean) : [],
    searchKeyword: searchKeyword ? sanitizeText(searchKeyword, 200) : null,
    sourceProvider
  };
}

export function upsertRankedCandidate(
  candidate: NormalizedCandidate,
  preferredCreators = listPreferredCreators(),
  keyword = candidate.searchKeyword ?? ""
): CandidateVideo {
  const scoreBreakdown = rankCandidate(candidate, keyword, preferredCreators);
  return upsertCandidateVideo({
    ...candidate,
    tagsJson: JSON.stringify(candidate.tags),
    musicLikelihoodScore: scoreBreakdown.musicLikelihood,
    preferredCreatorBoost: scoreBreakdown.preferredCreator,
    finalScore: scoreBreakdown.final,
    scoreBreakdownJson: JSON.stringify(scoreBreakdown)
  });
}

export function toCandidateWithScore(candidate: CandidateVideo, isPreferredCreator?: boolean, isFavorited = false): CandidateWithScore {
  const scoreBreakdown = parseScoreBreakdown(candidate.scoreBreakdownJson);
  return {
    ...candidate,
    scoreBreakdown,
    tags: tagsOf(candidate),
    isPreferredCreator: isPreferredCreator ?? candidate.preferredCreatorBoost > 0,
    isFavorited
  };
}

export function parseScoreBreakdown(value: string): CandidateWithScore["scoreBreakdown"] {
  try {
    const parsed = JSON.parse(value);
    return {
      textMatch: Number(parsed.textMatch ?? 0),
      preferredCreator: Number(parsed.preferredCreator ?? 0),
      musicLikelihood: Number(parsed.musicLikelihood ?? 0),
      recency: Number(parsed.recency ?? 0),
      interaction: Number(parsed.interaction ?? 0),
      penalty: Number(parsed.penalty ?? 0),
      final: Number(parsed.final ?? 0)
    };
  } catch {
    return { textMatch: 0, preferredCreator: 0, musicLikelihood: 0, recency: 0, interaction: 0, penalty: 0, final: 0 };
  }
}

function mergeCandidates(...groups: CandidateVideo[][]): CandidateVideo[] {
  const byBvid = new Map<string, CandidateVideo>();
  for (const item of groups.flat()) {
    byBvid.set(item.bvid, item);
  }
  return Array.from(byBvid.values());
}

function directCandidateFromKeyword(
  keyword: string,
  bvid: string,
  preferredCreators: ReturnType<typeof listPreferredCreators>
): CandidateVideo {
  const existing = getCandidateByBvid(bvid);
  if (existing) {
    return existing;
  }
  return upsertRankedCandidate(
    normalizeRawSearchResult(
      {
        bvid,
        title: `Bilibili 视频 ${bvid}`,
        sourceUrl: `https://www.bilibili.com/video/${bvid}`,
        tags: ["direct"]
      },
      bvid,
      "direct_url"
    ),
    preferredCreators,
    bvid
  );
}

function pinBvidFirst<T extends { candidate: CandidateVideo }>(items: T[], bvid: string): T[] {
  if (!bvid) {
    return items;
  }
  return [...items].sort((left, right) => Number(right.candidate.bvid === bvid) - Number(left.candidate.bvid === bvid));
}

async function searchFollowedCreatorsRemote({
  provider,
  keyword,
  preferredCreators,
  request,
  limit,
  page
}: {
  provider: ReturnType<typeof getSearchProvider>;
  keyword: string;
  preferredCreators: ReturnType<typeof listPreferredCreators>;
  request: SearchRequest;
  limit: number;
  page: number;
}): Promise<RawSearchResult[]> {
  if (page !== 1 || !preferredCreators.length || provider.name === "mock") {
    return [];
  }
  const results: RawSearchResult[] = [];
  for (const creator of preferredCreators.slice(0, 2)) {
    const creatorKeyword = `${keyword} ${creator.name}`.trim();
    if (!creatorKeyword || creatorKeyword === keyword) {
      continue;
    }
    try {
      const raw = await provider.searchVideos(creatorKeyword, {
        limit: Math.min(6, limit),
        page: 1,
        timeoutMs: Math.min(Number(process.env.BILIBILI_SEARCH_TIMEOUT_MS || 8000), 6000),
        externalOwnerId: request.externalOwnerId,
        profileId: request.profileId
      });
      results.push(...raw);
    } catch {
      // Followed-UP expansion is best-effort and must not hide the primary search result.
    }
  }
  return results;
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
    return new Date(value * 1000).toISOString();
  }
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
