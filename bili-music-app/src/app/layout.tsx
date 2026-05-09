import type { Metadata } from "next";

import { PlayerDock } from "@/components/PlayerDock";
import { Sidebar } from "@/components/Sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bili 音乐发现",
  description: "Bilibili 音乐候选视频发现 App"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="shell">
          <Sidebar />
          <main className="content">{children}</main>
        </div>
        <PlayerDock />
      </body>
    </html>
  );
}
