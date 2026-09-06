"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LIBRARY_CHANGE_EVENT, notifyLibraryChange, type LibraryChange } from "@/lib/libraryEvents";
import { ACCOUNT_CHANGE_EVENT } from "@/lib/accountEvents";
import { ACCOUNT_STATUS_EVENT, accountFetch, ensureClientAccount, knownClientAccount, type ClientAccount } from "@/lib/accountClient";
import { attachPlaybackBoundary, rangeMediaUrl } from "@/lib/playbackBoundary";
import { effectivePlaybackRange, formatPlaybackTime, playbackResumeTime, type PlaybackRange } from "@/lib/playbackRange";
import { PlaybackRangeEditor } from "./PlaybackRangeEditor";
import { useRouter } from "next/navigation";
import type { CandidateItem } from "@/lib/models";
import type { TrackApiResource } from "@/lib/trackApi";
import { buildPlaylistQueue, normalizePlayerState, waitForPreparedTrack, type QueueItem, type StoredPlayerState } from "@/lib/clientPlayback";
import {
  canMoveManually,
  nextIndexOnEnded,
  nextIndexOnManual,
  nextPlaybackMode,
  playbackModeLabel,
  type PlaybackMode,
} from "@/lib/playback";
import {
  PlayIcon,
  PauseIcon,
  SkipBackIcon,
  SkipForwardIcon,
  VolumeIcon,
  VolumeMuteIcon,
  RepeatIcon,
  Repeat1Icon,
  ShuffleIcon,
  HeartIcon,
  DownloadIcon,
  ListMusicIcon,
  MusicIcon,
  RefreshIcon,
  ChevronDownIcon,
  SettingsIcon,
  TrashIcon,
  UsersIcon,
} from "./Icons";

type PlayEvent = CustomEvent<{ candidate: CandidateItem; mode?: "play" | "download" }>;

type StrategyChoice = "auto" | "api_dash" | "browser_network" | "mse_sourcebuffer";

const PLAYER_STATE_KEY = "bili-music-app:player-state:v1";
const RESTART_PREVIOUS_THRESHOLD_SECONDS = 3;
const PLAYBACK_AUTO_STRATEGY_ORDER: Array<"api_dash" | "browser_network" | "mse_sourcebuffer"> = [
  "api_dash",
  "browser_network",
];

export function PlayerDock() {
  const router = useRouter();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playRequestRef = useRef<AbortController | null>(null);
  const downloadRequestsRef = useRef<Map<number, AbortController>>(new Map());
  const autoPlayRef = useRef(false);
  const queueRef = useRef<QueueItem[]>([]);
  const currentIndexRef = useRef(-1);
  const playIntentRef = useRef(0);
  const [hasRestored, setHasRestored] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [history, setHistory] = useState<QueueItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [track, setTrack] = useState<TrackApiResource | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.82);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("sequence");
  const [strategy, setStrategy] = useState<StrategyChoice>("api_dash");
  const [isExpanded, setIsExpanded] = useState(true);
  const [showQueue, setShowQueue] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showRange, setShowRange] = useState(false);
  const [playbackRange, setPlaybackRange] = useState<PlaybackRange | null>(null);
  const [accountId, setAccountId] = useState("");
  const restoredOwner = useRef("");
  const [followed, setFollowed] = useState(false);
  const [following, setFollowing] = useState(false);
  const [creatorMid, setCreatorMid] = useState<string | null>(null);
  const [favorite, setFavorite] = useState<{ accountId: string; bvid: string; value: boolean } | null>(null);
  const [favoriting, setFavoriting] = useState(false);

  const currentItem = currentIndex >= 0 ? queue[currentIndex] : null;
  const isFavorited = favorite?.accountId === accountId && favorite.bvid === currentItem?.bvid && favorite.value;
  queueRef.current = queue;
  currentIndexRef.current = currentIndex;
  const streamSrc = track?.status === "ready" ? rangeMediaUrl(track.media.streamUrl || `/api/tracks/${track.id}/stream`, playbackRange ?? undefined) : undefined;
  const isCompact = !isExpanded;

  useEffect(() => {
    function dismissPanels(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowQueue(false);
        setShowSettings(false);
        setShowRange(false);
      }
    }
    window.addEventListener("keydown", dismissPanels);
    return () => window.removeEventListener("keydown", dismissPanels);
  }, []);

  useEffect(() => {
    let disposed=false;
    const restore=(account:ClientAccount)=>{
      if(disposed||restoredOwner.current===account.appOwnerId)return;
      playRequestRef.current?.abort();audioRef.current?.pause();autoPlayRef.current=false;
      for(const controller of downloadRequestsRef.current.values())controller.abort();
      downloadRequestsRef.current.clear();
      const stored=readStoredPlayerState(account.appOwnerId);
      const items=stored?.queue??[];
      queueRef.current=items;currentIndexRef.current=stored?normalizeIndex(stored.currentIndex,items.length):-1;
      setQueue(items);setHistory(stored?.history??[]);setCurrentIndex(currentIndexRef.current);
      setPlaybackMode(stored?.playbackMode??"sequence");setVolume(stored?.volume??0.82);
      setTrack(null);setPlaybackRange(null);setDuration(0);setCurrentTime(0);setBusy(false);setShowRange(false);
      setFollowed(false);setCreatorMid(null);setFavorite(null);setMessage("");
      restoredOwner.current=account.appOwnerId;setAccountId(account.appOwnerId);setHasRestored(true);
    };
    const changed=(event:Event)=>restore((event as CustomEvent<ClientAccount>).detail);
    window.addEventListener(ACCOUNT_STATUS_EVENT,changed);
    void ensureClientAccount().then(restore).catch(()=>setMessage("暂时无法读取账号，稍后重试"));
    return () => {
      disposed=true;window.removeEventListener(ACCOUNT_STATUS_EVENT,changed);
      playRequestRef.current?.abort();
      for (const controller of downloadRequestsRef.current.values()) controller.abort();
      downloadRequestsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (hasRestored && accountId) writeStoredPlayerState({ queue, history, currentIndex, playbackMode, volume }, accountId);
  }, [queue, history, currentIndex, playbackMode, volume, hasRestored, accountId]);

  useEffect(()=>{
    const changed=()=>{playIntentRef.current++;playRequestRef.current?.abort();autoPlayRef.current=false;audioRef.current?.pause();setTrack(null);setPlaybackRange(null);setShowRange(false);setBusy(false);};
    window.addEventListener(ACCOUNT_CHANGE_EVENT,changed);
    return()=>window.removeEventListener(ACCOUNT_CHANGE_EVENT,changed);
  },[]);

  useEffect(()=>{
    if(!currentItem||!accountId)return;
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    let reading=false;
    let favoriteRevision=0;
    setCreatorMid(currentItem.creatorMid??null);setFollowed(false);
    const refresh=async()=>{
      if(reading||controller.signal.aborted||document.visibilityState==="hidden")return;
      reading=true;
      const requestedFavoriteRevision=favoriteRevision;
      try {
        const [range,details]=await Promise.all([
          getJson<{playbackRange:PlaybackRange}>("/api/playback-ranges/"+currentItem.bvid,controller.signal),
          getJson<{candidate:CandidateItem}>("/api/candidates/"+currentItem.candidateId,controller.signal),
        ]);
        controller.signal.throwIfAborted();
        if(accountId!==knownClientAccount()?.appOwnerId||range.playbackRange.accountId!==accountId)return;
        setPlaybackRange(previous=>previous?.revision===range.playbackRange.revision&&previous.accountId===range.playbackRange.accountId&&previous.bvid===range.playbackRange.bvid?previous:range.playbackRange);
        setCreatorMid(details.candidate.creatorMid);setFollowed(details.candidate.isPreferredCreator);
        // An older metadata response must not undo a newer favorite action.
        if(requestedFavoriteRevision===favoriteRevision)setFavorite({accountId,bvid:currentItem.bvid,value:details.candidate.isFavorited});
      } catch { /* Keep known settings on transient failures; prepare revalidates before playback. */ }
      finally{reading=false;}
    };
    const tick=async()=>{await refresh();if(!controller.signal.aborted)timer=setTimeout(()=>void tick(),5000);};
    const library=(event:Event)=>{
      if(accountId!==knownClientAccount()?.appOwnerId)return;
      const change=(event as CustomEvent<LibraryChange>).detail;
      if(change.kind==="creator"&&change.biliMid===(currentItem.creatorMid||creatorMid))setFollowed(change.followed);
      if(change.kind==="favorite"&&change.bvid===currentItem.bvid){
        favoriteRevision++;
        setFavorite({accountId,bvid:currentItem.bvid,value:change.favorited});
      }
    };
    void tick();
    window.addEventListener("focus",refresh);document.addEventListener("visibilitychange",refresh);window.addEventListener(LIBRARY_CHANGE_EVENT,library);
    return()=>{controller.abort();clearTimeout(timer);window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",refresh);window.removeEventListener(LIBRARY_CHANGE_EVENT,library);};
  },[currentItem?.bvid,currentItem?.candidateId,accountId]);

  useEffect(()=>{
    if(!audioRef.current||!playbackRange||track?.status!=="ready")return;
    return attachPlaybackBoundary(audioRef.current,playbackRange,(invalid)=>{
      autoPlayRef.current=false;setIsPlaying(false);setCurrentTime(audioRef.current?.currentTime??0);
      setMessage(invalid?"设置的起点超出了音频时长，请调整播放区间":"已到设置的终点");
    });
  },[playbackRange,track?.id,track?.status,streamSrc]);

  useEffect(() => {
    let disposed=false;
    const handlePlay = async (event: Event) => {
      const candidate = (event as PlayEvent).detail?.candidate;
      if (!candidate) return;
      const item = toQueueItem(candidate);
      const mode = (event as PlayEvent).detail?.mode || "play";
      const intent=mode==="play"?++playIntentRef.current:null;
      try{await ensureClientAccount();}catch{setMessage("暂时无法确认账号，请稍后重新点击播放");return;}
      if(disposed||(intent!==null&&intent!==playIntentRef.current))return;
      setIsExpanded(true);
      if (mode === "download") {
        void prepareDownload(item);
        return;
      }
      const previous = queueRef.current[currentIndexRef.current];
      if (previous && previous.candidateId !== item.candidateId) {
        setHistory((items) => [previous, ...items.filter((entry) => entry.candidateId !== previous.candidateId)].slice(0, 20));
      }
      const existingIndex = queueRef.current.findIndex((entry) => entry.candidateId === item.candidateId);
      const updatedQueue = existingIndex >= 0 ? queueRef.current : [...queueRef.current, item];
      const index = existingIndex >= 0 ? existingIndex : updatedQueue.length - 1;
      queueRef.current = updatedQueue;
      currentIndexRef.current = index;
      setQueue(updatedQueue);
      setCurrentIndex(index);
      void prepareAndPlay(item, { autoPlay: true });
    };
    const handlePlaylist = async (event: Event) => {
      const detail = (event as CustomEvent<{ candidates: CandidateItem[]; append?: boolean; shuffle?: boolean }>).detail;
      if (!Array.isArray(detail?.candidates)) return;
      const intent=detail.append?null:++playIntentRef.current;
      try{await ensureClientAccount();}catch{setMessage("暂时无法确认账号，请稍后重试");return;}
      if(disposed||(intent!==null&&intent!==playIntentRef.current))return;
      const items = buildPlaylistQueue(detail.candidates);
      if (!items.length) { setMessage("歌单中还没有可播放的音乐"); return; }
      setIsExpanded(true);
      if (detail.append) {
        const existing = new Set(queueRef.current.map((item) => item.bvid));
        const merged = [...queueRef.current, ...items.filter((item) => !existing.has(item.bvid))].slice(0, 200);
        const count = merged.length - queueRef.current.length;
        queueRef.current = merged; setQueue(merged);
        if (currentIndexRef.current < 0) { currentIndexRef.current = 0; setCurrentIndex(0); }
        setMessage(count ? `已将 ${count} 首音乐加入播放队列（最多 200 首）` : "曲目已在队列中，或队列已满");
        setShowQueue(true); setShowSettings(false);
        return;
      }
      const previous = queueRef.current[currentIndexRef.current];
      if (previous) setHistory((history) => [previous, ...history.filter((item) => item.bvid !== previous.bvid)].slice(0, 20));
      const index = detail.shuffle ? Math.floor(Math.random() * items.length) : 0;
      queueRef.current = items; currentIndexRef.current = index;
      setQueue(items); setCurrentIndex(index); setPlaybackMode(detail.shuffle ? "shuffle" : "sequence");
      // Only prepare the selected track. The rest remain metadata until actually played.
      void prepareAndPlay(items[index], { autoPlay: true });
    };
    window.addEventListener("bili-music:play-candidate", handlePlay);
    window.addEventListener("bili-music:play-playlist", handlePlaylist);
    return () => {
      window.removeEventListener("bili-music:play-candidate", handlePlay);
      window.removeEventListener("bili-music:play-playlist", handlePlaylist);
      disposed=true;
    };
  }, [strategy]);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = isMuted ? 0 : volume;
  }, [volume, isMuted]);

  useEffect(() => {
    if (!currentItem) return;
    document.title = isPlaying ? `▶ ${currentItem.title} · Bili 音乐` : `B-Music · 让好音乐发生`;
  }, [currentItem, isPlaying]);

  const progress = useMemo(() => {
    const total = duration || track?.durationSeconds || 0;
    if (!total) return 0;
    return Math.min(100, (currentTime / total) * 100);
  }, [currentTime, duration, track]);

  function prepareRequest(item: QueueItem, signal: AbortSignal): Promise<TrackApiResource> {
    return postJson<{ track: TrackApiResource }>("/api/tracks/prepare", {
      candidateId: item.candidateId,
      bvid: item.bvid,
      ...(strategy === "auto" ? { strategyMode: "auto", strategyOrder: PLAYBACK_AUTO_STRATEGY_ORDER } : { strategyMode: "force", strategy }),
    }, signal).then((payload) => payload.track);
  }

  async function prepareAndPlay(item: QueueItem, opts: { autoPlay: boolean }) {
    playRequestRef.current?.abort();
    const controller = new AbortController();
    playRequestRef.current = controller;
    audioRef.current?.pause();
    autoPlayRef.current = opts.autoPlay;
    setTrack(null);
    setPlaybackRange(null);setShowRange(false);
    setCurrentTime(0);
    setDuration(0);
    setBusy(true);
    setMessage(`正在准备「${item.title}」…`);
    try {
      await waitForPreparedTrack({
        signal: controller.signal,
        prepare: (signal) => prepareRequest(item, signal),
        read: (id, signal) => getJson<{ track: TrackApiResource }>(`/api/tracks/${id}`, signal).then((payload) => payload.track),
        onUpdate: (updated) => { setPlaybackRange(updated.playbackRange);setTrack(updated); setMessage(messageForTrack(updated)); },
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        autoPlayRef.current = false;
        setMessage(error instanceof Error && error.name === "TimeoutError" ? "准备超时，请稍后重试" : `准备失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (playRequestRef.current === controller) setBusy(false);
    }
  }

  async function prepareDownload(item: QueueItem) {
    if (downloadRequestsRef.current.has(item.candidateId)) {
      setMessage("这首音乐已经在准备下载，请稍候");
      return;
    }
    // The kernel serializes work per profile. Avoid flooding it with overlapping downloads.
    if (downloadRequestsRef.current.size >= 1) {
      setMessage("请等当前下载准备完成，再添加下一首");
      return;
    }
    const controller = new AbortController();
    downloadRequestsRef.current.set(item.candidateId, controller);
    setMessage(`正在准备下载「${item.title}」…`);
    try {
      const ready = await waitForPreparedTrack({
        signal: controller.signal,
        prepare: (signal) => prepareRequest(item, signal),
        read: (id, signal) => getJson<{ track: TrackApiResource }>(`/api/tracks/${id}`, signal).then((payload) => payload.track),
        onUpdate: (updated) => setMessage(messageForTrack(updated)),
      });
      controller.signal.throwIfAborted();
      if (!ready.media.downloadUrl) throw new Error("内核没有返回可下载的音频");
      startBrowserDownload(ready);
      setMessage(`「${item.title}」已交给浏览器下载，请在下载列表中查看`);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(`下载准备失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (downloadRequestsRef.current.get(item.candidateId) === controller) downloadRequestsRef.current.delete(item.candidateId);
    }
  }

  async function togglePlay() {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      if (track?.status === "ready") {
        const fresh=await getJson<{playbackRange:PlaybackRange}>("/api/playback-ranges/"+track.bvid).catch(()=>null);
        if(!fresh){setMessage("无法确认最新播放区间，请稍后重试");return;}
        const bounds=effectivePlaybackRange(fresh.playbackRange,audioRef.current.duration);
        if(!bounds.valid){setMessage("设置的起点超出了音频时长，请调整播放区间");return;}
        if(fresh.playbackRange.revision!==playbackRange?.revision){autoPlayRef.current=true;setPlaybackRange(fresh.playbackRange);return;}
        audioRef.current.currentTime=playbackResumeTime(fresh.playbackRange,audioRef.current.duration,audioRef.current.currentTime);
        await audioRef.current.play().catch(() => setMessage("浏览器未开始播放，请再点一次播放"));
      } else if (currentItem) {
        await prepareAndPlay(currentItem, { autoPlay: true });
      }
    }
  }

  function seek(percent: number) {
    const total = duration || track?.durationSeconds || 0;
    if (!total || !audioRef.current) return;
    const bounds=effectivePlaybackRange(playbackRange??undefined,total);
    const target = Math.max(bounds.start,Math.min(bounds.end??total,(percent / 100) * total));
    audioRef.current.currentTime = target;
    setCurrentTime(target);
  }

  function playRelative(direction: "previous" | "next") {
    if (!queue.length) return;
    if (direction === "previous" && currentTime - (playbackRange?.startSeconds??0) > RESTART_PREVIOUS_THRESHOLD_SECONDS) {
      if (audioRef.current) audioRef.current.currentTime = playbackRange?.startSeconds??0;
      return;
    }
    const nextIdx = nextIndexOnManual(currentIndex, queue.length, playbackMode, direction);
    if (nextIdx !== null && nextIdx >= 0 && nextIdx < queue.length) {
      playAt(nextIdx);
    }
  }

  function playAt(index: number) {
    if (index < 0 || index >= queue.length) return;
    if (currentItem) {
      setHistory((prev) => [currentItem, ...prev.filter((h) => h.candidateId !== currentItem.candidateId)].slice(0, 20));
    }
    currentIndexRef.current=index;setCurrentIndex(index);
    void prepareAndPlay(queue[index], { autoPlay: true });
  }

  function handleEnded() {
    if(playbackRange?.endSeconds!==null&&playbackRange?.endSeconds!==undefined){audioRef.current?.pause();setIsPlaying(false);setMessage("已到设置的终点");return;}
    const nextIdx = nextIndexOnEnded(currentIndex, queue.length, playbackMode);
    if (nextIdx !== null && nextIdx >= 0) {
      playAt(nextIdx);
    } else {
      setIsPlaying(false);
    }
  }

  function removeQueueItem(index: number) {
    const next = queue.filter((_, i) => i !== index);
    if (!next.length) { clearQueue(); return; }
    setQueue(next);
    if (index < currentIndex) {
      setCurrentIndex(currentIndex - 1);
    } else if (index === currentIndex) {
      const newIndex = Math.min(currentIndex, next.length - 1);
      setCurrentIndex(newIndex);
      void prepareAndPlay(next[newIndex], { autoPlay: true });
    }
  }

  function clearQueue() {
    playIntentRef.current++;
    playRequestRef.current?.abort();
    autoPlayRef.current = false;
    setBusy(false);
    audioRef.current?.pause();
    setQueue([]);
    queueRef.current=[];currentIndexRef.current=-1;
    setCurrentIndex(-1);
    setTrack(null);
    setPlaybackRange(null);setShowRange(false);
    setCurrentTime(0);
    setDuration(0);
    setMessage("");
  }

  async function favoriteCurrentItem() {
    if (!currentItem || favoriting) return;
    const selectedAccount = knownClientAccount()?.appOwnerId;
    const isStillCurrent = () => selectedAccount === knownClientAccount()?.appOwnerId && queueRef.current[currentIndexRef.current]?.bvid === currentItem.bvid;
    setFavoriting(true);
    try {
      await postJson(`/api/favorites`, { candidateId: currentItem.candidateId });
      if (selectedAccount !== knownClientAccount()?.appOwnerId) return;
      notifyLibraryChange({ kind: "favorite", candidateId: currentItem.candidateId, bvid: currentItem.bvid, favorited: true });
      router.refresh();
      if (isStillCurrent()) setMessage(`已将「${currentItem.title}」添加到收藏夹`);
    } catch {
      if (isStillCurrent()) setMessage("收藏失败，请稍后重试");
    } finally {
      setFavoriting(false);
    }
  }

  async function followCurrentCreator() {
    if(!currentItem||!creatorMid||following||followed)return;
    const selectedBvid=currentItem.bvid;
    const selectedAccount=knownClientAccount()?.appOwnerId;
    setFollowing(true);
    try {
      await postJson("/api/creators",{biliMid:creatorMid,name:currentItem.creatorName||undefined});
      notifyLibraryChange({kind:"creator",biliMid:creatorMid,followed:true});router.refresh();
      if(selectedAccount===knownClientAccount()?.appOwnerId&&queueRef.current[currentIndexRef.current]?.bvid===selectedBvid){setFollowed(true);setMessage("已关注当前 UP，搜索时优先展示其作品");}
    } catch(error){setMessage(error instanceof Error?error.message:"关注失败，请重试");}
    finally{setFollowing(false);}
  }
  function rangeSaved(next:PlaybackRange){
    if(next.accountId!==knownClientAccount()?.appOwnerId||next.bvid!==currentItem?.bvid)return;
    autoPlayRef.current=false;audioRef.current?.pause();setPlaybackRange(next);
    setMessage(next.configured?"播放区间已保存，网页和手机共用此设置":"已恢复整首播放");
  }

  const renderPlaybackModeIcon = () => {
    switch (playbackMode as string) {
      case "single_loop":
        return <Repeat1Icon size={16} />;
      case "shuffle":
        return <ShuffleIcon size={16} />;
      case "loop":
      case "sequence":
      default:
        return <RepeatIcon size={16} />;
    }
  };

  return (
    <aside className={`playerDock ${isCompact ? "playerDockCompact" : ""}`} aria-label="音乐播放器">
      {message && <div className="playerNotice" role="status"><span>{message}</span><button type="button" className="ghost" onClick={() => setMessage("")} aria-label="关闭播放提示">×</button></div>}
      <audio
        ref={audioRef}
        src={streamSrc}
        preload="metadata"
        onEnded={handleEnded}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const seconds = e.currentTarget.duration;
          setDuration(Number.isFinite(seconds) ? seconds : track?.durationSeconds || 0);
          const bounds=effectivePlaybackRange(playbackRange??undefined,seconds);
          if(!bounds.valid){autoPlayRef.current=false;e.currentTarget.pause();setMessage("设置的起点超出了音频时长，请调整播放区间");return;}
          e.currentTarget.currentTime=bounds.start;
          setCurrentTime(bounds.start);
          if (autoPlayRef.current && track?.status === "ready") {
            autoPlayRef.current = false;
            e.currentTarget.play().catch(() => setMessage("音频已就绪，点击播放开始聆听"));
          }
        }}
        onError={() => setMessage("音频流播放失败，可能链接已失效")}
      />

      {isCompact ? (
        <div className="compactPlayer">
          <div className="compactNowPlaying">
            <div className={`playerDisc ${isPlaying ? "playerDiscSpin" : ""}`} style={{ width: 34, height: 34 }}>
              <MusicIcon size={18} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className={`badge ${track?.status === "ready" ? "success" : "primary"}`} style={{ fontSize: "0.68rem" }}>
                  {trackStatusLabel(track)}
                </span>
                <strong style={{ fontSize: "0.88rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {currentItem?.title || "音乐待机中"}
                </strong>
              </div>
              <small style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                {currentItem?.creatorName || "点击右侧展开播放器"}
              </small>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }} onClick={(e) => e.stopPropagation()}>
            {currentItem&&<button type="button" className="playerFollowButton" onClick={()=>void followCurrentCreator()} disabled={!creatorMid||following||followed} aria-label={followed?"已关注当前 UP":"关注当前 UP"}>{followed?"已关注":"关注 UP"}</button>}
            <button
              type="button"
              className="playerPlayBtn"
              style={{ width: 36, height: 36 }}
              onClick={() => void togglePlay()}
              disabled={busy || (!currentItem && !track)}
              aria-label={isPlaying ? "暂停" : "播放"}
            >
              {isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
            </button>
            <button type="button" className="secondary" style={{ padding: "6px 12px", fontSize: "0.78rem" }} onClick={() => setIsExpanded(true)}>
              展开
            </button>
          </div>
        </div>
      ) : (
        <div className="playerInner">
          {/* 左侧：当前播放歌曲信息 (Now Playing) */}
          <div className="playerTrackSection">
            <div className="playerCoverWrap">
              {currentItem?.coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={getProxiedImageUrl(currentItem.coverUrl)}
                  alt={currentItem.title}
                  className={`playerCover ${isPlaying ? "playerDiscSpin" : ""}`}
                />
              ) : (
                <div className={`playerCover ${isPlaying ? "playerDiscSpin" : ""}`} style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-glass-heavy)", border: "1px solid var(--border-subtle)" }}>
                  <MusicIcon size={22} style={{ color: "var(--accent-primary)" }} />
                </div>
              )}
            </div>

            <div className="playerTrackDetails">
              <div className="playerTrackTitle" title={currentItem?.title}>
                {currentItem?.title || "让好音乐发生"}
              </div>
              <div className="playerTrackArtist">
                <span>{currentItem?.creatorName || "选一首喜欢的，开始聆听"}</span>
                {track && (
                  <span className={`badge ${track.status === "ready" ? "success" : "primary"}`} style={{ fontSize: "0.65rem", padding: "1px 6px" }}>
                    {trackStatusLabel(track)}
                  </span>
                )}
              </div>
              {currentItem&&<div className="playerTrackActions">
                <button type="button" className={"playerFollowButton "+(followed?"isFollowed":"")} onClick={()=>void followCurrentCreator()} disabled={!creatorMid||following||followed} aria-label={followed?"已关注当前 UP":following?"正在关注 UP":"关注当前 UP"}><UsersIcon size={13}/>{followed?"已关注":following?"关注中":"关注 UP"}</button>
                <button type="button" className="playerRangeButton" disabled={!playbackRange||busy} onClick={()=>{setShowRange(!showRange);setShowQueue(false);setShowSettings(false);}} aria-expanded={showRange} aria-label="设置播放区间">{playbackRange?.configured?`${formatPlaybackTime(playbackRange.startSeconds)}–${playbackRange.endSeconds===null?"结尾":formatPlaybackTime(playbackRange.endSeconds)}`:"播放区间"}</button>
              </div>}
            </div>

            {currentItem && (
              <button
                type="button"
                className={`iconBtn playerFavoriteButton ${isFavorited ? "isFavorited" : "ghost"}`}
                style={{ marginLeft: 2 }}
                onClick={() => void favoriteCurrentItem()}
                disabled={favoriting}
                aria-label={isFavorited ? "已收藏当前歌曲" : "收藏当前歌曲"}
                aria-pressed={isFavorited}
                aria-busy={favoriting}
                title={isFavorited ? "已收藏当前歌曲" : "收藏当前歌曲"}
              >
                <HeartIcon size={16} filled={isFavorited} />
              </button>
            )}
          </div>

          {/* Playback controls remain available across routes. */}
          <div className="playerControlSection">
            <div className="playerButtonsRow">
              <button
                type="button"
                className="playerNavBtn"
                onClick={() => setPlaybackMode(nextPlaybackMode(playbackMode))}
                title={`模式: ${playbackModeLabel(playbackMode)}`}
              >
                {renderPlaybackModeIcon()}
              </button>

              <button
                type="button"
                className="playerNavBtn"
                onClick={() => playRelative("previous")}
                disabled={queue.length < 1}
                title="上一首"
              >
                <SkipBackIcon size={18} />
              </button>

              <button
                type="button"
                className="playPauseBtn"
                onClick={() => void togglePlay()}
                disabled={busy || (!currentItem && !track)}
                title={isPlaying ? "暂停" : "播放"}
              >
                {busy ? <RefreshIcon size={20} className="playerDiscSpin" /> : isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
              </button>

              <button
                type="button"
                className="playerNavBtn"
                onClick={() => playRelative("next")}
                disabled={!canMoveManually(currentIndex, queue.length, playbackMode, "next")}
                title="下一首"
              >
                <SkipForwardIcon size={18} />
              </button>

              {track?.status === "ready" && track.media.downloadUrl ? (
                <a
                  className="playerNavBtn"
                  href={track.media.downloadUrl}
                  download={track.media.fileName || undefined}
                  title={`下载离线音频 (${formatBytes(track.media.sizeBytes || 0)})`}
                >
                  <DownloadIcon size={16} />
                </a>
              ) : (
                <button type="button" className="playerNavBtn" disabled title="音频未就绪">
                  <DownloadIcon size={16} style={{ opacity: 0.3 }} />
                </button>
              )}
            </div>

            <div className="playerProgressRow">
              <span className="playerTime current">{formatTime(currentTime)}</span>
              <div className="progressBarContainer">
                <input
                  type="range"
                  className="slider"
                  min={0}
                  max={100}
                  value={progress}
                  onChange={(e) => seek(Number(e.target.value))}
                  disabled={track?.status !== "ready"}
                  aria-label="播放进度"
                  style={{ background: `linear-gradient(to right, var(--accent) ${progress}%, #dce4d4 ${progress}%)` }}
                />
              </div>
              <span className="playerTime">{formatTime(duration || track?.durationSeconds || 0)}</span>
            </div>
          </div>

          {/* 右侧：音量、队列抽屉、策略与收起按钮 */}
          <div className="playerExtraSection">
            <div className="volumeControl">
              <button
                type="button"
                className="iconBtn ghost"
                onClick={() => setIsMuted(!isMuted)}
                title={isMuted ? "取消静音" : "静音"}
              >
                {isMuted || volume === 0 ? <VolumeMuteIcon size={16} /> : <VolumeIcon size={16} />}
              </button>
              <input
                type="range"
                className="slider volumeSlider"
                min={0}
                max={1}
                step={0.01}
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  setVolume(Number(e.target.value));
                  if (isMuted) setIsMuted(false);
                }}
                aria-label="音量调节"
              />
            </div>

            <button
              type="button"
              className={`iconBtn ${showQueue ? "primary" : "ghost"}`}
              onClick={() => {
                setShowQueue(!showQueue);
                setShowRange(false);
                if (showSettings) setShowSettings(false);
              }}
              title="播放列表"
              aria-label="播放列表"
              aria-expanded={showQueue}
            >
              <ListMusicIcon size={18} />
              {queue.length > 0 && <span className="dockQueueBadge">{queue.length}</span>}
            </button>

            <button
              type="button"
              className={`iconBtn ${showSettings ? "primary" : "ghost"}`}
              onClick={() => {
                setShowSettings(!showSettings);
                setShowRange(false);
                if (showQueue) setShowQueue(false);
              }}
              title="内核设置"
            >
              <SettingsIcon size={16} />
            </button>

            <button
              type="button"
              className="iconBtn ghost"
              onClick={() => setIsExpanded(false)}
              title="收起播放条"
            >
              <ChevronDownIcon size={18} />
            </button>
          </div>

          {/* 浮动面板：播放队列 */}
          {showRange&&playbackRange&&<PlaybackRangeEditor range={playbackRange} duration={duration||track?.durationSeconds||0} currentTime={currentTime} onSaved={rangeSaved} onClose={()=>setShowRange(false)}/>}
          {showQueue && (
            <div className="dockFlyoutPanel">
              <div className="flyoutHeader">
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <ListMusicIcon size={16} />
                  <strong>播放队列 ({queue.length})</strong>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" className="iconBtn ghost" aria-label="播放设置" onClick={() => { setShowQueue(false); setShowSettings(true); }}><SettingsIcon size={15} /></button>
                  <button
                    type="button"
                    className="ghost"
                    style={{ fontSize: "0.75rem", padding: "2px 8px" }}
                    onClick={clearQueue}
                    disabled={!queue.length}
                  >
                    <TrashIcon size={12} style={{ display: "inline", marginRight: 3 }} />
                    清空
                  </button>
                  <button type="button" className="iconBtn ghost" aria-label="关闭播放队列" onClick={() => setShowQueue(false)}>×</button>
                </div>
              </div>

              <div className="flyoutList">
                {queue.length === 0 ? (
                  <div style={{ padding: "24px 12px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    队列还是空的，去搜索或关注列表添加歌曲吧
                  </div>
                ) : (
                  queue.map((item, idx) => (
                    <div
                      key={`${item.candidateId}-${idx}`}
                      className={`flyoutItem ${idx === currentIndex ? "active" : ""}`}
                    >
                      <button type="button" className="flyoutSelect" onClick={() => playAt(idx)} aria-label={`播放 ${item.title}`}>
                      <span className="flyoutIndex">{idx === currentIndex ? "▶" : idx + 1}</span>
                      <div className="flyoutInfo">
                        <div className="flyoutTitle">{item.title}</div>
                        <div className="flyoutSub">{item.creatorName || item.bvid}</div>
                      </div>
                      </button>
                      <button
                        type="button"
                        className="flyoutRemove"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeQueueItem(idx);
                        }}
                        title="从队列移除"
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>

              {history.length > 0 && (
                <div style={{ borderTop: "1px solid var(--border-subtle)", padding: "10px 14px", background: "var(--bg-surface)" }}>
                  <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", display: "block", marginBottom: 6 }}>
                    最近听过
                  </span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {history.slice(0, 3).map((item) => (
                      <button
                        type="button"
                        key={item.candidateId}
                        className="filterPill"
                        style={{ fontSize: "0.72rem", padding: "2px 8px" }}
                        onClick={() => {
                          const existingIndex = queue.findIndex((entry) => entry.candidateId === item.candidateId);
                          if (existingIndex >= 0) { playAt(existingIndex); return; }
                          setQueue([...queue, item]);
                          setCurrentIndex(queue.length);
                          void prepareAndPlay(item, { autoPlay: true });
                        }}
                      >
                        {item.title.slice(0, 10)}...
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 浮动面板：解析与播放策略 */}
          {showSettings && (
            <div className="dockFlyoutPanel dockSettingsPanel">
              <div className="flyoutHeader">
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <SettingsIcon size={16} />
                  <strong>播放内核策略</strong>
                </div>
                <button type="button" className="iconBtn ghost" aria-label="关闭播放设置" onClick={() => setShowSettings(false)}>×</button>
              </div>
              <div style={{ padding: "14px", fontSize: "0.82rem" }}>
                <label htmlFor="playback-strategy" style={{ display: "block", marginBottom: 6, color: "var(--text-secondary)" }}>
                  音频流解析引擎：
                </label>
                <select
                  id="playback-strategy"
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value as StrategyChoice)}
                  style={{ width: "100%", marginBottom: 12 }}
                >
                  <option value="api_dash">极速 API DASH（默认）</option>
                  <option value="auto">自动故障转移 (api_dash → browser)</option>
                  <option value="browser_network">浏览器内核（使用内核登录态）</option>
                  <option value="mse_sourcebuffer">实验性 MSE SourceBuffer</option>
                </select>
                <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.75rem", lineHeight: 1.5 }}>
                  {message}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

export function playPlaylist(candidates: CandidateItem[], shuffle = false): void {
  window.dispatchEvent(new CustomEvent("bili-music:play-playlist", { detail: { candidates, shuffle } }));
}
export function queuePlaylist(candidates: CandidateItem[]): void {
  window.dispatchEvent(new CustomEvent("bili-music:play-playlist", { detail: { candidates, append: true } }));
}

export function playCandidate(candidate: CandidateItem): void {
  window.dispatchEvent(new CustomEvent("bili-music:play-candidate", { detail: { candidate, mode: "play" } }));
}

export function downloadCandidate(candidate: CandidateItem): void {
  window.dispatchEvent(new CustomEvent("bili-music:play-candidate", { detail: { candidate, mode: "download" } }));
}

function getProxiedImageUrl(url?: string | null): string {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return `/api/image-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

function toQueueItem(candidate: CandidateItem): QueueItem {
  return {
    candidateId: candidate.id,
    bvid: candidate.bvid,
    title: candidate.title,
    creatorName: candidate.creatorName,
    creatorMid: candidate.creatorMid,
    coverUrl: candidate.coverUrl,
  };
}

async function postJson<T>(url: string, body: object, signal?: AbortSignal): Promise<T> {
  const response = await accountFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  return parseJsonResponse<T>(response);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await accountFetch(url, { cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  return parseJsonResponse<T>(response);
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload.error || "请求失败"));
  }
  return payload as T;
}

function messageForTrack(track: TrackApiResource): string {
  if (track.status === "ready") {
    return "音频已就绪";
  }
  if (track.status === "preparing") {
    return track.failureReason || "内核正在下载并合成高音质流，稍候...";
  }
  if (track.status === "expired") {
    return "音频缓存已过期，请重新点击准备";
  }
  if (track.status === "failed") {
    return track.failureReason || "音频准备失败";
  }
  return "音频待命";
}

function startBrowserDownload(track: TrackApiResource): void {
  if (!track.media.downloadUrl) return;
  const anchor = document.createElement("a");
  anchor.href = track.media.downloadUrl;
  anchor.download = track.media.fileName || "";
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function trackStatusLabel(track: TrackApiResource | null): string {
  const labels: Record<string, string> = {
    pending: "待解析",
    preparing: "合成中",
    ready: "已就绪",
    expired: "已过期",
    failed: "解析失败",
  };
  return track ? labels[track.status] || track.status : "未加载";
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remaining = wholeSeconds % 60;
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

function normalizeIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0 || index >= length) return 0;
  return index;
}

function readStoredPlayerState(accountId: string): StoredPlayerState | null {
  try {
    const key=PLAYER_STATE_KEY+":"+accountId;
    let raw=window.localStorage.getItem(key);
    // Adopt the old device queue once, never into every account that signs in.
    const migrated=window.localStorage.getItem(PLAYER_STATE_KEY+":migrated");
    if(!raw&&!accountId.startsWith("guest:")&&(!migrated||(accountId.startsWith("bili:")&&!migrated.startsWith("bili:")&&!migrated.startsWith("guest:")))){
      raw=(migrated?window.localStorage.getItem(PLAYER_STATE_KEY+":"+migrated):null)||window.localStorage.getItem(PLAYER_STATE_KEY);
      if(raw)window.localStorage.setItem(key,raw);
      window.localStorage.setItem(PLAYER_STATE_KEY+":migrated",accountId);
    }
    if (!raw) return null;
    return normalizePlayerState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeStoredPlayerState(state: StoredPlayerState, accountId: string): void {
  try {
    window.localStorage.setItem(PLAYER_STATE_KEY+":"+accountId, JSON.stringify(state));
  } catch {
    // ignore
  }
}
