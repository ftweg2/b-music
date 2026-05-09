import type { NormalizedCandidate } from "./types";

const POSITIVE_TERMS = [
  "\u539f\u521b\u66f2",
  "\u7ffb\u5531",
  "cover",
  "mv",
  "\u6b4c\u3063\u3066\u307f\u305f",
  "\u6b4c\u66f2",
  "\u97f3\u4e50",
  "live",
  "vocal",
  "instrumental",
  "\u4f34\u594f",
  "\u6f14\u5531",
  "\u5355\u66f2",
  "ost",
  "original",
  "remix"
];

const NEGATIVE_TERMS = [
  "\u6559\u7a0b",
  "\u89e3\u6790",
  "reaction",
  "\u8bc4\u6d4b",
  "\u76f4\u64ad\u56de\u653e",
  "\u8bfe\u7a0b",
  "\u65b0\u95fb",
  "\u8bb2\u89e3",
  "\u6d4b\u8bc4",
  "review",
  "tutorial"
];

export function musicLikelihood(candidate: Pick<NormalizedCandidate, "title" | "category" | "durationSeconds" | "tags">): number {
  const haystack = `${candidate.title} ${(candidate.tags ?? []).join(" ")} ${candidate.category ?? ""}`.toLowerCase();
  let score = 0;

  for (const term of POSITIVE_TERMS) {
    if (haystack.includes(term.toLowerCase())) {
      score += 8;
    }
  }
  for (const term of NEGATIVE_TERMS) {
    if (haystack.includes(term.toLowerCase())) {
      score -= 12;
    }
  }

  const category = (candidate.category ?? "").toLowerCase();
  if (category.includes("music") || category.includes("\u97f3\u4e50")) {
    score += 18;
  }

  const duration = candidate.durationSeconds;
  if (duration && duration >= 60 && duration <= 12 * 60) {
    score += 14;
  } else if (duration && duration > 45 * 60) {
    score -= 18;
  } else if (duration && duration < 30) {
    score -= 8;
  }

  return Math.max(-40, Math.min(60, score));
}

export function isLikelyMusic(candidate: Pick<NormalizedCandidate, "title" | "category" | "durationSeconds" | "tags">): boolean {
  return musicLikelihood(candidate) > 12;
}
