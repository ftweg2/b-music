export const API_VERSION = "1";
export const MAX_TRACK_STATUS_BATCH = 20;
export const DEFAULT_TRACK_POLL_AFTER_MS = 1500;

export function apiCapabilities() {
  return {
    apiVersion: API_VERSION,
    serverTime: new Date().toISOString(),
    features: {
      searchPagination: true,
      favoritesPagination: true,
      trackBatchStatus: true,
      trackListRestore: true,
      mediaStreaming: true,
      mediaDownload: true,
      mediaHead: true,
      byteRangeRequests: true,
      sha256Checksum: true,
      resumableDownloads: true
    },
    limits: {
      trackStatusBatch: MAX_TRACK_STATUS_BATCH,
      favoritesPageSize: 100
    },
    defaults: {
      trackPollAfterMs: DEFAULT_TRACK_POLL_AFTER_MS
    },
    endpoints: {
      health: "/api/health",
      search: "/api/search",
      favorites: "/api/favorites",
      prepareTrack: "/api/tracks/prepare",
      tracks: "/api/tracks",
      trackStatus: "/api/tracks/{trackId}",
      batchTrackStatus: "/api/tracks/status",
      streamTrack: "/api/tracks/{trackId}/stream",
      downloadTrack: "/api/tracks/{trackId}/download"
    }
  };
}
