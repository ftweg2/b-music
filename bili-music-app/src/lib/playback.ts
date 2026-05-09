export type PlaybackMode = "sequence" | "list_loop" | "single_loop" | "shuffle";

export const PLAYBACK_MODES: PlaybackMode[] = ["sequence", "list_loop", "single_loop", "shuffle"];

export function playbackModeLabel(mode: PlaybackMode): string {
  const labels: Record<PlaybackMode, string> = {
    sequence: "顺序播放",
    list_loop: "列表循环",
    single_loop: "单曲循环",
    shuffle: "随机播放"
  };
  return labels[mode];
}

export function nextPlaybackMode(mode: PlaybackMode): PlaybackMode {
  const index = PLAYBACK_MODES.indexOf(mode);
  return PLAYBACK_MODES[(index + 1) % PLAYBACK_MODES.length];
}

export function nextIndexOnEnded(
  currentIndex: number,
  queueLength: number,
  mode: PlaybackMode,
  random = Math.random
): number | null {
  if (!hasPlayableQueue(currentIndex, queueLength)) {
    return null;
  }
  if (mode === "single_loop") {
    return currentIndex;
  }
  if (mode === "shuffle") {
    return randomQueueIndex(queueLength, currentIndex, random);
  }
  const next = currentIndex + 1;
  if (next < queueLength) {
    return next;
  }
  return mode === "list_loop" ? 0 : null;
}

export function nextIndexOnManual(
  currentIndex: number,
  queueLength: number,
  mode: PlaybackMode,
  direction: "next" | "previous",
  random = Math.random
): number | null {
  if (!hasPlayableQueue(currentIndex, queueLength)) {
    return null;
  }
  if (mode === "shuffle" && queueLength > 1) {
    return randomQueueIndex(queueLength, currentIndex, random);
  }
  const delta = direction === "next" ? 1 : -1;
  const next = currentIndex + delta;
  if (next >= 0 && next < queueLength) {
    return next;
  }
  if (mode === "list_loop") {
    return direction === "next" ? 0 : queueLength - 1;
  }
  return null;
}

export function canMoveManually(
  currentIndex: number,
  queueLength: number,
  mode: PlaybackMode,
  direction: "next" | "previous"
): boolean {
  return nextIndexOnManual(currentIndex, queueLength, mode, direction, () => 0.5) !== null;
}

function hasPlayableQueue(currentIndex: number, queueLength: number): boolean {
  return queueLength > 0 && currentIndex >= 0 && currentIndex < queueLength;
}

function randomQueueIndex(queueLength: number, currentIndex: number, random: () => number): number {
  if (queueLength <= 1) {
    return currentIndex;
  }
  const pool = Array.from({ length: queueLength }, (_value, index) => index).filter((index) => index !== currentIndex);
  const selected = Math.floor(random() * pool.length);
  return pool[Math.max(0, Math.min(pool.length - 1, selected))];
}
