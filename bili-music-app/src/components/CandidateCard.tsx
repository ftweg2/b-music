"use client";
import { accountFetch } from "@/lib/accountClient";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LIBRARY_CHANGE_EVENT, notifyLibraryChange, type LibraryChange } from "@/lib/libraryEvents";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { openPlaylistPicker } from "@/lib/playlistClient";
import type { CandidateItem } from "@/lib/models";
import { downloadCandidate, playCandidate } from "./PlayerDock";
import { PlayIcon, HeartIcon, DownloadIcon, CheckIcon, ExternalLinkIcon, CopyIcon, MusicIcon, UsersIcon, ListMusicIcon } from "./Icons";

export function CandidateCard({ candidate, index = 0, returnTo, extraActions }: { candidate: CandidateItem; index?: number; returnTo?: string; extraActions?: ReactNode }) {
  const router = useRouter();
  const [isFavorited, setIsFavorited] = useState(candidate.isFavorited);
  const [creatorFollowed, setCreatorFollowed] = useState(candidate.isPreferredCreator);
  const [busy, setBusy] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => { setIsFavorited(candidate.isFavorited); setCreatorFollowed(candidate.isPreferredCreator); setImageFailed(false); }, [candidate.id, candidate.isFavorited, candidate.isPreferredCreator]);

  useEffect(() => {
    function changed(event: Event) {
      const update = (event as CustomEvent<LibraryChange>).detail;
      if (update.kind === "favorite" && update.bvid === candidate.bvid) setIsFavorited(update.favorited);
      if (update.kind === "creator" && update.biliMid === candidate.creatorMid) setCreatorFollowed(update.followed);
    }
    window.addEventListener(LIBRARY_CHANGE_EVENT, changed);
    return () => window.removeEventListener(LIBRARY_CHANGE_EVENT, changed);
  }, [candidate.bvid, candidate.creatorMid]);

  async function toggleFavorite() {
    if (busy) return;
    setBusy(true);
    setFeedback("");
    try {
      const response = await accountFetch(isFavorited ? `/api/favorites/${candidate.id}` : "/api/favorites", {
        method: isFavorited ? "DELETE" : "POST",
        signal: AbortSignal.timeout(15000),
        headers: { "content-type": "application/json" },
        ...(isFavorited ? {} : { body: JSON.stringify({ candidateId: candidate.id }) }),
      });
      if (!response.ok) throw new Error("收藏操作失败，请重试");
      setIsFavorited(!isFavorited);
      notifyLibraryChange({ kind: "favorite", candidateId: candidate.id, bvid: candidate.bvid, favorited: !isFavorited });
      router.refresh();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "收藏操作失败");
    } finally { setBusy(false); }
  }

  async function followCreator() {
    if (followBusy || creatorFollowed) return;
    setFollowBusy(true);
    setFeedback("");
    try {
      const response = await accountFetch("/api/creators", {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ biliMid: candidate.creatorMid, name: candidate.creatorName || undefined }),
      });
      if (!response.ok) throw new Error("关注失败，请重试");
      setCreatorFollowed(true);
      notifyLibraryChange({ kind: "creator", biliMid: candidate.creatorMid!, followed: true });
      router.refresh();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "关注失败");
    } finally { setFollowBusy(false); }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(candidate.sourceUrl);
      setCopied(true);
    } catch { setFeedback("无法复制，请从「在 B 站观看」打开原视频"); }
  }

  const cover = candidate.coverUrl?.startsWith("//") ? `https:${candidate.coverUrl}` : candidate.coverUrl;
  const duration = candidate.durationSeconds ? `${Math.floor(candidate.durationSeconds / 60)}:${String(candidate.durationSeconds % 60).padStart(2, "0")}` : "--:--";

  return (
    <article className="candidateCard">
      <span className="trackIndex">{String(index + 1).padStart(2, "0")}</span>
      <div className="cardCoverWrap">
        {cover && !imageFailed ? <img src={cover} alt="" className="cardCover" loading="lazy" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /> : <div className={`cardCover cardCoverFallback coverTone${index % 4}`}><MusicIcon size={38} /><span>B-MUSIC</span></div>}
        <span className="durationBadge">{duration}</span>
        <button type="button" className="cardPlayOverlayBtn" onClick={() => playCandidate(candidate)} aria-label={`播放 ${candidate.title}`}><PlayIcon size={20} /></button>
      </div>
      <div className="cardBody">
        <Link href={`/candidates/${candidate.id}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`} className="cardTitle" title={candidate.title}>{candidate.title}</Link>
        <div className="cardAuthorRow">
          <span className="cardAuthorName">{candidate.creatorName || "未知 UP 主"}</span>
          {creatorFollowed && <span className="authorFollowedBadge">已关注</span>}
        </div>
      </div>
      <div className="cardFooter">
        <span className="cardCategory">{candidate.category || "音乐视频"}</span>
        <div className="cardActionGroup">
          <button type="button" className={`cardIconAction ${isFavorited ? "isFavorited" : "ghost"}`} onClick={() => void toggleFavorite()} disabled={busy} aria-label={isFavorited ? "取消收藏" : "加入收藏"} aria-pressed={isFavorited} title={isFavorited ? "取消收藏" : "加入收藏"}><HeartIcon size={17} filled={isFavorited} /></button>
          <details className="cardMore" name="candidate-more" onToggle={(event) => {
            const details = event.currentTarget;
            if (!details.open) return;
            details.dataset.placement = "below";
            const panel = details.querySelector(".cardMorePanel");
            const dockTop = document.querySelector(".playerDock")?.getBoundingClientRect().top ?? window.innerHeight;
            if (panel && panel.getBoundingClientRect().bottom > dockTop - 12 && details.getBoundingClientRect().top > panel.getBoundingClientRect().height + 12) details.dataset.placement = "above";
          }} onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
            <summary aria-label={`更多操作：${candidate.title}`} title="更多操作"><span aria-hidden="true">•••</span></summary>
            <div className="cardMorePanel">
              <button type="button" onClick={(event) => { const details = event.currentTarget.closest("details"); if (details) details.open = false; openPlaylistPicker(candidate); }}><ListMusicIcon size={15} />加入歌单</button>
              <button type="button" onClick={() => downloadCandidate(candidate)}><DownloadIcon size={15} />下载到设备</button>
              {candidate.creatorMid && (creatorFollowed ? <Link href="/creators"><UsersIcon size={15} />管理关注</Link> : <button type="button" disabled={followBusy} onClick={() => void followCreator()}><UsersIcon size={15} />关注这位 UP 主</button>)}
              <button type="button" onClick={() => void copyLink()}>{copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}{copied ? "链接已复制" : "复制视频链接"}</button>
              <a href={candidate.sourceUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon size={15} />在 B 站观看</a>
            </div>
          </details>
        </div>
        {extraActions}
      </div>
      {feedback && <p className="cardFeedback" role="alert">{feedback}</p>}
    </article>
  );
}
