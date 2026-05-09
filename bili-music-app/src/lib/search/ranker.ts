import type { CandidateVideo, PreferredCreator, ScoreBreakdown } from "../models";
import type { NormalizedCandidate } from "./types";
import { musicLikelihood } from "./musicHeuristics";

type Rankable = NormalizedCandidate | CandidateVideo;

export type InteractionSummary = {
  viewed?: number;
  liked?: number;
  disliked?: number;
  skipped?: number;
  queued?: number;
  extraction_failed?: number;
  favorite?: number;
};

export function rankCandidate(
  candidate: Rankable,
  keyword: string,
  preferredCreators: PreferredCreator[],
  interactions: InteractionSummary = {}
): ScoreBreakdown {
  const textMatch = scoreText(candidate, keyword);
  const preferredCreator = scorePreferredCreator(candidate, preferredCreators);
  const music = musicLikelihood({
    title: candidate.title,
    category: candidate.category,
    durationSeconds: candidate.durationSeconds,
    tags: tagsOf(candidate)
  });
  const recency = scoreRecency(candidate.pubTime);
  const interaction = scoreInteractions(interactions);
  const penalty = scorePenalty(candidate, interactions);
  const final = Math.round(textMatch + preferredCreator + music + recency + interaction + penalty);

  return {
    textMatch,
    preferredCreator,
    musicLikelihood: music,
    recency,
    interaction,
    penalty,
    final
  };
}

export function sortByRank<T extends Rankable>(
  candidates: T[],
  keyword: string,
  preferredCreators: PreferredCreator[],
  interactionsById: Map<number, InteractionSummary> = new Map()
): Array<{ candidate: T; scoreBreakdown: ScoreBreakdown; isPreferredCreator: boolean }> {
  return candidates
    .map((candidate) => {
      const interactions = "id" in candidate ? interactionsById.get(candidate.id) ?? {} : {};
      const scoreBreakdown = rankCandidate(candidate, keyword, preferredCreators, interactions);
      return {
        candidate,
        scoreBreakdown,
        isPreferredCreator: scorePreferredCreator(candidate, preferredCreators) > 0
      };
    })
    .sort((a, b) => b.scoreBreakdown.final - a.scoreBreakdown.final);
}

export function scoreText(candidate: Rankable, keyword: string): number {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) {
    return 0;
  }
  const title = candidate.title.toLowerCase();
  const description = (candidate.description ?? "").toLowerCase();
  const tags = tagsOf(candidate).join(" ").toLowerCase();
  let score = 0;
  if (title === normalizedKeyword) {
    score += 40;
  } else if (title.includes(normalizedKeyword)) {
    score += 30;
  }
  const terms = normalizedKeyword.split(/\s+/).filter(Boolean);
  for (const term of terms) {
    if (title.includes(term)) {
      score += 6;
    }
    if (description.includes(term) || tags.includes(term)) {
      score += 3;
    }
  }
  return Math.min(45, score);
}

export function scorePreferredCreator(candidate: Rankable, preferredCreators: PreferredCreator[]): number {
  if (!candidate.creatorMid) {
    return 0;
  }
  const creator = preferredCreators.find((item) => item.biliMid === candidate.creatorMid);
  if (!creator) {
    return 0;
  }
  return Math.max(20, Math.min(80, creator.priorityWeight));
}

function scoreRecency(pubTime: string | null): number {
  if (!pubTime) {
    return 0;
  }
  const timestamp = Date.parse(pubTime);
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  const ageDays = (Date.now() - timestamp) / 86_400_000;
  if (ageDays < 30) {
    return 10;
  }
  if (ageDays < 180) {
    return 6;
  }
  if (ageDays < 730) {
    return 2;
  }
  return 0;
}

function scoreInteractions(interactions: InteractionSummary): number {
  return (
    (interactions.favorite ?? 0) * 28 +
    (interactions.liked ?? 0) * 12 +
    (interactions.queued ?? 0) * 8 -
    (interactions.disliked ?? 0) * 18 -
    (interactions.skipped ?? 0) * 6
  );
}

function scorePenalty(candidate: Rankable, interactions: InteractionSummary): number {
  let penalty = 0;
  if ((interactions.extraction_failed ?? 0) > 0) {
    penalty -= 25;
  }
  if (candidate.durationSeconds && candidate.durationSeconds > 90 * 60) {
    penalty -= 20;
  }
  return penalty;
}

export function tagsOf(candidate: Rankable): string[] {
  if ("tags" in candidate && Array.isArray(candidate.tags)) {
    return candidate.tags;
  }
  if ("tagsJson" in candidate && candidate.tagsJson) {
    try {
      const parsed = JSON.parse(candidate.tagsJson);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}
