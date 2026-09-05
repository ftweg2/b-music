import { PLAYBACK_MODES, type PlaybackMode } from "./playback";
import type { TrackApiResource } from "./trackApi";
import type { CandidateItem } from "./models";

export function buildPlaylistQueue(candidates: CandidateItem[]): QueueItem[] {
  const seen = new Set<string>();
  const queue = candidates.filter((candidate) => {
    if (!candidate || typeof candidate.bvid !== "string" || seen.has(candidate.bvid)) return false;
    seen.add(candidate.bvid); return true;
  }).map((candidate) => ({
    candidateId: candidate.id, bvid: candidate.bvid, title: candidate.title,
    creatorName: candidate.creatorName, coverUrl: candidate.coverUrl,
    creatorMid: candidate.creatorMid,
  }));
  return normalizePlayerState({ queue, currentIndex: 0 })?.queue ?? [];
}

export type QueueItem = {
  candidateId: number;
  bvid: string;
  title: string;
  creatorName: string | null;
  creatorMid?: string | null;
  coverUrl?: string | null;
};
export type StoredPlayerState = {
  queue: QueueItem[]; history: QueueItem[]; currentIndex: number;
  playbackMode: PlaybackMode; volume: number;
};

export function normalizePlayerState(value: unknown): StoredPlayerState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<StoredPlayerState>;
  const normalizeItems = (items: unknown, limit: number) => {
    if (!Array.isArray(items)) return [];
    const seen = new Set<number>();
    return items.filter((item): item is QueueItem => {
      if (!item || !Number.isSafeInteger(item.candidateId) || item.candidateId <= 0 ||
        typeof item.bvid !== "string" || typeof item.title !== "string" || seen.has(item.candidateId)) return false;
      seen.add(item.candidateId);
      return true;
    }).slice(0, limit).map((item) => ({
      candidateId: item.candidateId, bvid: item.bvid.slice(0, 32), title: item.title.slice(0, 500),
      creatorName: typeof item.creatorName === "string" ? item.creatorName.slice(0, 300) : null,
      creatorMid: typeof item.creatorMid === "string" && /^\d{1,24}$/.test(item.creatorMid) ? item.creatorMid : null,
      coverUrl: typeof item.coverUrl === "string" && /^(https?:)?\/\//.test(item.coverUrl) ? item.coverUrl : null,
    }));
  };
  const queue = normalizeItems(raw.queue, 200);
  const originalItem = Array.isArray(raw.queue) && Number.isInteger(raw.currentIndex) ? raw.queue[raw.currentIndex!] : null;
  const restoredIndex = queue.findIndex((item) => item.candidateId === originalItem?.candidateId);
  return {
    queue, history: normalizeItems(raw.history, 20),
    currentIndex: queue.length ? Math.max(0, restoredIndex) : -1,
    playbackMode: PLAYBACK_MODES.includes(raw.playbackMode as PlaybackMode) ? raw.playbackMode! : "sequence",
    volume: typeof raw.volume === "number" && Number.isFinite(raw.volume) ? Math.max(0, Math.min(1, raw.volume)) : 0.82,
  };
}

export function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// One sequential poller per user action. A cancelled action can never publish another update.
export async function waitForPreparedTrack(options: {
  prepare: (signal: AbortSignal) => Promise<TrackApiResource>;
  read: (id: number, signal: AbortSignal) => Promise<TrackApiResource>;
  onUpdate: (track: TrackApiResource) => void;
  signal: AbortSignal;
  timeoutMs?: number;
  delay?: typeof delayWithSignal;
}): Promise<TrackApiResource> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 300_000)]);
  signal.throwIfAborted();
  let track = await options.prepare(signal);
  let interval = 1200;
  for (;;) {
    signal.throwIfAborted();
    options.onUpdate(track);
    if (track.status === "ready") return track;
    if (track.status === "failed" || track.status === "expired") {
      throw new Error(track.failureReason || "音频准备失败，请重试");
    }
    await (options.delay ?? delayWithSignal)(interval, signal);
    signal.throwIfAborted();
    track = await options.read(track.id, signal);
    interval = Math.min(4000, interval + 400);
  }
}
