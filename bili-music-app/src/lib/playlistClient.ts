import type { CandidateItem } from "./models";
import { accountFetch } from "./accountClient";

export const PLAYLIST_CHANGE_EVENT = "bili-music:playlists-changed";
export const PLAYLIST_PICKER_EVENT = "bili-music:add-to-playlist";
export function openPlaylistPicker(candidate: CandidateItem) {
  window.dispatchEvent(new CustomEvent(PLAYLIST_PICKER_EVENT, { detail: candidate }));
}
export function playlistsChanged() { window.dispatchEvent(new Event(PLAYLIST_CHANGE_EVENT)); }

export async function playlistRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await accountFetch(url, {
    ...init, cache: "no-store",
    headers: { "content-type": "application/json", ...init.headers },
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "歌单操作失败，请重试");
  return payload as T;
}
