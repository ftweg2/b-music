# Strategy Policy

The kernel supports two sources, each with its own strategies:

| Source | Strategies (default order) |
| --- | --- |
| Bilibili | 1. `api_dash` 2. `browser_network` 3. `mse_sourcebuffer` |
| Douyin | 1. `douyin_music` |

The source is decided from the job URL when the job is created. A strategy never runs against a source it was not written for: forcing or listing one is rejected with `400` before a job exists.

Strategies run behind a common interface:

- `name`
- `supports(context) -> bool`
- `run(context) -> StrategyResult`

`StrategyResult` includes status, reason, selected media, raw artifacts, timings, sanitized debug info, and failure code on failure.

## Force Mode

Force mode runs only the specified strategy. It does not fall back.

## Auto Mode

Auto mode follows the explicit `strategy_order` exactly (deduplicated), or the source's default order when none is supplied. An explicit list is an allowlist: omitted strategies are never appended. Empty and unavailable explicit strategies are rejected. Historical metrics remain diagnostics only and do not score or reorder strategies.

The kernel runs strategies sequentially and does not parallelize them.

## Douyin Music

`douyin_music` handles one user-supplied Douyin link per job:

1. A `v.douyin.com` share link is resolved one redirect at a time; every hop must stay on a Douyin host.
2. The public video page is opened in a fresh, cookie-less, muted browser context. No profile, login or stored browser state is used, and the browser is not disguised as anything other than an automated browser. Images, video, fonts and styles are not loaded. The strategy reads the item detail that the page itself requests.
3. If the item has a background-music track, that standalone file (normally MP3) is downloaded unchanged as `raw.mp3`.
4. Otherwise the item's video is downloaded, its first audio stream is copied without re-encoding into `raw.m4a`, ffprobe must confirm the result is audio-only, and the video file is deleted.

The parsed item detail is kept in kernel memory for two minutes (never persisted), so a job submitted right after `POST /v1/douyin/resolve` for the same item does not load the page again. Unavailable items are not cached.

Downloads, including redirects, may only reach Douyin media CDN hosts (`douyinstatic.com`, `douyinvod.com`, `douyincdn.com`, `zjcdn.com`, `bytecdn.cn`, `amemv.com`, `snssdk.com`). Reports record the media host, never the signed URL.

Douyin jobs should request `outputs: ["raw"]`. The m4a output is a stream-copy remux, and MP4/M4A cannot carry MP3 audio, so requesting `m4a` for an MP3 source fails the job with the raw file preserved.

Douyin jobs still name an owner `profile_id` for ownership checks, but they do not take that profile's job lock, so they can run while a Bilibili job holds it. Lookups and jobs share the `MAX_ACTIVE_JOBS` budget. At most `DOUYIN_MAX_BROWSERS` (default 1) lookup browsers run at once and at most four more lookups wait; further lookups fail fast with `DOUYIN_BUSY` (`503` + `Retry-After` from `POST /v1/douyin/resolve`). Inside a job, a timeout, busy pool or browser crash is retried once.

Media downloads use up to `DOUYIN_DOWNLOAD_CONCURRENCY` (default 2) ranged parts of at least 1 MiB when the CDN supports ranges, and fall back to one stream otherwise. Files larger than `DOUYIN_MAX_DOWNLOAD_BYTES` (default 512 MiB) are refused before or while downloading (`MEDIA_TOO_LARGE`); partial files are removed.

### Lookup browser

- Uses small-machine launch flags: one renderer process, no GPU, sync, extensions or background services.
- A page crash or browser disconnect (for example an out-of-memory kill) fails the lookup at once with `DOUYIN_BROWSER_CRASHED`.
- Starts inside Chromium's sandbox. Playwright disables the sandbox by default; the lookup browser opts back in because it runs Douyin's page scripts. Where the sandbox cannot start (the Docker image runs Chromium as root), the kernel falls back once per process, logs a warning, and records `browser_sandbox: false` in the strategy report; the container is then the isolation boundary.
- Loads documents (pages and frames) only from `https://*.douyin.com`.
- Never loads images, media, fonts, styles, WebSockets, event streams, manifests or text tracks, and never contacts analytics/performance beacon hosts (`zijieapi.com`, `ibytedapm.com`).
- Each lookup opens a fresh context. Nothing (cookies, storage, cache) carries over between lookups.

Downloaded media must start with a real container signature (MP3/ID3, ADTS, MP4/M4A, Ogg, FLAC, WAV); a CDN error page served with HTTP 200 is discarded and the next mirror is tried.

A lookup takes roughly 5–10 seconds on a desktop, almost all of it Douyin's own page scripts; allow several times that on a 0.5-core container (`DOUYIN_DETAIL_TIMEOUT_SECONDS`, default 45). Calling Douyin's signed web APIs directly would be faster, but relying on the page's request signing for requests the page did not make is the kind of anti-bot workaround the [security boundary](SECURITY_BOUNDARY.md) rules out.

## Metrics

The kernel persists per-strategy metrics:

- `strategy_name`
- `total_attempts`
- `success_count`
- `fail_count`
- `last_success_at`
- `last_failure_at`
- `last_failure_reason`
- `avg_duration_ms`

## Strategy Report

Every attempted strategy is recorded in `strategy_report.json`, including failures. Full signed URLs, cookies, and sensitive headers must not appear in reports.

## MSE Diagnostics

`mse_sourcebuffer` is a last-resort strategy. It now records sanitized diagnostics for:

- MediaSource and ManagedMediaSource availability.
- `URL.createObjectURL(MediaSource)` and `sourceopen` activity.
- SourceBuffer MIME types and append counts.
- HTML video element readiness and codec support.
- Chromium CDP Media player events, messages, properties, and errors.

The Docker image installs and defaults to the Playwright `chrome` channel because Bilibili DASH audio normally uses AAC/MP4. Playwright's bundled open-source Chromium may not report support for those codecs, which prevents normal player/MSE initialization. This is a media compatibility setting, not stealth or anti-bot evasion.

`MSE_CAPTURE_MS` controls how long the strategy keeps the real player open and records audio SourceBuffer appends. The default Docker value is `45000`. `MSE_PLAYBACK_RATE` defaults to `4.0` so normal browser playback can buffer more audio during that window. Longer videos may still require larger values because MSE capture can only record bytes the normal player actually buffers.
