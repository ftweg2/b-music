import type { Metadata } from "next";

import { PlayerDock } from "@/components/PlayerDock";
import { Sidebar } from "@/components/Sidebar";
import { PlaylistPicker } from "@/components/PlaylistPicker";
import { AccountSync } from "@/components/AccountSync";
import "./globals.css";

export const metadata: Metadata = {
  title: "B-Music · 让好音乐发生",
  description: "发现 Bilibili 里值得听的声音，建立自己的私人音乐收藏。"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body>
        <AccountSync />
        <a className="skipLink" href="#main-content">跳到主要内容</a>
        <div className="shell">
          <Sidebar />
          <main className="content" id="main-content">{children}</main>
        </div>
        <PlayerDock />
        <PlaylistPicker />
      </body>
    </html>
  );
}
