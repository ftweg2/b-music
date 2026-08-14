"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  ["发现音乐", "/search"],
  ["收藏", "/favorites"],
  ["离线下载", "/downloads"],
  ["关注 UP", "/creators"],
  ["设置", "/settings"]
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brandMark">音</div>
        <h1>Bili 音乐发现</h1>
        <p>发现、播放，也能下载到设备离线听。</p>
      </div>
      <nav className="nav">
        {links.map(([label, href]) => (
          <Link className={pathname === href ? "active" : ""} href={href} key={href}>
            <span>{label}</span>
            <span>›</span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}
