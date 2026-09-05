# B-Music App

App layer for local-first Bilibili music discovery.

This repository stores metadata-only `CandidateVideo` records, lets users build a local music library, follow preferred UP creators, prioritizes followed creators without numeric scores, and provides a small Chinese Web UI. It does not extract audio or persist media in App storage, store cookies, run Playwright, or implement the extraction kernel. User-initiated downloads are streamed to the browser/mobile device for offline listening.

## Run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:3000`.

## Environment

Copy `.env.example` to `.env` when needed. The default provider is `bilibili`; the test-only mock provider is not shown in the product UI.

```bash
SEARCH_PROVIDER=bilibili
DATABASE_PATH=./data/bili-music-app.sqlite
KERNEL_BASE_URL=http://localhost:8000
KERNEL_REQUEST_TIMEOUT_MS=15000
KERNEL_EXTERNAL_OWNER_ID=local
TRACK_ARTIFACT_TTL_SECONDS=86400
APP_OWNER_ID=local
```

The UI can choose `Bilibili 普通搜索` or `内核登录态搜索` per search. Kernel search sends only `external_owner_id`, `profile_id`, keyword, and limit to the kernel HTTP API. Cookies stay inside the kernel-owned browser profile and are never returned to this app.

When `内核登录态搜索` is selected, the search page shows a kernel login panel:

1. Create or bind a kernel profile for the current `external_owner_id`.
2. Start normal Bilibili QR login inside the kernel profile.
3. Display the QR screenshot through the App proxy.
4. Poll sanitized login status: `logged_in`, `bili_uid`, `nickname`, and `last_verified_at`.

The App does not receive Cookie, storage state, browser profile files, QR token internals, or sensitive headers.

## Playback And Offline Download

Playback follows `准备音频 -> 流式播放 -> 队列预热`.

When a user clicks `播放` on a candidate video, the App creates or reuses a metadata-only `Track`, submits a kernel job with `outputs: ["m4a"]`, polls kernel status through App API routes, and plays `/api/tracks/{track_id}/stream` with a native `<audio>` element.

The stream endpoint proxies the kernel artifact and forwards `Range` requests for seeking. The App stores only track metadata: kernel job id, artifact name, size, sha256, mime type, duration, status, and expiration. It does not write audio files, signed media URLs, raw buffers, cookies, or browser session state to App storage.

Click `下载` on a candidate or open `/downloads`. The App prepares the same audio artifact and streams `/api/tracks/{track_id}/download` with an attachment filename, `HEAD`, byte ranges, SHA-256, and size headers. The browser or phone stores the file; the App server does not keep another copy. Downloads run independently and do not interrupt the current song.

## Cover Images

Bilibili cover images can fail on localhost because the browser sends a non-Bilibili `Referer`. The app displays Bilibili covers through `/api/image-proxy`, which only allows `i0.hdslb.com`, `i1.hdslb.com`, and `i2.hdslb.com` paths under `/bfs/`.

The proxy streams image responses for display only. It does not persist images, cookies, signed media URLs, audio, or video files.

## Basic Flow

1. Open `/creators` and follow a UP by pasting a Bilibili space URL or entering a `mid`; the faster path is clicking `关注 UP` on a candidate card.
2. Open `/search`, enter a keyword, and choose a search source.
3. Use `上一页` / `下一页` to request explicit search pages. Pagination is capped and user-triggered; there is no infinite crawling.
4. Use `收藏` to save candidates into the local App library. This is not Bilibili收藏.
5. Use `关注 UP` to bookmark that creator and find their work later.
6. Click `播放` on a candidate. The configured kernel profile is prepared by the App; playback settings are available in the player.
7. Open `/favorites` for the local 收藏 library, or `/downloads` for prepared download tasks. The old `/recommendations` path redirects to favorites.

## Local Library

The App now keeps a metadata-only local music library:

- `收藏` stores the candidate video id, note/mood fields, and timestamps in SQLite.
- `关注 UP` stores the creator `mid`, name, homepage, and optional notes.
- Online search preserves source order; local search matches saved metadata separately.
- Provider failure is explicit; pagination never switches to local results automatically. There are no music scores or extra creator searches.

No Bilibili favorites are changed, and no media files are saved in the App.

Advanced playback features such as lyrics, equalizer, spectrum, App-managed offline cache, and cross-device sync are intentionally out of scope. Client-owned downloaded files are supported.

## Account and search flow

Settings supports switching the service's active Bilibili account. Libraries and playback ranges now default to verified-account partitions; switching back restores the account's data, and the legacy library is adopted once without changing record IDs. Web and native API clients connected to the same service share the active account's settings. This is still a trusted single-active-login service, not independent per-device multi-user authentication. See [account/search behavior](src/docs/ACCOUNT_AND_SEARCH.md).

## Playlists

Open `/playlists` to create and organize private music collections. Add tracks from search, favorites or track details; reorder, play all, shuffle or append a playlist to the queue. Playlists are stored as owner-scoped metadata and do not download audio automatically. See [playlist behavior and limits](src/docs/PLAYLISTS.md) and the [unified API calling guide](src/docs/API_USAGE.md).

## Docs

- [API calling guide](src/docs/API_USAGE.md): the unified Web/Android-facing v1 (revision 1.2.0) reference, including playback start/end editing and account-context guards; the running server publishes its complete schema at `/api/openapi.json`.
- `src/docs/CLOUD_DEPLOYMENT.md`: deployment guide for App + external kernel.
- `src/docs/OPERATIONS_CHECKLIST.md`: current quality notes and follow-up checklist.
