import type { CandidateWithScore } from "@/lib/models";
import { CandidateCard } from "./CandidateCard";

export function CandidateList({ candidates }: { candidates: CandidateWithScore[] }) {
  if (!candidates.length) {
    return <div className="empty">还没有候选视频。先搜一个关键词试试。</div>;
  }
  return (
    <div className="candidateList">
      {candidates.map((candidate) => (
        <CandidateCard candidate={candidate} key={candidate.id} />
      ))}
    </div>
  );
}
