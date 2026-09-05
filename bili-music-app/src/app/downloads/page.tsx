import { CandidateList } from "@/components/CandidateList";
import { getCandidateById, listTracks } from "@/lib/db";
import { currentAppOwnerId } from "@/lib/appOwner";
import { toCandidateItem } from "@/lib/search/cache";
import { DownloadIcon, HardDriveIcon } from "@/components/Icons";
import type { CandidateItem } from "@/lib/models";

export const dynamic = "force-dynamic";

export default async function DownloadsPage() {
  const ownerId = await currentAppOwnerId();
  const tracks = listTracks(100, ownerId, 0, "ready");
  const candidates = tracks
    .map((t) => {
      const cand = getCandidateById(t.candidateId);
      return cand ? toCandidateItem(cand) : null;
    })
    .filter((candidate): candidate is CandidateItem => candidate !== null);

  return (
    <>
      <header className="pageHeader">
        <div className="pageTitleRow">
          <div className="pageIcon cyan">
            <DownloadIcon size={20} />
          </div>
          <span className="sectionKicker">OFFLINE MUSIC</span>
        </div>
        <h1>下载与离线</h1>
        <p>内核已准备好的曲目，可以播放或下载到你的设备。已下载的文件请在设备的下载目录中查看。</p>
      </header>

      <div className="collectionToolbar">
        <div>
          <span>已就绪曲目</span>
          <strong>{candidates.length}</strong>
        </div>
        <span className="collectionHint">
          <HardDriveIcon size={12} />
          本地内核自动管理缓存生命周期
        </span>
      </div>

      <CandidateList
        candidates={candidates}
        title="可下载的音乐"
        emptyTitle="还没有准备好的音乐"
        emptyDescription="播放一首歌，或在曲目的「更多操作」中选择下载，准备完成后会出现在这里"
      />
    </>
  );
}
