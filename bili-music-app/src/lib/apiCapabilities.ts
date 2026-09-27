import { accountLibraryEnabled } from "./ownerIdentity";
export const API_VERSION = "1";
// 1.3.0 (additive): Douyin links in search, DY-prefixed video references,
// kernel-cached Douyin covers served at App-relative /api/covers/{bvid}.
export const API_REVISION = "1.3.0";
export const MAX_TRACK_STATUS_BATCH = 20;
export const DEFAULT_TRACK_POLL_AFTER_MS = 1500;

export function apiCapabilities() {
  return {
    apiVersion: API_VERSION,
    apiRevision: API_REVISION,
    serverTime: new Date().toISOString(),
    features: {
      searchPagination: true,
      favoritesPagination: true,
      playlists: true,
      playlistReorder: true,
      followedCreatorsFirst: true,
      accountSwitch: true,
      fixedSourceSearchPagination: true,
      stableSearchSnapshots: true,
      searchPageJump: true,
      automaticAuthenticatedSearch: true,
      searchDuringPreparation: true,
      accountScopedLibrary: accountLibraryEnabled(),
      playbackRanges: true,
      playbackRangeSync: true,
      playbackRangeConflictDetection: true,
      structuredErrors: true,
      requestTracing: true,
      idempotentPlaylistCreate: true,
      trackBatchStatus: true,
      trackListRestore: true,
      mediaStreaming: true,
      mediaDownload: true,
      mediaHead: true,
      byteRangeRequests: true,
      sha256Checksum: true,
      resumableDownloads: true,
      // Search accepts Douyin share links; such candidates use bvid "DY<item id>".
      douyinLinks: true,
      // Douyin candidates' coverUrl is App-relative (/api/covers/DY…); resolve it against the base URL.
      relativeCoverUrls: true
    },
    limits: {
      trackStatusBatch: MAX_TRACK_STATUS_BATCH,
      favoritesPageSize: 100,
      playlistsPerOwner: 100,
      playlistItems: 200
    },
    defaults: {
      loginStartTimeoutMs: 90000,
      trackPollAfterMs: DEFAULT_TRACK_POLL_AFTER_MS
    },
    endpoints: {
      health: "/api/health",
      openapi: "/api/openapi.json",
      search: "/api/search",
      playbackRange: "/api/playback-ranges/{bvid}",
      douyinCover: "/api/covers/{bvid}",
      favorites: "/api/favorites",
      playlists: "/api/playlists",
      playlist: "/api/playlists/{playlistId}",
      playlistItems: "/api/playlists/{playlistId}/items",
      prepareTrack: "/api/tracks/prepare",
      tracks: "/api/tracks",
      trackStatus: "/api/tracks/{trackId}",
      batchTrackStatus: "/api/tracks/status",
      streamTrack: "/api/tracks/{trackId}/stream",
      downloadTrack: "/api/tracks/{trackId}/download"
    }
  };
}
