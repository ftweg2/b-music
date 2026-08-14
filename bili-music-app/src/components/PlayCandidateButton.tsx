"use client";

import type { CandidateWithScore } from "@/lib/models";
import { downloadCandidate, playCandidate } from "./PlayerDock";

export function PlayCandidateButton({ candidate }: { candidate: CandidateWithScore }) {
  return (
    <button type="button" onClick={() => playCandidate(candidate)}>
      播放
    </button>
  );
}

export function DownloadCandidateButton({ candidate }: { candidate: CandidateWithScore }) {
  return (
    <button type="button" className="secondary" onClick={() => downloadCandidate(candidate)}>
      下载离线
    </button>
  );
}
