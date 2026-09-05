"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CompassIcon, SearchIcon, HeartIcon, DownloadIcon, UsersIcon, SettingsIcon, MusicIcon, ListMusicIcon } from "./Icons";

const groups = [
  { label: "探索", items: [
    { href: "/", label: "发现音乐", shortLabel: "发现", icon: CompassIcon },
    { href: "/search", label: "搜索", shortLabel: "搜索", icon: SearchIcon },
  ] },
  { label: "我的音乐", items: [
    { href: "/favorites", label: "我的收藏", shortLabel: "收藏", icon: HeartIcon },
    { href: "/playlists", label: "我的歌单", shortLabel: "歌单", icon: ListMusicIcon },
    { href: "/creators", label: "关注的 UP 主", shortLabel: "关注", icon: UsersIcon },
    { href: "/downloads", label: "下载与离线", shortLabel: "下载", icon: DownloadIcon },
  ] },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <Link href="/" className="brand" aria-label="B-Music 首页">
        <span className="brandIconWrap"><MusicIcon size={21} /></span>
        <span className="brandInfo"><span className="brandTitle">B-Music<span className="brandPeriod">.</span></span></span>
      </Link>
      <nav className="sidebarNav" aria-label="主导航">
        {groups.map((group) => (
          <div className="navGroup" key={group.label}>
            <div className="navSectionLabel">{group.label}</div>
            {group.items.map(({ href, label, shortLabel, icon: Icon }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return <Link key={href} href={href} aria-label={label} className={`navItem ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}>
                <Icon size={19} /><span className="navLabel">{label}</span><span className="navMobileLabel">{shortLabel}</span>
              </Link>;
            })}
          </div>
        ))}
      </nav>
      <div className="sidebarFooter">
        <div className="sidebarListeningNote">
          <span className="miniWave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
          <p>好音乐，<br />值得慢慢发现。</p>
          <span>YOUR OWN MUSIC SPACE</span>
        </div>
        <Link href="/settings" aria-label="设置" className={`navItem ${pathname === "/settings" ? "active" : ""}`} aria-current={pathname === "/settings" ? "page" : undefined}>
          <SettingsIcon size={19} /><span className="navLabel">设置</span>
        </Link>
        <div className="sidebarSignature">BILIBILI SOUNDS. YOUR WAY.</div>
      </div>
      <Link className="mobileSettings" href="/settings" aria-label="设置"><SettingsIcon size={19} /></Link>
    </aside>
  );
}
