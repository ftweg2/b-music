import type { CandidateWithScore } from "@/lib/models";
import { buildRecommendationReasons } from "@/lib/recommendationReasons";

export function RecommendationReasons({ candidate }: { candidate: CandidateWithScore }) {
  const reasons = buildRecommendationReasons(candidate);

  return (
    <div className="reasonList" aria-label="推荐理由">
      {reasons.map((reason) => (
        <span className="reasonChip" key={reason}>
          {reason}
        </span>
      ))}
    </div>
  );
}
