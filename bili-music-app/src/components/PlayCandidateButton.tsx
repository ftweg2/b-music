"use client";

import type { CandidateItem } from "@/lib/models";
import { downloadCandidate, playCandidate } from "./PlayerDock";
import { openPlaylistPicker } from "@/lib/playlistClient";
import { ListMusicIcon } from "./Icons";

export function AddToPlaylistButton({ candidate }: { candidate: CandidateItem }) {
  return <button type="button" className="secondary" onClick={() => openPlaylistPicker(candidate)}><ListMusicIcon size={16} />加入歌单</button>;
}

export function PlayCandidateButton({ candidate }: { candidate: CandidateItem }) {
  return (
    <button type="button" onClick={() => playCandidate(candidate)}>
      播放
    </button>
  );
}

export function DownloadCandidateButton({ candidate }: { candidate: CandidateItem }) {
  return (
    <button type="button" className="secondary" onClick={() => downloadCandidate(candidate)}>
      下载离线
    </button>
  );
}
