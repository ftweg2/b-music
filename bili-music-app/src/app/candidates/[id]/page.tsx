import Link from "next/link";
import { notFound } from "next/navigation";

import { DownloadCandidateButton, PlayCandidateButton } from "@/components/PlayCandidateButton";
import { RecommendationReasons } from "@/components/RecommendationReasons";
import { currentAppOwnerId } from "@/lib/appOwner";
import { favoriteBvids, getCandidateById, listCandidateInteractions } from "@/lib/db";
import { safeInternalReturnTo } from "@/lib/navigation";
import { toCandidateWithScore } from "@/lib/search/cache";

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
  const withScore = toCandidateWithScore(candidate, undefined, favoriteBvids([candidate.bvid], ownerId).has(candidate.bvid));
  const interactions = listCandidateInteractions(candidate.id, ownerId);

  return (
    <>
      <header className="pageHeader">
        <h2>{candidate.title}</h2>
        <p>这是候选视频 metadata。播放和音频准备会在后续通过外部内核完成。</p>
      </header>
      <section className="panel">
        <div className="row">
          {withScore.isPreferredCreator ? <span className="badge">关注 UP</span> : null}
          {withScore.isFavorited ? <span className="badge green">已收藏</span> : null}
          {candidate.category ? <span className="badge blue">{candidate.category}</span> : null}
          <PlayCandidateButton candidate={withScore} />
          <DownloadCandidateButton candidate={withScore} />
          <a className="buttonLink secondary" href={candidate.sourceUrl} target="_blank" rel="noreferrer">
            打开 B 站
          </a>
          <Link className="buttonLink ghost" href={returnTo}>
            返回结果列表
          </Link>
        </div>
        <div className="detailReasonBlock">
          <h3 className="panelTitle">推荐理由</h3>
          <RecommendationReasons candidate={withScore} />
          <p className="note">排序分数仍在后台计算，用来排先后；页面只展示能帮助你判断的理由。</p>
        </div>
      </section>
      <section className="panel">
        <h3 className="panelTitle">视频 metadata</h3>
        <div className="tableWrap">
          <table className="table">
            <tbody>
              <Row label="BV ID" value={candidate.bvid} />
              <Row label="AID" value={candidate.aid} />
              <Row label="UP" value={`${candidate.creatorName ?? "未知"} ${candidate.creatorMid ? `(${candidate.creatorMid})` : ""}`} />
              <Row label="时长（秒）" value={candidate.durationSeconds} />
              <Row label="发布时间" value={candidate.pubTime} />
              <Row label="来源" value={candidate.sourceProvider} />
              <Row label="搜索词" value={candidate.searchKeyword} />
              <Row label="简介" value={candidate.description} />
              <Row label="标签" value={withScore.tags.join(", ")} />
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h3 className="panelTitle">播放与离线</h3>
        <p className="note">播放或下载都会先通过 App API 请求内核准备音频。下载完成后由浏览器或手机系统保存在本机。</p>
        <div className="row">
          <PlayCandidateButton candidate={withScore} />
          <DownloadCandidateButton candidate={withScore} />
        </div>
      </section>
      <section className="panel">
        <h3 className="panelTitle">互动记录</h3>
        {interactions.length ? (
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th>动作</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {interactions.map((interaction) => (
                  <tr key={interaction.id}>
                    <td>{translateAction(interaction.action)}</td>
                    <td>{interaction.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">还没有互动记录。</div>
        )}
      </section>
    </>
  );
}

function translateAction(action: string): string {
  const labels: Record<string, string> = {
    viewed: "看过",
    liked: "喜欢",
    disliked: "不喜欢",
    skipped: "跳过",
    queued: "稍后提取",
    extraction_failed: "提取失败"
  };
  return labels[action] ?? action;
}

function Row({ label, value }: { label: string; value: unknown }) {
  return (
    <tr>
      <th>{label}</th>
      <td>{value === null || value === undefined || value === "" ? "-" : String(value)}</td>
    </tr>
  );
}
