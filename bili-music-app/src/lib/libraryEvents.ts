export const LIBRARY_CHANGE_EVENT = "bili-music:library-change";
export type LibraryChange =
  | { kind: "favorite"; candidateId: number; bvid: string; favorited: boolean }
  | { kind: "creator"; biliMid: string; followed: boolean };

export function notifyLibraryChange(change: LibraryChange): void {
  window.dispatchEvent(new CustomEvent(LIBRARY_CHANGE_EVENT, { detail: change }));
}
