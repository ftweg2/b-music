"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { PlaylistDetail } from "@/lib/models";
import { playlistRequest, playlistsChanged } from "@/lib/playlistClient";
import { CandidateList } from "./CandidateList";
import { playPlaylist, queuePlaylist } from "./PlayerDock";
import { ArrowLeftIcon, ListMusicIcon, PlayIcon, ShuffleIcon, TrashIcon, ChevronUpIcon, ChevronDownIcon } from "./Icons";

export function PlaylistDetailView({ initialPlaylist }: { initialPlaylist: PlaylistDetail }) {
  const router = useRouter();
  const [playlist, setPlaylist] = useState(initialPlaylist);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialPlaylist.name);
  const [description, setDescription] = useState(initialPlaylist.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setPlaylist(initialPlaylist); }, [initialPlaylist]);
  const candidates = playlist.items.map((item) => item.candidate);
  async function refresh() {
    const data = await playlistRequest<{ playlist: PlaylistDetail }>(`/api/playlists/${playlist.id}`);
    setPlaylist(data.playlist); playlistsChanged();
  }
  async function mutate(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "操作失败"); }
    finally { setBusy(false); }
  }
  async function remove(itemId: number) {
    await mutate(() => playlistRequest(`/api/playlists/${playlist.id}/items/${itemId}`, { method: "DELETE" }));
  }
  async function move(index: number, delta: number) {
    const ids = playlist.items.map((item) => item.id);
    const other = index + delta;
    if (other < 0 || other >= ids.length) return;
    [ids[index], ids[other]] = [ids[other], ids[index]];
    await mutate(() => playlistRequest(`/api/playlists/${playlist.id}/items`, { method: "PATCH", body: JSON.stringify({ itemIds: ids }) }));
  }
  async function save() {
    await mutate(async () => {
      await playlistRequest(`/api/playlists/${playlist.id}`, { method: "PATCH", body: JSON.stringify({ name, description }) });
      setEditing(false);
    });
  }
  async function destroy() {
    if (busy || !window.confirm(`删除歌单「${playlist.name}」？只删除这个歌单，不影响收藏或其他歌单，删除后无法撤销。`)) return;
    setBusy(true); setError("");
    try {
      await playlistRequest(`/api/playlists/${playlist.id}`, { method: "DELETE" });
      playlistsChanged(); router.replace("/playlists"); router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "删除失败"); setBusy(false); }
  }
  return <div className="playlistDetail">
    <Link href="/playlists" className="textLink playlistBack"><ArrowLeftIcon size={15} />我的歌单</Link>
    <header className="playlistHero"><div className="playlistDetailArtwork"><ListMusicIcon size={52} /><span>PERSONAL PLAYLIST</span></div><div className="playlistHeroText"><span className="sectionKicker">MADE BY YOU</span><h1>{playlist.name}</h1><p>{playlist.description || "这一刻，让喜欢的音乐陪着你。"}</p><span className="playlistMeta">{playlist.items.length} 首音乐 · 按自定义顺序播放</span></div></header>
    <div className="playlistControls"><div className="row"><button type="button" onClick={() => playPlaylist(candidates)} disabled={!candidates.length || busy}><PlayIcon size={15} />播放全部</button><button type="button" className="secondary" onClick={() => playPlaylist(candidates, true)} disabled={!candidates.length || busy}><ShuffleIcon size={15} />随机播放</button><button type="button" className="secondary" onClick={() => queuePlaylist(candidates)} disabled={!candidates.length || busy}><ListMusicIcon size={15} />加入播放队列</button></div><div className="row"><button type="button" className="ghost" disabled={busy} onClick={() => { setName(playlist.name); setDescription(playlist.description); setEditing(!editing); }}>编辑歌单</button><button type="button" className="iconBtn ghost" title="删除歌单" aria-label="删除歌单" disabled={busy} onClick={() => void destroy()}><TrashIcon size={16} /></button></div></div>
    {editing && <section className="card playlistCreateCard"><form className="playlistEditForm" onSubmit={(event) => { event.preventDefault(); void save(); }}><label>歌单名称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required disabled={busy} /></label><label>简介<textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} disabled={busy} /></label><div className="row"><button type="submit" disabled={busy || !name.trim()}>保存修改</button><button type="button" className="secondary" onClick={() => setEditing(false)} disabled={busy}>取消</button></div></form></section>}
    {error && <div className="playlistFeedback errorText" role="alert">{error}<button type="button" className="textLink" onClick={() => void mutate(async () => {})} disabled={busy}>刷新歌单</button></div>}
    <div className="playlistTrackHeading"><span>搜索到喜欢的音乐，选择「加入歌单」即可保存到这里。</span><Link className="textLink" href="/search">添加音乐 ↗</Link></div>
    <div className="playlistTracks"><CandidateList candidates={candidates} title="歌单曲目" defaultView="list" emptyTitle="歌单还是空的" emptyDescription="去搜索一首歌，从「更多操作 → 加入歌单」开始。" renderActions={(_candidate, index) => <div className="playlistTrackActions">
      <button type="button" className="iconBtn ghost" title="上移" aria-label={`上移第 ${index + 1} 首`} onClick={() => void move(index, -1)} disabled={busy || index === 0}><ChevronUpIcon size={16} /></button>
      <button type="button" className="iconBtn ghost" title="下移" aria-label={`下移第 ${index + 1} 首`} onClick={() => void move(index, 1)} disabled={busy || index === playlist.items.length - 1}><ChevronDownIcon size={16} /></button>
      <button type="button" className="iconBtn ghost" title="从歌单移除（保留收藏）" aria-label={`从歌单移除第 ${index + 1} 首`} onClick={() => void remove(playlist.items[index].id)} disabled={busy}><TrashIcon size={15} /></button>
    </div>} /></div>
  </div>;
}
