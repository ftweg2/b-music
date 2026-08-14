import Link from "next/link";

import { currentAppOwnerId } from "@/lib/appOwner";
import { listTracks, markExpiredReadyTracks } from "@/lib/db";
import { toTrackApiResource } from "@/lib/trackApi";
import { getSyncedTracks } from "@/lib/tracks";

export const dynamic = "force-dynamic";

export default async function DownloadsPage() {
  markExpiredReadyTracks();
  const ownerId = await currentAppOwnerId();
  const listed = listTracks(100, ownerId);
  const preparingTracks = listed.filter((track) => track.status === "preparing").slice(0, 20);
  const syncedPreparing = await getSyncedTracks(preparingTracks.map((track) => track.id), ownerId);
  const syncedById = new Map(syncedPreparing.filter((track) => track !== null).map((track) => [track.id, track]));
  const tracks = listed.map((track) => toTrackApiResource(syncedById.get(track.id) || track));
  const ready = tracks.filter((track) => track.status === "ready").length;
  const preparingCount = tracks.filter((track) => track.status === "preparing").length;

  return (
    <>
      <header className="pageHeader">
        <h2>离线下载</h2>
        <p>音频由 App API 流式交给浏览器或手机系统保存；App 服务器不额外复制音频文件。</p>
      </header>
      <section className="metricStrip">
        <div className="metric"><strong>{ready}</strong><span>可下载</span></div>
        <div className="metric"><strong>{preparingCount}</strong><span>准备中</span></div>
        <div className="metric"><strong>{tracks.length}</strong><span>最近任务</span></div>
      </section>
      <section className="panel downloadPanel">
        <div className="row downloadHeader">
          <h3 className="panelTitle">下载任务</h3>
          <Link className="buttonLink secondary" href="/downloads">刷新状态</Link>
          <Link className="buttonLink ghost" href="/search">继续找歌</Link>
        </div>
        <p className="note">支持断点续传与 SHA-256 校验。已保存到设备的文件在断网后仍可用系统播放器收听。</p>
        {tracks.length ? (
          <div className="tableWrap">
            <table className="table downloadTable">
              <thead><tr><th>歌曲</th><th>状态</th><th>大小 / 校验</th><th>有效期</th><th>操作</th></tr></thead>
              <tbody>
                {tracks.map((track) => (
                  <tr key={track.id}>
                    <td data-label="歌曲"><strong>{track.title}</strong><br /><small>{track.bvid}</small></td>
                    <td data-label="状态"><span className={`badge ${track.status === "ready" ? "green" : "blue"}`}>{statusLabel(track.status)}</span></td>
                    <td data-label="大小 / 校验">
                      <span>{formatBytes(track.media.sizeBytes)}</span>
                      {track.media.checksum ? <><br /><code title={track.media.checksum.value}>{shortHash(track.media.checksum.value)}</code></> : null}
                    </td>
                    <td data-label="有效期">{formatDate(track.media.expiresAt)}</td>
                    <td data-label="操作">
                      {track.media.downloadUrl ? (
                        <a className="buttonLink secondary" href={track.media.downloadUrl} download={track.media.fileName || undefined}>下载</a>
                      ) : (
                        <Link className="buttonLink ghost" href={`/candidates/${track.candidateId}`}>{track.status === "preparing" ? "查看进度" : "重新准备"}</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty">还没有下载任务。去搜索结果点“下载”即可开始。</div>}
      </section>
    </>
  );
}

function statusLabel(status: string): string {
  return ({ pending: "待准备", preparing: "准备中", ready: "可下载", expired: "已过期", failed: "失败" } as Record<string, string>)[status] || status;
}

function formatBytes(value: number | null): string {
  if (!value) return "-";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}
