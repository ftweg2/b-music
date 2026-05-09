"use client";

import type { CandidateWithScore } from "@/lib/models";
import { playCandidate } from "./PlayerDock";

export function PlayCandidateButton({ candidate }: { candidate: CandidateWithScore }) {
  return (
    <button type="button" onClick={() => playCandidate(candidate)}>
      播放
    </button>
  );
}
