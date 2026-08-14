import Link from "next/link";

import { SearchBox } from "@/components/SearchBox";

export default function HomePage() {
  return (
    <>
      <header className="pageHeader">
        <h2>今天想从 B 站淘哪首歌？</h2>
        <p>输入关键词，先把候选视频排出来。关注 UP 和收藏视频会自动靠前，准备好后可在线播放或下载到设备离线听。</p>
      </header>

      <SearchBox />

      <section className="guideStrip">
        <div className="metric">
          <strong>01</strong>
          <span>搜索候选视频</span>
        </div>
        <div className="metric">
          <strong>02</strong>
          <span>关注 UP / 收藏自动加权</span>
        </div>
        <div className="metric">
          <strong>03</strong>
          <span>在线播放 / 下载离线</span>
        </div>
        <div className="guideActions">
          <Link className="buttonLink secondary" href="/creators">关注 UP</Link>
          <Link className="buttonLink ghost" href="/favorites">打开收藏</Link>
          <Link className="buttonLink ghost" href="/downloads">离线下载</Link>
        </div>
      </section>
    </>
  );
}
