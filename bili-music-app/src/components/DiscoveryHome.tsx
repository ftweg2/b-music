"use client";
import { accountFetch } from "@/lib/accountClient";

import Link from "next/link";
import { LIBRARY_CHANGE_EVENT } from "@/lib/libraryEvents";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PLAYLIST_CHANGE_EVENT } from "@/lib/playlistClient";
import type { CandidateItem, Playlist } from "@/lib/models";
import { CandidateList } from "./CandidateList";
import { ArrowLeftIcon, HeartIcon, SearchIcon, ListMusicIcon, UsersIcon } from "./Icons";

const moods = [
  { title: "慢下来", english: "SLOW MOMENTS", description: "轻音乐 · 治愈 · 放空", keyword: "治愈 轻音乐", art: "slow" },
  { title: "专注此刻", english: "STAY FOCUSED", description: "Lo-fi · 钢琴 · 纯音乐", keyword: "lofi 学习 纯音乐", art: "focus" },
  { title: "旧时光", english: "BACK IN TIME", description: "华语 · 经典 · 回忆", keyword: "华语 经典 老歌", art: "retro" },
  { title: "夜色正好", english: "AFTER HOURS", description: "爵士 · R&B · 城市漫游", keyword: "爵士 R&B 夜晚", art: "night" },
];

export function DiscoveryHome() {
  const router = useRouter();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [favorites, setFavorites] = useState<CandidateItem[]>([]);
  const [libraryState, setLibraryState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    // Read local favorite metadata only; never initiate remote discovery on page load.
    const refresh = () => accountFetch("/api/favorites?limit=4", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取收藏");
        return response.json();
      })
      .then((data) => { setFavorites((data.candidates || []).slice(0, 4)); setLibraryState("ready"); })
      .catch(() => { if (!controller.signal.aborted) setLibraryState("error"); });
    void refresh();
    window.addEventListener(LIBRARY_CHANGE_EVENT, refresh);
    return () => { controller.abort(); window.removeEventListener(LIBRARY_CHANGE_EVENT, refresh); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => { void accountFetch("/api/playlists", { signal: controller.signal }).then((response) => response.ok ? response.json() : null).then((data) => { if (data && !controller.signal.aborted) setPlaylists(data.playlists.slice(0, 4)); }).catch(() => {}); };
    const focus = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); router.push("/search"); } };
    load(); window.addEventListener(PLAYLIST_CHANGE_EVENT, load); window.addEventListener("keydown", focus);
    return () => { controller.abort(); window.removeEventListener(PLAYLIST_CHANGE_EVENT, load); window.removeEventListener("keydown", focus); };
  }, [router]);

  return (
    <div className="discoveryHome">
      <div className="discoveryTopbar"><span>你的私人音乐空间</span><Link href="/search" className="discoverySearchLink"><SearchIcon size={16} />找一首想听的歌 <kbd>Ctrl K</kbd></Link></div>
      <header className="discoveryHeading">
        <div><span className="sectionKicker">A LITTLE MUSIC, A BETTER DAY</span><h1>发现音乐</h1></div>
        <p>总有一段旋律，刚好懂你。</p>
      </header>
      <section className="listeningHero" aria-labelledby="listening-title">
        <div className="listeningHeroCopy">
          <span className="heroLabel"><span /> 给自己一首歌的时间</span>
          <h2 id="listening-title">把时间，<br />交给音乐。</h2>
          <p>从 B 站的万千声音里，<br />发现让你愿意单曲循环的那一个。</p>
          <Link className="button heroExplore" href="/search?q=独立音乐%20宝藏%20现场&run=1" prefetch={false}>
            <SearchIcon size={16} /> 探索好音乐 <ArrowLeftIcon size={16} className="arrowRight" />
          </Link>
        </div>
        <div className="recordComposition" aria-hidden="true">
          <div className="recordOrbit" />
          <div className="vinylRecord"><div className="vinylLabel"><span>B</span><small>SIDE A · 33⅓ RPM</small><i /></div></div>
          <div className="recordSleeve">
            <span className="sleeveEdition">THE B-MUSIC COLLECTION<br />VOL. 01 / EVERYDAY LISTENING</span>
            <div className="sleeveArt"><i /><i /><i /></div>
            <span className="sleeveTitle">ordinary<br /><em>moments.</em></span>
            <span className="sleeveFooter">SOUNDS TO LIVE BY <span>↗</span></span>
          </div>
          <span className="recordCaption">LESS NOISE. MORE MUSIC.</span>
        </div>
        <div className="heroEdition">精选探索 · 发现属于你的声音 <span>01 — 04</span></div>
      </section>
      <nav className="homeLibraryLinks" aria-label="我的音乐快捷入口">
        <Link href="/playlists"><ListMusicIcon size={21} /><span><strong>我的歌单</strong><small>整理属于你的音乐时刻</small></span><span>↗</span></Link>
        <Link href="/favorites"><HeartIcon size={21} /><span><strong>我的收藏</strong><small>回到让你心动的旋律</small></span><span>↗</span></Link>
        <Link href="/creators"><UsersIcon size={21} /><span><strong>关注的 UP</strong><small>看看喜欢的创作者</small></span><span>↗</span></Link>
      </nav>
      {playlists.length > 0 && <section className="homeLibrary"><div className="sectionHeading"><h2>为喜欢的声音，留个位置</h2><Link className="textLink" href="/playlists">全部歌单 ↗</Link></div><div className="homePlaylistGrid">{playlists.map((playlist) => <Link href={`/playlists/${playlist.id}`} key={playlist.id}><ListMusicIcon size={25} /><strong>{playlist.name}</strong><span>{playlist.trackCount} 首音乐</span></Link>)}</div></section>}
      <section className="moodSection" aria-labelledby="mood-heading">
        <div className="sectionHeading"><div><h2 id="mood-heading">此刻，想听什么？</h2><p>选一种心情，让音乐接着说。</p></div><span className="sectionAside">按心情探索</span></div>
        <div className="moodGrid">
          {moods.map((mood) => <Link key={mood.art} className={`moodCard mood-${mood.art}`} href={`/search?q=${encodeURIComponent(mood.keyword)}&run=1`} prefetch={false} aria-label={`探索${mood.title}：${mood.description}`}>
            <div className="moodArtwork" aria-hidden="true"><span className="moodEnglish">{mood.english}</span><div className="moodShape"><i /><i /><i /><i /></div><span className="moodArrow">↗</span></div>
            <span className="moodTitle">{mood.title}</span><span className="moodDescription">{mood.description}</span>
          </Link>)}
        </div>
      </section>
      <section className="homeLibrary" aria-labelledby="home-library-heading">
        <div className="sectionHeading"><div><h2 id="home-library-heading">喜欢的，值得再听</h2><p>你的音乐收藏，随时回到熟悉的旋律。</p></div><Link className="textLink" href="/favorites">全部收藏 <span>↗</span></Link></div>
        {libraryState === "loading" ? <div className="libraryEmpty" role="status">正在读取你的音乐收藏…</div> : favorites.length ? <CandidateList candidates={favorites} title="最近收藏" hideHeading /> : <div className="libraryEmpty">
          <span className="libraryEmptyIcon"><HeartIcon size={22} /></span>
          <div><strong>{libraryState === "error" ? "收藏暂时无法加载" : "留住第一次心动的声音"}</strong><p>{libraryState === "error" ? "可以前往收藏页重试，或继续探索音乐。" : "在搜索结果里轻点爱心，慢慢建立你的私人音乐库。"}</p></div>
          <Link className="textLink" href={libraryState === "error" ? "/favorites" : "/search"}>{libraryState === "error" ? "查看收藏" : "去发现"} <span>↗</span></Link>
        </div>}
      </section>
      <footer className="discoveryFooter"><span>B-Music.</span><span>音乐不止一种，喜欢由你定义。</span></footer>
    </div>
  );
}
