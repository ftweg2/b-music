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
- `PreferredCreator` is a manually configured UP creator. Ranking should strongly boost matching creators.
- `FavoriteVideo` is a local App library record pointing at a `CandidateVideo`; it is not a Bilibili favorite.

## App And Kernel Separation

- Kernel integration must be via HTTP APIs only.
- Playback preparation may call the kernel to create extraction jobs with explicit user action.
- `/api/tracks/[id]/stream` may proxy kernel artifact streams and forward Range headers, but must not buffer full audio files or write them to disk.
- Store only track metadata such as kernel job id, artifact name, size, checksum, mime type, duration, status, and expiration.

## Ranking Rules

Ranking must be explicit and return a score breakdown including text match, preferred creator boost, music likelihood, recency, interaction, penalty, and final score.

All code should keep layers separated: API routes call lib services, search providers return normalized metadata, ranking is pure where practical, and UI components do not access SQLite directly.
