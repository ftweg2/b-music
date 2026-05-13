import { kernelBaseUrl } from "@/lib/kernelClient";
import { providerMode } from "@/lib/search/provider";

export default function SettingsPage() {
  return (
    <>
      <header className="pageHeader">
        <h2>设置</h2>
        <p>App 负责音乐库和播放体验；登录态、音频准备和临时 artifact 都由内核通过 HTTP 承担。</p>
      </header>
      <section className="panel">
        <table className="table">
          <tbody>
            <tr>
              <th>应用</th>
              <td>{process.env.NEXT_PUBLIC_APP_NAME || "bili-music-app"}</td>
            </tr>
            <tr>
              <th>搜索源</th>
              <td>{providerMode()}</td>
            </tr>
            <tr>
              <th>内核地址</th>
              <td>{kernelBaseUrl()}</td>
            </tr>
            <tr>
              <th>账号模式</th>
              <td>{process.env.APP_SINGLE_USER_MODE === "0" ? "多账号兼容模式" : "单账号同步模式"}</td>
            </tr>
            <tr>
              <th>Track artifact TTL</th>
              <td>{process.env.TRACK_ARTIFACT_TTL_SECONDS || "86400"} 秒</td>
            </tr>
            <tr>
              <th>播放方式</th>
              <td>App 只做 Range 流式代理，不保存音频文件</td>
            </tr>
            <tr>
              <th>存储模式</th>
              <td>SQLite，只存候选和 Track metadata</td>
            </tr>
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h3 className="panelTitle">运行边界</h3>
        <p className="note">
          扫码登录会自动使用默认内核 profile。网页端和手机端访问同一个 App 服务时，共享同一个收藏歌曲和喜欢的 UP 列表。
          App 只保存候选、收藏和 Track metadata；音频 artifact 留在内核，由 `/api/tracks/:id/stream` 代理给浏览器播放。
        </p>
      </section>
    </>
  );
}
