// Refresh account-scoped views and stop the old player. Server library records are never deleted.
export const ACCOUNT_CHANGE_EVENT = "bili-music:account-changed";
export function accountChanged() {
  try { window.sessionStorage.removeItem("bili-music-app:search-state:v7"); } catch { /* Only metadata cache, never the library. */ }
  window.dispatchEvent(new Event(ACCOUNT_CHANGE_EVENT));
}
