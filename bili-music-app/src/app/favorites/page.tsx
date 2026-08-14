import { CandidateList } from "@/components/CandidateList";
import { currentAppOwnerId } from "@/lib/appOwner";
import { favoriteBvids, listFavoriteVideos } from "@/lib/db";
import { toCandidateWithScore } from "@/lib/search/cache";

export const dynamic = "force-dynamic";

export default async function FavoritesPage() {
  const ownerId = await currentAppOwnerId();
  const rows = listFavoriteVideos(100, ownerId);
  const candidates = rows.map((row) => row.candidate);
  const favorites = favoriteBvids(candidates.map((candidate) => candidate.bvid), ownerId);
  const withScores = candidates.map((candidate) => toCandidateWithScore(candidate, undefined, favorites.has(candidate.bvid)));

  return (
    <>
      <header className="pageHeader">
        <h2>收藏</h2>
        <p>这里是 App 自己记住的收藏候选视频，不会同步到 B 站；需要时可单独下载到设备离线听。</p>
      </header>
      <section className="panel">
        <h3 className="panelTitle">收藏夹</h3>
        <p className="note">
          收藏会影响搜索排序：你收藏过的视频、关注 UP 的视频，会更容易回到前面。
        </p>
      </section>
      {withScores.length ? <CandidateList candidates={withScores} /> : <div className="empty">收藏夹还空着。搜索结果里点“收藏”就会加入这里。</div>}
    </>
  );
}
