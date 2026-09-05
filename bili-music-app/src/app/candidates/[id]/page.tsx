import Link from "next/link";
import { notFound } from "next/navigation";

import { AddToPlaylistButton, DownloadCandidateButton, PlayCandidateButton } from "@/components/PlayCandidateButton";
import { currentAppOwnerId } from "@/lib/appOwner";
import { favoriteBvids, getCandidateById, listCandidateInteractions } from "@/lib/db";
import { safeInternalReturnTo } from "@/lib/navigation";
import { toCandidateItems } from "@/lib/search/cache";
import {
  ExternalLinkIcon,
  MusicIcon,
  ArrowLeftIcon,
} from "@/components/Icons";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
};

export default async function CandidateDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const query = await searchParams;
  const returnTo = safeInternalReturnTo(query.returnTo, "/search");
  const candidate = getCandidateById(Number(id));
  if (!candidate) {
    notFound();
  }
  const ownerId = await currentAppOwnerId();
  const item = toCandidateItems([candidate], ownerId)[0];
  const interactions = listCandidateInteractions(candidate.id, ownerId);

  return (
    <div className="detailPage">
      <Link href={returnTo} className="button secondary backButton">
        <ArrowLeftIcon size={14} />
        返回列表
      </Link>

      <header className="detailHero">
        <div className="detailArtwork">
          {candidate.coverUrl ? (
            <img
              src={candidate.coverUrl}
              alt={candidate.title}
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="detailArtworkFallback"><MusicIcon size={42} /></div>
          )}
        </div>

        <div className="detailHeroContent">
          <span className="sectionKicker">CANDIDATE TRACK</span>
          <h1>{candidate.title}</h1>
          <p className="detailCreator">{candidate.creatorName ?? "未知 UP 主"}</p>

          <div className="detailBadges">
            {item.isPreferredCreator && <span className="badge accent">关注 UP 主</span>}
            {item.isFavorited && <span className="badge success">已加入收藏</span>}
            {candidate.category && <span className="badge">{candidate.category}</span>}
          </div>

          <div className="detailActions">
            <PlayCandidateButton candidate={item} />
            <AddToPlaylistButton candidate={item} />
            <DownloadCandidateButton candidate={item} />
            <a className="button secondary" href={candidate.sourceUrl} target="_blank" rel="noreferrer">
              <ExternalLinkIcon size={14} />
              在 B 站观看
            </a>
          </div>

          <dl className="detailFacts">
            <div>
              <dt>时长</dt>
              <dd>{candidate.durationSeconds ? `${Math.floor(candidate.durationSeconds / 60)}:${String(candidate.durationSeconds % 60).padStart(2, "0")}` : "--:--"}</dd>
            </div>
            <div>
              <dt>发布时间</dt>
              <dd>{formatDate(candidate.pubTime)}</dd>
            </div>
            <div>
              <dt>BVID</dt>
              <dd>{candidate.bvid}</dd>
            </div>
          </dl>
        </div>
      </header>

      <div className="detailContentGrid">

        <section className="card metadataCard">
          <div className="cardSectionHeader compact">
            <div className="sectionIcon"><MusicIcon size={16} /></div>
            <div>
              <span className="sectionKicker">METADATA</span>
              <h3>曲目元数据</h3>
            </div>
          </div>
          <div className="tableWrapper">
            <table className="table detailTable">
              <tbody>
                <Row label="BVID / AID" value={`${candidate.bvid} (${candidate.aid || "无 AID"})`} />
                <Row label="UP 主" value={`${candidate.creatorName ?? "未知"} ${candidate.creatorMid ? `[MID: ${candidate.creatorMid}]` : ""}`} />
                <Row label="时长" value={candidate.durationSeconds ? `${candidate.durationSeconds} 秒` : "-"} />
                <Row label="视频简介" value={candidate.description || "暂无简介"} />
                <Row label="命中搜索词" value={candidate.searchKeyword || "-"} />
                <Row label="提取标签" value={item.tags?.length ? item.tags.join("、 ") : "暂无标签"} />
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="card historyCard">
        <div className="cardSectionHeader compact">
          <div>
            <span className="sectionKicker">LISTENING ACTIVITY</span>
            <h3>互动历史</h3>
          </div>
        </div>
        {interactions.length ? (
          <div className="tableWrapper">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: "30%" }}>动作行为</th>
                  <th style={{ width: "70%" }}>时间戳</th>
                </tr>
              </thead>
              <tbody>
                {interactions.map((interaction) => (
                  <tr key={interaction.id}>
                    <td>
                      <span className="badge">
                        {translateAction(interaction.action)}
                      </span>
                    </td>
                    <td>
                      {interaction.createdAt}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty compactEmpty">
            <span>暂无历史播放与收藏互动记录</span>
          </div>
        )}
      </section>
    </div>
  );
}

function translateAction(action: string): string {
  const labels: Record<string, string> = {
    viewed: "查看详情",
    liked: "收藏喜欢",
    disliked: "不感兴趣",
    skipped: "已跳过",
    queued: "加入播放列表",
    extraction_failed: "解析提取失败",
  };
  return labels[action] ?? action;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "近期";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function Row({ label, value }: { label: string; value: unknown }) {
  return (
    <tr>
      <th>{label}</th>
      <td>
        {value === null || value === undefined || value === "" ? "-" : String(value)}
      </td>
    </tr>
  );
}
