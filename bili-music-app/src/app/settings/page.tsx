import { kernelBaseUrl } from "@/lib/kernelClient";
import { providerMode } from "@/lib/search/provider";

export default function SettingsPage() {
  return (
    <>
      <header className="pageHeader">
        <h2>设置</h2>
        <p>当前只配置 App 层参数；音频准备会在后续通过 HTTP 接入外部内核。</p>
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
              <th>内核地址占位</th>
              <td>{kernelBaseUrl()}</td>
            </tr>
            <tr>
              <th>内核搜索 profile</th>
              <td>{process.env.KERNEL_PROFILE_ID || "页面搜索时手动填写"}</td>
            </tr>
            <tr>
              <th>内核 owner</th>
              <td>{process.env.KERNEL_EXTERNAL_OWNER_ID || "local / 页面搜索时手动填写"}</td>
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
        <h3 className="panelTitle">后续动作</h3>
        <p className="note">
          当前播放器通过 HTTP 调用外部内核准备 `audio.m4a`，再由 `/api/tracks/:id/stream`
          代理给浏览器原生 audio 播放。App 不实现提取，也不下载或保存音频文件。
        </p>
      </section>
    </>
  );
}
