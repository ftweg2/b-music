import { KernelLoginPanel } from "@/components/KernelLoginPanel";
import { SettingsIcon, ServerIcon } from "@/components/Icons";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <>
      <header className="pageHeader">
        <div className="pageTitleRow">
          <div className="pageIcon neutral">
            <SettingsIcon size={20} />
          </div>
          <span className="sectionKicker">SYSTEM & PLAYBACK</span>
        </div>
        <h1>播放与设置</h1>
        <p>管理 Bilibili 登录与播放服务，让每一次聆听顺畅发生。</p>
      </header>

      <div className="pageNarrow">
        <KernelLoginPanel />

        <section className="card settingsInfoCard">
          <div className="cardSectionHeader compact">
            <div className="sectionIcon"><ServerIcon size={18} /></div>
            <div>
              <span className="sectionKicker">PLAYBACK ENGINE</span>
              <h3>内核运行模式</h3>
            </div>
          </div>
          <div className="settingsProse">
            <ul>
              <li>
                <strong>默认极速 API DASH</strong>：通过 API DASH 准备可访问的音频，保留来源音轨；需要时可在播放器设置中切换策略。
              </li>
              <li>
                <strong>自动策略</strong>：在播放器的设置中选择自动模式，内核会按顺序尝试支持的处理方式，失败时显示原因。
              </li>
              <li>
                <strong>登录与隐私</strong>：登录状态仅保存在内核中。登录不改变原视频的访问权限，也不保证无损音质；应用只保存音乐元数据。
              </li>
            </ul>
          </div>
        </section>
      </div>
    </>
  );
}
