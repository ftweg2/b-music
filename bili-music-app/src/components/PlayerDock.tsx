"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { CandidateWithScore } from "@/lib/models";
import type { TrackApiResource } from "@/lib/trackApi";
import {
  canMoveManually,
  nextIndexOnEnded,
  nextIndexOnManual,
  nextPlaybackMode,
  playbackModeLabel,
  type PlaybackMode
} from "@/lib/playback";

type QueueItem = {
  candidateId: number;
  bvid: string;
  title: string;
  creatorName: string | null;
};

type PlayEvent = CustomEvent<{ candidate: CandidateWithScore; mode?: "play" | "prewarm" | "download" }>;

type StrategyChoice = "auto" | "api_dash" | "browser_network" | "mse_sourcebuffer";

type StoredPlayerState = {
  queue: QueueItem[];
  history: QueueItem[];
  currentIndex: number;
  playbackMode: PlaybackMode;
  volume: number;
};

const PLAYER_STATE_KEY = "bili-music-app:player-state:v1";
const RESTART_PREVIOUS_THRESHOLD_SECONDS = 3;
const POLL_INTERVAL_MS = 1500;
const PLAYBACK_AUTO_STRATEGY_ORDER: Array<"api_dash" | "browser_network" | "mse_sourcebuffer"> = [
  "api_dash",
  "browser_network"
];

export function PlayerDock() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prewarmedRef = useRef<Set<number>>(new Set());
  const downloadTasksRef = useRef<Map<number, number>>(new Map());
  const downloadTimersRef = useRef<Map<number, number>>(new Map());
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [history, setHistory] = useState<QueueItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [track, setTrack] = useState<TrackApiResource | null>(null);
  const [message, setMessage] = useState("选择一首候选视频开始准备音频");
  const [busy, setBusy] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.82);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("sequence");
  const [strategy, setStrategy] = useState<StrategyChoice>("api_dash");
  const [isExpanded, setIsExpanded] = useState(false);

  const currentItem = currentIndex >= 0 ? queue[currentIndex] : null;
  const nextCandidateIndex = nextIndexOnManual(currentIndex, queue.length, playbackMode, "next");
  const nextItem = nextCandidateIndex === null ? null : queue[nextCandidateIndex];
  const streamSrc = track?.status === "ready" ? track.media.streamUrl || `/api/tracks/${track.id}/stream` : undefined;
  const hasPlayerContent = queue.length > 0 || Boolean(track);
  const isCompact = !hasPlayerContent || !isExpanded;

  useEffect(() => {
    const stored = readStoredPlayerState();
    if (stored) {
      setQueue(stored.queue);
      setHistory(stored.history);
      setCurrentIndex(normalizeIndex(stored.currentIndex, stored.queue.length));
      setPlaybackMode(stored.playbackMode);
      setVolume(stored.volume);
    }
  }, []);

  useEffect(() => {
    writeStoredPlayerState({ queue, history, currentIndex, playbackMode, volume });
  }, [queue, history, currentIndex, playbackMode, volume]);

  useEffect(() => {
    prewarmedRef.current.clear();
  }, [strategy]);

  useEffect(() => {
    const handlePlay = (event: Event) => {
      const candidate = (event as PlayEvent).detail?.candidate;
      if (!candidate) {
        return;
      }
      const item = toQueueItem(candidate);
      const mode = (event as PlayEvent).detail?.mode || "play";
      setIsExpanded(true);
      if (mode === "download") {
        void prepareDownload(item);
        return;
      }
      if (mode === "prewarm") {
        setQueue((current) => {
          if (current.some((entry) => entry.candidateId === item.candidateId)) {
            return current;
          }
          return [...current, item];
        });
        setMessage("已加入队列，正在后台预热音频");
        if (!prewarmedRef.current.has(item.candidateId)) {
          prewarmedRef.current.add(item.candidateId);
          void prepareCandidate(item, true);
        }
        return;
      }
      setQueue((current) => {
        const existingIndex = current.findIndex((entry) => entry.candidateId === item.candidateId);
        if (existingIndex >= 0) {
          setCurrentIndex(existingIndex);
          return current;
        }
        setCurrentIndex(current.length);
        return [...current, item];
      });
      setHistory((current) => [item, ...current.filter((entry) => entry.candidateId !== item.candidateId)].slice(0, 10));
      void prepareCandidate(item, false);
    };
    window.addEventListener("bili-music:play-candidate", handlePlay);
    return () => window.removeEventListener("bili-music:play-candidate", handlePlay);
  }, [strategy]);

  useEffect(() => {
    return () => {
      for (const timer of downloadTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      downloadTimersRef.current.clear();
      downloadTasksRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    if (!track || track.status !== "preparing") {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshTrackStatus(track.id);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [track?.id, track?.status]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || track?.status !== "ready") {
      return;
    }
    audio.play().then(() => {
      setIsPlaying(true);
      setMessage("正在播放");
    }).catch(() => {
      setMessage("音频已准备好，点击播放开始");
    });
  }, [track?.id, track?.status]);

  useEffect(() => {
    if (track?.status !== "ready" || playbackMode === "single_loop" || !nextItem || prewarmedRef.current.has(nextItem.candidateId)) {
      return;
    }
    prewarmedRef.current.add(nextItem.candidateId);
    void prepareCandidate(nextItem, true);
  }, [nextItem?.candidateId, playbackMode, track?.status]);

  const progress = useMemo(() => {
    if (!duration) {
      return 0;
    }
    return Math.min(100, Math.max(0, (currentTime / duration) * 100));
  }, [currentTime, duration]);

  async function prepareCandidate(item: QueueItem, prewarm: boolean) {
    if (!prewarm) {
      setBusy(true);
      setTrack(null);
      setMessage("正在让内核准备音频...");
    }
    try {
      const payload = await postJson<{ track: TrackApiResource }>("/api/tracks/prepare", {
        candidateId: item.candidateId,
        bvid: item.bvid,
        strategyMode: strategy === "auto" ? "auto" : "force",
        strategy: strategy === "auto" ? undefined : strategy,
        strategyOrder: strategy === "auto" ? PLAYBACK_AUTO_STRATEGY_ORDER : undefined
      });
      if (!prewarm) {
        setMessage(messageForTrack(payload.track));
        setTrack(payload.track);
      }
    } catch (error) {
      if (!prewarm) {
        setMessage(String(error instanceof Error ? error.message : error));
      }
    } finally {
      if (!prewarm) {
        setBusy(false);
      }
    }
  }

  async function refreshTrackStatus(trackId: number) {
    try {
      const payload = await getJson<{ track: TrackApiResource }>(`/api/tracks/${trackId}`);
      setTrack(payload.track);
      setMessage(messageForTrack(payload.track));
    } catch (error) {
      setMessage(String(error instanceof Error ? error.message : error));
    }
  }

  async function prepareDownload(item: QueueItem) {
    if (downloadTasksRef.current.has(item.candidateId)) {
      setMessage(`正在准备下载：${item.title}`);
      return;
    }
    downloadTasksRef.current.set(item.candidateId, 0);
    setMessage(`正在后台准备下载：${item.title}`);
    try {
      const payload = await postJson<{ track: TrackApiResource }>("/api/tracks/prepare", {
        candidateId: item.candidateId,
        bvid: item.bvid,
        strategyMode: strategy === "auto" ? "auto" : "force",
        strategy: strategy === "auto" ? undefined : strategy,
        strategyOrder: strategy === "auto" ? PLAYBACK_AUTO_STRATEGY_ORDER : undefined
      });
      handleDownloadTrack(item, payload.track);
    } catch (error) {
      finishDownloadTask(item.candidateId);
      setMessage(`下载准备失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function handleDownloadTrack(item: QueueItem, downloadTrack: TrackApiResource) {
    if (downloadTrack.status === "ready" && downloadTrack.media.downloadUrl) {
      finishDownloadTask(item.candidateId);
      startBrowserDownload(downloadTrack);
      setMessage(`已交给浏览器下载：${downloadTrack.media.fileName || downloadTrack.title}`);
      return;
    }
    if (["failed", "expired"].includes(downloadTrack.status)) {
      finishDownloadTask(item.candidateId);
      setMessage(downloadTrack.failureReason || "下载准备失败，请重新尝试");
      return;
    }
    downloadTasksRef.current.set(item.candidateId, downloadTrack.id);
    const timer = window.setTimeout(() => {
      void pollDownload(item, downloadTrack.id);
    }, POLL_INTERVAL_MS);
    downloadTimersRef.current.set(item.candidateId, timer);
  }

  async function pollDownload(item: QueueItem, trackId: number) {
    downloadTimersRef.current.delete(item.candidateId);
    if (downloadTasksRef.current.get(item.candidateId) !== trackId) return;
    try {
      const payload = await getJson<{ track: TrackApiResource }>(`/api/tracks/${trackId}`);
      handleDownloadTrack(item, payload.track);
    } catch (error) {
      finishDownloadTask(item.candidateId);
      setMessage(`下载状态查询失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function finishDownloadTask(candidateId: number) {
    const timer = downloadTimersRef.current.get(candidateId);
    if (timer !== undefined) window.clearTimeout(timer);
    downloadTimersRef.current.delete(candidateId);
    downloadTasksRef.current.delete(candidateId);
  }

  async function refreshCurrentTrack() {
    if (!track) {
      if (currentItem) {
        await prepareCandidate(currentItem, false);
      }
      return;
    }
    setBusy(true);
    setMessage("正在重新准备音频...");
    try {
      const payload = await postJson<{ track: TrackApiResource }>(`/api/tracks/${track.id}/refresh`, {
        strategyMode: strategy === "auto" ? "auto" : "force",
        strategy: strategy === "auto" ? undefined : strategy,
        strategyOrder: strategy === "auto" ? PLAYBACK_AUTO_STRATEGY_ORDER : undefined
      });
      setTrack(payload.track);
      setMessage(messageForTrack(payload.track));
    } catch (error) {
      setMessage(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  }

  async function togglePlay() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (track?.status !== "ready") {
      if (currentItem) {
        await prepareCandidate(currentItem, false);
      }
      return;
    }
    if (audio.paused) {
      await audio.play();
      setIsPlaying(true);
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }

  function playAt(index: number, options: { restart?: boolean } = {}) {
    const item = queue[index];
    if (!item) {
      return;
    }
    setCurrentIndex(index);
    if (options.restart && audioRef.current) {
      audioRef.current.currentTime = 0;
      setCurrentTime(0);
    }
    setHistory((current) => [item, ...current.filter((entry) => entry.candidateId !== item.candidateId)].slice(0, 10));
    void prepareCandidate(item, false);
  }

  function playRelative(direction: "next" | "previous") {
    const audio = audioRef.current;
    if (direction === "previous" && audio && audio.currentTime > RESTART_PREVIOUS_THRESHOLD_SECONDS) {
      audio.currentTime = 0;
      setCurrentTime(0);
      return;
    }
    const target = nextIndexOnManual(currentIndex, queue.length, playbackMode, direction);
    if (target === null) {
      setMessage(direction === "next" ? "已经到列表末尾" : "已经是第一首");
      return;
    }
    playAt(target, { restart: true });
  }

  function handleEnded() {
    const target = nextIndexOnEnded(currentIndex, queue.length, playbackMode);
    if (target === null) {
      setIsPlaying(false);
      setMessage("列表播放完了");
      return;
    }
    if (target === currentIndex && audioRef.current) {
      audioRef.current.currentTime = 0;
      void audioRef.current.play();
      setMessage("单曲循环中");
      return;
    }
    playAt(target, { restart: true });
  }

  function removeQueueItem(index: number) {
    const item = queue[index];
    if (!item) {
      return;
    }
    const nextQueue = queue.filter((_entry, entryIndex) => entryIndex !== index);
    setQueue(nextQueue);
    prewarmedRef.current.delete(item.candidateId);
    if (!nextQueue.length) {
      stopPlayback("队列已清空");
      return;
    }
    if (index === currentIndex) {
      const nextIndex = Math.min(index, nextQueue.length - 1);
      setCurrentIndex(nextIndex);
      setHistory((current) => current.filter((entry) => entry.candidateId !== item.candidateId));
      void prepareCandidate(nextQueue[nextIndex], false);
      return;
    }
    if (index < currentIndex) {
      setCurrentIndex(currentIndex - 1);
    }
  }

  function clearQueue() {
    setQueue([]);
    setHistory([]);
    prewarmedRef.current.clear();
    stopPlayback("队列已清空");
  }

  function stopPlayback(nextMessage: string) {
    audioRef.current?.pause();
    setIsPlaying(false);
    setCurrentIndex(-1);
    setTrack(null);
    setCurrentTime(0);
    setDuration(0);
    setMessage(nextMessage);
  }

  function seek(value: number) {
    const audio = audioRef.current;
    if (!audio || !duration) {
      return;
    }
    const nextTime = (value / 100) * duration;
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  async function favoriteCurrentItem() {
    if (!currentItem) {
      setMessage("先播放一首歌，再收藏。");
      return;
    }
    setBusy(true);
    try {
      await postJson("/api/favorites", {
        candidateId: currentItem.candidateId,
        bvid: currentItem.bvid
      });
      setMessage(`已收藏：${currentItem.title}`);
    } catch (error) {
      setMessage(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className={isCompact ? "playerDock playerDockCompact" : "playerDock"} aria-label="音乐播放器">
      <audio
        ref={audioRef}
        src={streamSrc}
        preload="metadata"
        onEnded={handleEnded}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || track?.durationSeconds || 0)}
        onError={() => setMessage("播放失败，可能是音频缓存已过期")}
      />

      {isCompact ? (
        <div className="compactPlayer">
          <div className="compactNowPlaying">
            <span className="badge blue">{trackStatusLabel(track)}</span>
            <strong>{currentItem?.title || "音乐播放器待机"}</strong>
            <small>{currentItem?.creatorName || currentItem?.bvid || "从候选视频点“播放”后展开控制"}</small>
          </div>
          <button type="button" onClick={() => void togglePlay()} disabled={busy || (!currentItem && !track)}>
            {isPlaying ? "暂停" : track?.status === "ready" ? "播放" : "准备"}
          </button>
          <button type="button" className="secondary" onClick={() => void favoriteCurrentItem()} disabled={busy || !currentItem}>
            收藏
          </button>
          <button type="button" className="secondary" onClick={() => setIsExpanded(true)}>
            展开
          </button>
        </div>
      ) : (
        <>
      <div className="playerMain">
        <div className="nowPlaying">
          <span className="badge blue">{trackStatusLabel(track)}</span>
          <strong>{currentItem?.title || "还没有播放队列"}</strong>
          <small>{currentItem?.creatorName || currentItem?.bvid || "从候选视频点“播放”开始"}</small>
          <button type="button" className="ghost dockCollapseButton" onClick={() => setIsExpanded(false)}>
            收起
          </button>
        </div>

        <div className="playerControls">
          <button
            type="button"
            className="secondary"
            onClick={() => playRelative("previous")}
            disabled={
              queue.length < 1 ||
              (currentTime <= RESTART_PREVIOUS_THRESHOLD_SECONDS &&
                !canMoveManually(currentIndex, queue.length, playbackMode, "previous"))
            }
          >
            上一首
          </button>
          <button type="button" onClick={() => void togglePlay()} disabled={busy || (!currentItem && !track)}>
            {isPlaying ? "暂停" : track?.status === "ready" ? "播放" : "准备/播放"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => playRelative("next")}
            disabled={!canMoveManually(currentIndex, queue.length, playbackMode, "next")}
          >
            下一首
          </button>
          <button type="button" className="secondary" onClick={() => setPlaybackMode(nextPlaybackMode(playbackMode))}>
            {playbackModeLabel(playbackMode)}
          </button>
          <button type="button" className="secondary" onClick={() => void favoriteCurrentItem()} disabled={busy || !currentItem}>
            收藏当前
          </button>
          {track?.status === "ready" && track.media.downloadUrl ? (
            <a className="buttonLink secondary" href={track.media.downloadUrl} download={track.media.fileName || undefined}>
              下载离线{track.media.sizeBytes ? ` · ${formatBytes(track.media.sizeBytes)}` : ""}
            </a>
          ) : (
            <button type="button" className="secondary" disabled>
              准备好后可下载
            </button>
          )}
          <button type="button" className="ghost" onClick={() => void refreshCurrentTrack()} disabled={busy || (!currentItem && !track)}>
            重新准备
          </button>
        </div>

        <div className="playerProgress">
          <span>{formatTime(currentTime)}</span>
          <input
            aria-label="播放进度"
            type="range"
            min={0}
            max={100}
            value={progress}
            onChange={(event) => seek(Number(event.target.value))}
            disabled={track?.status !== "ready"}
          />
          <span>{formatTime(duration || track?.durationSeconds || 0)}</span>
        </div>
        <div className="playerStatusRow">
          <p className="note">{message}</p>
          <label className="volumeControl">
            音量
            <input
              aria-label="音量"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
            />
          </label>
        </div>
      </div>

      <div className="playerSide">
        <details className="queuePanel">
          <summary>队列 {queue.length} / 历史 {history.length}</summary>
          <div className="queueActions">
            <button type="button" className="ghost" onClick={() => playAt(0)} disabled={!queue.length || currentIndex === 0}>
              播放队首
            </button>
            <button type="button" className="ghost" onClick={clearQueue} disabled={!queue.length}>
              清空队列
            </button>
          </div>
          <div className="queueList">
            {queue.map((item, index) => (
              <div className={index === currentIndex ? "queueItem activeQueueItem" : "queueItem"} key={item.candidateId}>
                <button type="button" className="ghost" onClick={() => playAt(index)}>
                  {index + 1}. {item.title}
                </button>
                <button type="button" className="ghost queueRemove" onClick={() => removeQueueItem(index)} aria-label={`移除 ${item.title}`}>
                  移除
                </button>
              </div>
            ))}
          </div>
          {history.length ? (
            <div className="historyList">
              <span>最近播放</span>
              {history.slice(0, 3).map((item) => (
                <small key={item.candidateId}>{item.title}</small>
              ))}
            </div>
          ) : null}
        </details>
        <details className="kernelSettings">
          <summary>播放策略</summary>
          <div className="miniGrid">
            <label>
              策略
              <select value={strategy} onChange={(event) => setStrategy(event.target.value as StrategyChoice)}>
                <option value="api_dash">极速 api_dash（推荐云机）</option>
                <option value="auto">自动兜底（api_dash → browser_network）</option>
                <option value="browser_network">登录态 browser_network</option>
                <option value="mse_sourcebuffer">实验 mse_sourcebuffer</option>
              </select>
            </label>
          </div>
        </details>
      </div>
        </>
      )}
    </aside>
  );
}

export function playCandidate(candidate: CandidateWithScore): void {
  window.dispatchEvent(new CustomEvent("bili-music:play-candidate", { detail: { candidate, mode: "play" } }));
}

export function prewarmCandidate(candidate: CandidateWithScore): void {
  window.dispatchEvent(new CustomEvent("bili-music:play-candidate", { detail: { candidate, mode: "prewarm" } }));
}

export function downloadCandidate(candidate: CandidateWithScore): void {
  window.dispatchEvent(new CustomEvent("bili-music:play-candidate", { detail: { candidate, mode: "download" } }));
}

function toQueueItem(candidate: CandidateWithScore): QueueItem {
  return {
    candidateId: candidate.id,
    bvid: candidate.bvid,
    title: candidate.title,
    creatorName: candidate.creatorName
  };
}

async function postJson<T>(url: string, body: object): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseJsonResponse<T>(response);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
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
    return "音频已准备好，正在通过 App 代理从内核流式播放";
  }
  if (track.status === "preparing") {
    return track.failureReason || "内核正在准备 audio.m4a，稍等一下";
  }
  if (track.status === "expired") {
    return "音频缓存已过期，点击重新准备";
  }
  if (track.status === "failed") {
    return track.failureReason || "音频准备失败";
  }
  return "等待准备音频";
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
    pending: "待准备",
    preparing: "准备中",
    ready: "可播放",
    expired: "已过期",
    failed: "失败"
  };
  return labels[track?.status || ""] || "未选择";
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function readStoredPlayerState(): StoredPlayerState | null {
  try {
    const raw = window.localStorage.getItem(PLAYER_STATE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as StoredPlayerState;
    return {
      queue: Array.isArray(parsed.queue) ? parsed.queue.filter(isQueueItem).slice(0, 80) : [],
      history: Array.isArray(parsed.history) ? parsed.history.filter(isQueueItem).slice(0, 20) : [],
      currentIndex: Number.isFinite(parsed.currentIndex) ? parsed.currentIndex : -1,
      playbackMode: normalizePlaybackMode(parsed.playbackMode),
      volume: clampVolume(parsed.volume)
    };
  } catch {
    return null;
  }
}

function writeStoredPlayerState(state: StoredPlayerState): void {
  try {
    window.localStorage.setItem(
      PLAYER_STATE_KEY,
      JSON.stringify({
        ...state,
        queue: state.queue.slice(0, 80),
        history: state.history.slice(0, 20),
        currentIndex: normalizeIndex(state.currentIndex, state.queue.length),
        volume: clampVolume(state.volume)
      })
    );
  } catch {
    // Local playback state cache only.
  }
}

function isQueueItem(value: unknown): value is QueueItem {
  const item = value as Partial<QueueItem>;
  return (
    typeof item?.candidateId === "number" &&
    typeof item.bvid === "string" &&
    typeof item.title === "string" &&
    (typeof item.creatorName === "string" || item.creatorName === null)
  );
}

function normalizeIndex(index: number, queueLength: number): number {
  if (!queueLength) {
    return -1;
  }
  if (!Number.isFinite(index)) {
    return -1;
  }
  return Math.max(-1, Math.min(queueLength - 1, Math.round(index)));
}

function normalizePlaybackMode(value: unknown): PlaybackMode {
  return value === "list_loop" || value === "single_loop" || value === "shuffle" ? value : "sequence";
}

function clampVolume(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0.82;
  }
  return Math.max(0, Math.min(1, num));
}
