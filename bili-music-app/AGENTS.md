# bili-music-app Project Instructions

## Project Identity

`bili-music-app` is the App layer for Bilibili music discovery. It is not the Dockerized extraction kernel.

The extraction kernel exists as a separate service and is integrated only through HTTP APIs. Do not implement kernel internals, audio extraction, media URL extraction, Playwright automation, WBI signing, or browser automation in this repository.

## Security And Scope Boundaries

- Store metadata only.
- Do not download, copy, cache, or persist audio/video files in App storage.
- Do not cache full Bilibili pages.
- Do not store signed media URLs.
- Do not store cookies, browser login state, localStorage, sessionStorage, or credentials.
- Do not create account pools.
- Do not implement CAPTCHA bypass, DRM/EME bypass, anti-bot evasion, region bypass, membership bypass, or access-control bypass.
- Search must be user-triggered, rate-limited, timeout-bound, and metadata-only.
- Remote provider failures must be handled gracefully.
- Preferred/followed UP creators are manually configured or saved from candidate cards in the MVP.
- Local favorites are App-owned metadata records only; they must not sync to Bilibili or download media.
- Do not implement infinite crawling, batch scraping, or unlimited pagination.

## Domain Model

- `CandidateVideo` is a metadata-only Bilibili video returned from search or a conservative creator refresh.
- `Track` is a playable metadata record bound to a kernel job and artifact. Track audio is streamed through the App from the kernel artifact; the App must not persist audio bytes.
- `PreferredCreator` is a manually followed UP creator. Search puts followed creators first without scores; preserve source order within each group.
- `FavoriteVideo` is a local App library record pointing at a `CandidateVideo`; it is not a Bilibili favorite.

## App And Kernel Separation

- Kernel integration must be via HTTP APIs only.
- Playback preparation may call the kernel to create extraction jobs with explicit user action.
- `/api/tracks/[id]/stream` may proxy kernel artifact streams and forward Range headers, but must not buffer full audio files or write them to disk.
- Store only track metadata such as kernel job id, artifact name, size, checksum, mime type, duration, status, and expiration.

## Account And Playback Settings

The default library mode is verified Bilibili account partitioning. Resolve identity via kernel HTTP, never a client-supplied owner cookie or UID. Web and native clients of the same service share account/BV playback ranges. Honor optimistic revisions and account-context guards. The service currently has one active Bilibili login; do not claim independent per-device multi-user authentication. Preserve legacy metadata with a one-time migration and do not reassign it on subsequent account switches.

Playback ranges are metadata, not destructive audio cuts. Keep original audio in the kernel. Apply the saved start before playback and pause at an explicit end without automatic queue advance. Reopening a track must read current server settings; account changes stop the old player and separate device-local queues. Follow-UP and range controls must remain visible in the player, including mobile widths.

## Search Rules

Do not calculate, persist, or expose music scores, preference weights, or score breakdowns. Online search groups followed UP creators first within the returned page and preserves source order within groups. Local search applies the same priority before pagination, followed by stable recency order. Do not expand a single search into background creator searches. Never substitute local results for a failed online page. Return an explicit error, preserve the last successful page in the UI, and require an explicit user action to start a local search. Bind authenticated pagination to the login-session context.

Playlists are owner-scoped, ordered metadata collections, separate from favorites and playback queues. Store stable BV IDs and metadata snapshots so candidate-cache deletion does not destroy playlists. Do not automatically extract or download every playlist item.

Keep layers separated: API routes call lib services, search providers return normalized metadata, and UI components do not access SQLite directly.

Search pagination uses bounded, owner-scoped metadata snapshots. Reuse the returned searchId across page visits, retain the first recorded page for each BV, and never refill a short page by fetching another page. Freeze local matching membership before pagination. Unknown target pages are fetched only after user navigation; do not prefetch intermediate pages for jumps.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
