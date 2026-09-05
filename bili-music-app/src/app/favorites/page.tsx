import { CandidateList } from "@/components/CandidateList";
import { listFavoriteVideos } from "@/lib/db";
import { currentAppOwnerId } from "@/lib/appOwner";
import { toCandidateItems } from "@/lib/search/cache";
import { HeartIcon, SparklesIcon } from "@/components/Icons";
import type { CandidateItem } from "@/lib/models";

export const dynamic = "force-dynamic";

export default async function FavoritesPage() {
  const ownerId = await currentAppOwnerId();
  const rows = listFavoriteVideos(100, ownerId);
  const candidates = toCandidateItems(rows.map((row) => row.candidate), ownerId);

  return (
    <>
      <header className="pageHeader">
        <div className="pageTitleRow">
          <div className="pageIcon rose">
            <HeartIcon size={20} />
          </div>
          <span className="sectionKicker">YOUR LIBRARY</span>
        </div>
        <h1>我的收藏</h1>
        <p>每一次喜欢，都值得被记住。在这里，重逢那些让你心动的声音。</p>
      </header>

      <div className="collectionToolbar">
        <div>
          <span>收藏曲目</span>
          <strong>{candidates.length}</strong>
        </div>
        <span className="collectionHint">
          <SparklesIcon size={12} />
          按收藏时间倒序排列
        </span>
      </div>

      <CandidateList
        candidates={candidates}
        title="收藏曲目"
        emptyTitle="还没有收藏"
        emptyDescription="遇到喜欢的版本时，点一下心形按钮即可收进这里"
      />
    </>
  );
}
