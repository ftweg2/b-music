import type { CandidateWithScore } from "./models";

type ReasonCandidate = Pick<
  CandidateWithScore,
  "durationSeconds" | "isPreferredCreator" | "scoreBreakdown"
>;

export function buildRecommendationReasons(candidate: ReasonCandidate): string[] {
  const score = candidate.scoreBreakdown;
  const reasons: string[] = [];

  if (candidate.isPreferredCreator || score.preferredCreator > 0) {
    reasons.push("关注 UP 优先");
  }
  if (score.textMatch >= 30) {
    reasons.push("标题强相关");
  } else if (score.textMatch > 0) {
    reasons.push("关键词相关");
  }
  if (score.musicLikelihood >= 30) {
    reasons.push("音乐特征明显");
  } else if (score.musicLikelihood >= 12) {
    reasons.push("像音乐视频");
  }
  if (score.recency >= 6) {
    reasons.push("近期发布");
  }
  if (score.interaction > 0) {
    reasons.push("你互动过");
  }
  if (isSingleTrackDuration(candidate.durationSeconds)) {
    reasons.push("时长适合单曲");
  }
  if (score.penalty < 0) {
    reasons.push("有降权风险");
  }

  return dedupe(reasons).slice(0, 5);
}

function isSingleTrackDuration(seconds: number | null): boolean {
  return seconds !== null && seconds >= 60 && seconds <= 720;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.length ? values : ["普通候选"]));
}
