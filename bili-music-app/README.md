# B-Music App

App layer for local-first Bilibili music discovery.

This repository stores metadata-only `CandidateVideo` records, lets users build a local music library, follow preferred UP creators, ranks search results, and provides a small Chinese Web UI. It does not extract audio, download media, store cookies, run Playwright, or implement the extraction kernel.

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

## Playback

Playback follows `准备音频 -> 流式播放 -> 队列预热`.

When a user clicks `播放` on a candidate video, the App creates or reuses a metadata-only `Track`, submits a kernel job with `outputs: ["m4a"]`, polls kernel status through App API routes, and plays `/api/tracks/{track_id}/stream` with a native `<audio>` element.

The stream endpoint proxies the kernel artifact and forwards `Range` requests for seeking. The App stores only track metadata: kernel job id, artifact name, size, sha256, mime type, duration, status, and expiration. It does not write audio files, signed media URLs, raw buffers, cookies, or browser session state to App storage.

## Cover Images

Bilibili cover images can fail on localhost because the browser sends a non-Bilibili `Referer`. The app displays Bilibili covers through `/api/image-proxy`, which only allows `i0.hdslb.com`, `i1.hdslb.com`, and `i2.hdslb.com` paths under `/bfs/`.

The proxy streams image responses for display only. It does not persist images, cookies, signed media URLs, audio, or video files.

## Basic Flow

1. Open `/creators` and follow a UP by pasting a Bilibili space URL or entering a `mid`; the faster path is clicking `关注 UP` on a candidate card.
2. Open `/search`, enter a keyword, and choose a search source.
3. Use `上一页` / `下一页` to request explicit search pages. Pagination is capped and user-triggered; there is no infinite crawling.
4. Use `收藏` to save candidates into the local App library. This is not Bilibili收藏.
5. Use `关注 UP` on a candidate to make that creator rank higher and join followed-UP search expansion.
6. Click `播放` on a candidate. Fill the bottom player `owner/profile` fields if they were not already saved by the kernel login panel.
7. Open `/favorites` for the local 收藏 library. The old `/recommendations` path now redirects there.

## Local Library

The App now keeps a metadata-only local music library:

- `收藏` stores the candidate video id, note/mood fields, and timestamps in SQLite.
- `关注 UP` stores the creator `mid`, name, homepage, and ranking weight.
- Search first checks local metadata, then followed-UP local matches, then favorites, and only then the selected remote provider.
- Remote followed-UP expansion is conservative: at most the top followed creators are used as extra user-triggered search hints.

No Bilibili favorites are changed, and no media files are saved in the App.

Advanced playback features such as lyrics, equalizer, spectrum, offline cache, and cross-device sync are intentionally out of scope.

## Docs

- `src/docs/API_USAGE.md`: Web and Android-facing App API usage reference.
- `src/docs/CLOUD_DEPLOYMENT.md`: deployment guide for App + external kernel.
- `src/docs/OPERATIONS_CHECKLIST.md`: current quality notes and follow-up checklist.
