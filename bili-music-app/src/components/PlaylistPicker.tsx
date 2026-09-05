"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CandidateItem, Playlist } from "@/lib/models";
import { PLAYLIST_PICKER_EVENT, playlistRequest, playlistsChanged } from "@/lib/playlistClient";
import { CheckIcon, CloseIcon, ListMusicIcon } from "./Icons";

export function PlaylistPicker() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [candidate, setCandidate] = useState<CandidateItem | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const open = (event: Event) => setCandidate((event as CustomEvent<CandidateItem>).detail);
    window.addEventListener(PLAYLIST_PICKER_EVENT, open);
    return () => window.removeEventListener(PLAYLIST_PICKER_EVENT, open);
  }, []);
  useEffect(() => {
    if (!candidate) { dialog.current?.close(); return; }
    dialog.current?.showModal();
    setAdded(new Set()); setName(""); setError(""); setMessage(""); setLoading(true);
    const controller = new AbortController();
    playlistRequest<{ playlists: Playlist[] }>("/api/playlists", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setPlaylists(data.playlists); })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [candidate, reload]);

  async function addTo(id: number) {
    if (!candidate || busy || loading) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await playlistRequest<{ added: boolean; playlist: Playlist }>(`/api/playlists/${id}/items`, {
        method: "POST", body: JSON.stringify({ candidateId: candidate.id }),
      });
      setAdded((items) => new Set([...items, id]));
      setPlaylists((items) => items.map((item) => item.id === id ? result.playlist : item));
      setMessage(result.added ? `已加入「${result.playlist.name}」` : "这首音乐已经在歌单中了");
      playlistsChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "添加失败"); }
    finally { setBusy(false); }
  }
  async function create() {
    if (!candidate || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await playlistRequest<{ playlist: Playlist }>("/api/playlists", {
        method: "POST", body: JSON.stringify({ name, candidateId: candidate.id }),
      });
      setPlaylists((items) => [result.playlist, ...items]);
      setAdded((items) => new Set([...items, result.playlist.id])); setName("");
      setMessage(`已创建「${result.playlist.name}」并加入这首音乐`); playlistsChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "创建失败"); }
    finally { setBusy(false); }
  }
  function close() { if (!busy) setCandidate(null); }
  return <dialog ref={dialog} className="playlistDialog" aria-labelledby="playlist-picker-title"
    onCancel={(event) => { event.preventDefault(); close(); }} onClose={close}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="playlistDialogContent">
      <div className="playlistDialogHeading"><div><span className="sectionKicker">SAVE A LITTLE MOMENT</span><h2 id="playlist-picker-title">加入歌单</h2></div><button type="button" className="iconBtn ghost" aria-label="关闭歌单选择" onClick={close} disabled={busy}><CloseIcon size={18} /></button></div>
      <p className="pickerTrackTitle">{candidate?.title}</p>
      {loading ? <p role="status" className="note">正在读取歌单…</p> : <div className="playlistPickerList">
        {!playlists.length && !error && <div className="pickerEmpty"><ListMusicIcon size={28} /><p>还没有歌单，先创建一个吧。</p></div>}
        {playlists.map((playlist) => <button type="button" key={playlist.id} className="playlistPickRow" disabled={busy || added.has(playlist.id)} onClick={() => void addTo(playlist.id)}>
          <span className="playlistSmallCover"><ListMusicIcon size={20} /></span><span><strong>{playlist.name}</strong><small>{playlist.trackCount} 首音乐</small></span>
          {added.has(playlist.id) ? <CheckIcon size={18} /> : <span className="pickerPlus">＋</span>}
        </button>)}
      </div>}
      {error && <div className="playlistFeedback errorText" role="alert">{error}{!playlists.length && !loading && <button type="button" className="textLink" onClick={() => setReload((value) => value + 1)}>重新加载</button>}</div>}
      {message && <p className="playlistFeedback" role="status">{message}</p>}
      <form className="playlistQuickCreate" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label htmlFor="quick-playlist-name">新建歌单并添加</label>
        <div><input id="quick-playlist-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="给歌单取个名字" maxLength={80} required disabled={busy} /><button type="submit" disabled={busy || loading || !name.trim()}>创建并添加</button></div>
      </form>
      <div className="playlistDialogFooter"><Link href="/playlists" onClick={(event) => { if (busy) event.preventDefault(); else close(); }}>管理我的歌单 ↗</Link><button type="button" className="secondary" onClick={close} disabled={busy}>完成</button></div>
    </div>
  </dialog>;
}
