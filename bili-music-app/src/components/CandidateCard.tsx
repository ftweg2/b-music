"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { CandidateWithScore, InteractionAction } from "@/lib/models";
import { makeReturnTo } from "@/lib/navigation";
import { downloadCandidate, playCandidate, prewarmCandidate } from "./PlayerDock";

export function CandidateCard({ candidate }: { candidate: CandidateWithScore }) {
  const [status, setStatus] = useState<string>("");
  const [imageFailed, setImageFailed] = useState(false);
  const [returnTo, setReturnTo] = useState("/");
  const [favorited, setFavorited] = useState(candidate.isFavorited);
  const showImage = Boolean(candidate.coverUrl) && !imageFailed;
  const detailHref = useMemo(() => {
    return `/candidates/${candidate.id}?returnTo=${encodeURIComponent(returnTo)}`;
  }, [candidate.id, returnTo]);

  useEffect(() => {
    setReturnTo(makeReturnTo(window.location.pathname, window.location.search));
  }, []);

  useEffect(() => {
    setFavorited(candidate.isFavorited);
  }, [candidate.isFavorited]);

  async function interact(action: InteractionAction, quiet = false) {
    if (!quiet) {
      setStatus("保存中...");
    }
    try {
      const response = await fetch(`/api/candidates/${candidate.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "记录失败");
      }
      if (!quiet) {
        setStatus(actionLabel(action));
      }
    } catch (error) {
      if (!quiet) {
        setStatus(String(error instanceof Error ? error.message : error));
      }
    }
  }

  async function toggleFavorite() {
    setStatus(favorited ? "正在移出收藏..." : "正在加入收藏...");
    try {
      const response = await fetch(favorited ? `/api/favorites/${candidate.id}` : "/api/favorites", {
        method: favorited ? "DELETE" : "POST",
        headers: favorited ? undefined : { "content-type": "application/json" },
        body: favorited ? undefined : JSON.stringify({ candidateId: candidate.id, bvid: candidate.bvid })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "收藏操作失败");
      }
      setFavorited(!favorited);
      setStatus(favorited ? "已移出收藏" : "已收藏到音乐库");
    } catch (error) {
      setStatus(String(error instanceof Error ? error.message : error));
    }
  }

  async function followCreator() {
    if (!candidate.creatorMid || !candidate.creatorName) {
      setStatus("这个候选没有可关注的 UP 信息");
      return;
    }
    setStatus("正在关注 UP...");
    try {
      const response = await fetch("/api/creators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          biliMid: candidate.creatorMid,
          name: candidate.creatorName,
          homepageUrl: `https://space.bilibili.com/${candidate.creatorMid}`,
          priorityWeight: 70
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "关注 UP 失败");
      }
      setStatus("已关注 UP，后续搜索会优先加权");
    } catch (error) {
      setStatus(String(error instanceof Error ? error.message : error));
    }
  }

  function queueForPrewarm() {
    prewarmCandidate(candidate);
    void interact("queued", true);
    setStatus("已加入播放队列，后台会尽量提前准备");
  }

  return (
    <article className="candidateCard">
      <div className="cover">
        {showImage ? (
          <img
            src={imageSrc(candidate.coverUrl)}
            alt={`${candidate.title} 封面`}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <CoverFallback bvid={candidate.bvid} title={candidate.title} />
        )}
      </div>

      <div>
        <div className="candidateTop">
          <div>
            <h3 className="candidateTitle">{candidate.title}</h3>
            <p className="meta">
              UP：{candidate.creatorName || "未知"} {candidate.creatorMid ? `(${candidate.creatorMid})` : ""}
              {" · "}
              时长：{formatDuration(candidate.durationSeconds)}
              {" · "}
              发布：{formatDate(candidate.pubTime)}
            </p>
          </div>
        </div>

        <div className="row">
          <button type="button" onClick={() => playCandidate(candidate)}>播放</button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              downloadCandidate(candidate);
              setStatus("正在准备下载，完成后浏览器会保存音频");
            }}
          >
            下载
          </button>
          <button type="button" className={favorited ? "favoriteActive" : "secondary"} onClick={() => void toggleFavorite()}>
            {favorited ? "已收藏" : "收藏"}
          </button>
          <button type="button" className="secondary" onClick={() => void followCreator()} disabled={!candidate.creatorMid}>
            关注 UP
          </button>
          <Link className="buttonLink secondary" href={detailHref} onClick={() => void interact("viewed", true)}>
            看详情
          </Link>
          <button type="button" className="secondary" onClick={() => interact("disliked")}>不喜欢</button>
          <button type="button" className="secondary" onClick={queueForPrewarm}>加入队列</button>
          <a className="buttonLink ghost" href={candidate.sourceUrl} target="_blank" rel="noreferrer">
            打开 B 站
          </a>
          <span className="note">{status}</span>
        </div>
      </div>
    </article>
  );
}

function imageSrc(value: string | null): string {
  if (!value) {
    return "";
  }
  if (value.startsWith("/")) {
    return value;
  }
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (["i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com"].includes(url.hostname)) {
      return `/api/image-proxy?url=${encodeURIComponent(url.toString())}`;
    }
    return url.toString();
  } catch {
    return value;
  }
}

function CoverFallback({ bvid, title }: { bvid: string; title: string }) {
  return (
    <div className="coverFallback" aria-label={`${title} 封面`}>
      <div>
        <div className="coverBars">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <strong>{shortTitle(title)}</strong>
        <small>{bvid}</small>
      </div>
    </div>
  );
}

function shortTitle(title: string): string {
  return title.length > 16 ? `${title.slice(0, 16)}...` : title;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) {
    return "未知";
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatDate(value: string | null): string {
  if (!value) {
    return "未知";
  }
  return new Date(value).toLocaleDateString("zh-CN");
}

function actionLabel(action: InteractionAction): string {
  const labels: Record<InteractionAction, string> = {
    viewed: "已看过",
    liked: "已喜欢",
    disliked: "已标记不喜欢",
    skipped: "已跳过",
    queued: "已加入稍后提取",
    extraction_failed: "已记录提取失败"
  };
  return labels[action];
}
