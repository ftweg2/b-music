/** Shared metadata contract. This module is safe in both native-client examples and the browser. */
export type PlaybackRange = {
  accountId: string;
  bvid: string;
  startSeconds: number;
  endSeconds: number | null;
  revision: number;
  updatedAt: string | null;
  configured: boolean;
};

export function effectivePlaybackRange(range: Pick<PlaybackRange, "startSeconds" | "endSeconds"> | undefined, duration: number) {
  const start = range?.startSeconds ?? 0;
  const knownDuration = Number.isFinite(duration) && duration > 0 ? duration : null;
  const end = range?.endSeconds === null || range?.endSeconds === undefined
    ? knownDuration : knownDuration === null ? range.endSeconds : Math.min(range.endSeconds, knownDuration);
  return { start, end, valid: end === null || start < end, stopAtEnd: range?.endSeconds !== null && range?.endSeconds !== undefined };
}

export function parsePlaybackTime(text: string): number | null {
  const value = text.trim();
  if (!value) return null;
  if (!/^(?:\d+:){0,2}\d+(?:\.\d{1,3})?$/.test(value)) return NaN;
  const parts = value.split(":").map(Number);
  if (parts.slice(1).some(part => part >= 60)) return NaN;
  return Math.round(parts.reduce((seconds, part) => seconds * 60 + part, 0) * 1000) / 1000;
}

export function formatPlaybackTime(seconds: number): string {
  const milliseconds = Math.round(Math.max(0, seconds) * 1000);
  const whole = Math.floor(milliseconds / 1000);
  const fraction = milliseconds % 1000;
  const base = Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
  return base + (fraction ? "." + String(fraction).padStart(3, "0").replace(/0+$/, "") : "");
}

export function playbackResumeTime(range: Pick<PlaybackRange,"startSeconds"|"endSeconds"> | undefined,duration:number,currentTime:number): number {
  const bounds=effectivePlaybackRange(range,duration);
  // AAC/video seeks can land a frame before the requested end. Treat that
  // paused end position as replay, rather than playing a few milliseconds.
  const tolerance=bounds.end===null?0:Math.min(0.05,(bounds.end-bounds.start)/2);
  return currentTime<bounds.start||(bounds.end!==null&&currentTime>=bounds.end-tolerance)?bounds.start:currentTime;
}
