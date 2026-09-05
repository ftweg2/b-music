"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Playlist } from "@/lib/models";
import { PLAYLIST_CHANGE_EVENT, playlistRequest, playlistsChanged } from "@/lib/playlistClient";
import { ListMusicIcon, MusicIcon, CloseIcon } from "./Icons";

export function PlaylistLibrary({ initialPlaylists }: { initialPlaylists: Playlist[] }) {
  const [playlists, setPlaylists] = useState(initialPlaylists);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setPlaylists(initialPlaylists); }, [initialPlaylists]);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      void playlistRequest<{ playlists: Playlist[] }>("/api/playlists", { signal: controller.signal })
        .then((data) => { if (!controller.signal.aborted) setPlaylists(data.playlists); })
        .catch((err) => { if (!controller.signal.aborted) setError(err.message); });
    };
    window.addEventListener(PLAYLIST_CHANGE_EVENT, refresh);
    return () => { controller.abort(); window.removeEventListener(PLAYLIST_CHANGE_EVENT, refresh); };
  }, []);
  async function create() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const { playlist } = await playlistRequest<{ playlist: Playlist }>("/api/playlists", { method: "POST", body: JSON.stringify({ name, description }) });
      setPlaylists((items) => [playlist, ...items]); setName(""); setDescription(""); setShowCreate(false); playlistsChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "创建失败"); }
    finally { setBusy(false); }
  }
  return <>
    <header className="pageHeader playlistPageHeading"><div><div className="pageTitleRow"><div className="pageIcon"><ListMusicIcon size={20} /></div><span className="sectionKicker">YOUR PERSONAL COLLECTIONS</span></div><h1>我的歌单</h1><p>把喜欢的声音，整理成属于自己的片刻。</p></div><button type="button" onClick={() => setShowCreate(true)}>＋ 新建歌单</button></header>
    {showCreate && <section className="card playlistCreateCard"><div className="playlistDialogHeading"><h2>创建一个新歌单</h2><button type="button" className="iconBtn ghost" aria-label="取消创建歌单" onClick={() => setShowCreate(false)} disabled={busy}><CloseIcon size={18} /></button></div>
      <form onSubmit={(event) => { event.preventDefault(); void create(); }} className="playlistEditForm">
        <label>歌单名称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="例如：下班路上" required autoFocus disabled={busy} /></label>
        <label>简介（可选）<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="为这个歌单留一句话…" rows={2} disabled={busy} /></label>
        <div><button type="submit" disabled={busy || !name.trim()}>{busy ? "正在创建…" : "创建歌单"}</button></div>
      </form>
    </section>}
    {error && <p className="errorText" role="alert">{error}</p>}
    <div className="sectionHeading"><h2>你的声音收藏夹</h2><span className="resultCount">{playlists.length} 个歌单</span></div>
    {playlists.length ? <div className="playlistGrid">{playlists.map((playlist, index) => <Link key={playlist.id} href={`/playlists/${playlist.id}`} className="playlistTile">
      <div className={`playlistArtwork playlistTone${index % 4}`}>{playlist.coverUrl ? <img src={playlist.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}<MusicIcon size={45} /><span className="playlistArtworkLabel">MY PLAYLIST</span><span className="playlistOpenArrow">↗</span></div>
      <h3>{playlist.name}</h3><p>{playlist.description || "每一首，都是喜欢的理由。"}</p><span>{playlist.trackCount} 首音乐</span>
    </Link>)}</div> : <div className="empty"><div className="emptyIcon"><ListMusicIcon size={28} /></div><strong>给喜欢的音乐一个家</strong><span>创建歌单后，可从搜索、收藏或曲目详情中添加音乐。</span><button type="button" className="secondary" onClick={() => setShowCreate(true)}>创建第一个歌单</button></div>}
  </>;
}
