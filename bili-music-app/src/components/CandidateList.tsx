"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { CandidateItem } from "@/lib/models";
import { CandidateCard } from "./CandidateCard";
import { MusicIcon, ListMusicIcon } from "./Icons";

type CandidateListProps = {
  candidates: CandidateItem[];
  title?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  hideHeading?: boolean;
  defaultView?: "grid" | "list";
  renderActions?: (candidate: CandidateItem, index: number) => ReactNode;
};

export function CandidateList({
  candidates,
  title = "候选曲目",
  emptyTitle = "这里还没有音乐",
  emptyDescription = "尝试搜索一首歌，或从收藏与关注中开始探索",
  hideHeading = false,
  defaultView = "grid",
  renderActions,
}: CandidateListProps) {
  const [returnTo, setReturnTo] = useState("");
  useEffect(() => { setReturnTo(window.location.pathname + window.location.search); }, [candidates]);
  const [view, setView] = useState<"grid" | "list">(defaultView);
  if (!candidates.length) {
    return (
      <div className="empty">
        <div className="emptyIcon"><MusicIcon size={25} /></div>
        <strong>{emptyTitle}</strong>
        <span>{emptyDescription}</span>
      </div>
    );
  }

  return (
    <section className="candidateResults">
      {!hideHeading && <div className="sectionHeading">
        <div>
          <h2>{title}</h2>
        </div>
        <div className="resultTools"><span className="resultCount">{candidates.length} 首音乐</span><div className="viewToggle" role="group" aria-label="结果显示方式">
          <button type="button" aria-label="封面视图" aria-pressed={view === "grid"} onClick={() => setView("grid")}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg></button>
          <button type="button" aria-label="列表视图" aria-pressed={view === "list"} onClick={() => setView("list")}><ListMusicIcon size={17} /></button>
        </div></div>
      </div>}
      <div className={`candidateList ${view === "list" ? "candidateListRows" : ""}`}>
        {candidates.map((candidate, index) => (
          <CandidateCard candidate={candidate} key={candidate.id} index={index} returnTo={returnTo} extraActions={renderActions?.(candidate, index)} />
        ))}
      </div>
    </section>
  );
}
