# Changelog

All notable changes to B-Music are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Douyin support for one user-supplied link at a time. Paste a Douyin share text or link into search to get a candidate, then play, download, favorite or add it to playlists like a Bilibili video.
- Kernel `douyin_music` strategy. It keeps the item's background-music file unchanged, and falls back to copying the audio stream out of the item's video.
- Kernel `POST /v1/douyin/resolve` for public item metadata, and `source_orders` in `GET /v1/strategies`.
- `DOUYIN_DETAIL_TIMEOUT_SECONDS`, `DOUYIN_DOWNLOAD_CONCURRENCY` and `DOUYIN_MAX_DOWNLOAD_BYTES` kernel settings.
- Douyin lookup hardening: Chromium sandbox where available, `*.douyin.com`-only page loads, blocked analytics beacons, bounded waiting lookups (`DOUYIN_BUSY`), and a media size cap (`MEDIA_TOO_LARGE`).
- `download_audio` accepts explicit `concurrency`, `min_parallel_bytes` and `max_bytes`; Bilibili downloads are unchanged.
- `DOUYIN_MAX_BROWSERS` (default 1). Douyin lookup browsers use lean launch flags, fail fast on crash, and downloaded Douyin media is checked for a real container signature.
- Small-machine stability for Bilibili: API DASH falls back to `backupUrl` CDN nodes with one retry pass, WBI keys are cached for ten minutes, `browser_network` stops capturing once the playurl audio list is parsed, extraction pages skip image-CDN assets and fonts, and profile browsers are muted.
- Hourly artifact cleanup while the kernel runs.
- Bilibili covers are requested at display size through the image CDN's `@{w}w_{h}h_1c.webp` suffix (cards 440×400, details 600×600, playlists 400×400, player 120×120) instead of full originals; a typical cover drops from 250–550 KB to 4–19 KB.
- Douyin covers: the kernel caches each item's cover when resolving (`has_cover`, `GET /v1/douyin/covers/{aweme_id}`), and the App shows it through `GET /api/covers/{bvid}` on cards, details, playlists and the player. Signed Douyin image URLs are never stored or returned.

### Changed (small machines)

- Douyin lookups count toward `MAX_ACTIVE_JOBS` together with jobs.
- Douyin defaults for a 0.5-core container: `DOUYIN_DETAIL_TIMEOUT_SECONDS` 45, `DOUYIN_DOWNLOAD_CONCURRENCY` 2; the App waits up to 90 seconds for a Douyin lookup.
- Shared-host overlay (`deploy/compose.antigravity-safe.yml`): no fixed CPU cap, only a low CPU weight (128), and a 256 MiB App. `deploy/priority-guard.py` moves the kernel's RAM ceiling between 320 and 768 MiB with host headroom, always leaving 300 MiB free. The kernel's page cache is not counted, because host available memory already includes it. It lowers the ceiling on a 32 MiB change and raises it only on a 96 MiB change. After a protective stop it restarts B-Music once Antigravity has been healthy with at least 450 MiB free for five minutes. Three automatic restarts within six hours latch the pause for the operator.

### Security

- Next.js 16.3.0 → 16.3.6 for the Image Optimization AVIF remote code execution advisory (GHSA-2xp9-vwfh-vxw4). The same release also fixes the Windows-hosted server advisory (GHSA-p293-qw3h-jr36). With it come sharp 0.35.4 (libheif, GHSA-rgj7-g3m4-5g8c) and baseline-browser-mapping 2.11.26 (GHSA-w5vr-8v7q-w6rv).

### Fixed

- Closing a Douyin lookup browser after an unavailable or timed-out answer no longer records a spurious browser crash.

### Changed

- The kernel routes each job by source. A strategy that does not belong to the URL's source is rejected before the job is created.
- Douyin jobs do not take the Bilibili profile's job lock.
- App video references (`bvid`) accept `DY<item id>` in addition to BV ids, across candidates, favorites, playlists, playback ranges and tracks.

## [1.2.0] - 2026-08-14

### Added

- Web and mobile offline download API with `GET`/`HEAD`, byte-range resume, safe attachment filenames, size, expiry, and SHA-256 metadata.
- Web download buttons and a `/downloads` task center; background downloads no longer interrupt playback.
- Mobile-oriented capability discovery, owner-scoped Track restore/listing, batch status polling, and candidate/favorite pagination.

### Changed

- Track API responses now include additive `media` links and `pollAfterMs` guidance while preserving existing fields.
- Transient kernel/network failures remain retryable instead of being recorded as permanent extraction failures.

### Fixed

- Separated App metadata ownership from immutable kernel job ownership so polling, streaming, and downloading work in multi-user mode.
- Recovered artifacts safely after moving a kernel data directory between Docker and host environments.

## [1.1.0] - 2026-08-13

### Added

- Audio-only media validation with `ffprobe` for API and authenticated browser captures.
- Job cancellation during downloads, browser capture, MSE capture, and media processing.
- Owner-scoped authorization tests for jobs, artifacts, profiles, QR images, and diagnostics.
- Bounded MSE segment count, per-segment size, and total-capture size limits.
- Automated npm/Python dependency auditing, container health smoke testing, and tag-driven GitHub Release automation.
- Public support, conduct, and maintainer guidance for contributors.
- Patched FastAPI/Starlette and pytest dependencies verified by automated vulnerability auditing.

### Changed

- Streamed media downloads to atomic temporary files with response-size and partial-content validation.
- Hardened profile import, login-session recovery, artifact cleanup, runtime shutdown, and sanitized diagnostics.
- Made requested output generation and artifact existence part of the job success contract.
- Improved App-to-kernel streaming error propagation and owner binding.

### Fixed

- Prevented `browser_network` from selecting AV1/video tracks as audio candidates.
- Prevented jobs from reporting success when a requested `audio.m4a` or WAV artifact was absent.
- Fixed an awaited `video.play()` promise that could leave forced MSE capture hanging indefinitely.
- Preserved true MSE provenance: forced `mse_sourcebuffer` jobs now report the captured SourceBuffer segments and cannot silently fall through to another strategy.
- Made artifact writes, range downloads, cancellation, startup recovery, and profile locking resilient to partial or concurrent failure.

## [1.0.0] - 2026-08-12

### Added

- Local-first Bilibili music discovery UI with search, ranking, followed creators, favorites, and playback queue controls.
- Metadata-only Track lifecycle and Range-aware kernel artifact streaming.
- Dockerized FastAPI extraction kernel with three sequential strategies.
- Kernel-owned QR login and user-supplied cookie/storage-state import boundaries.
- Artifact manifests, metadata, strategy reports, SHA-256 checksums, diagnostics, and retention cleanup.
- Owner-scoped App favorites, interactions, and Tracks with legacy SQLite migration.
- Automated App, kernel, type, build, and Compose checks.

### Changed

- Updated Next.js and transitive production dependencies.
- Added bounded kernel request timeouts, App search rate limiting, SQLite busy waiting, and atomic Track preparation claims.
- Made the kernel Compose port bind to loopback by default and made local `.env` overrides optional.

### Fixed

- Prevented concurrent profile creation from returning intermittent HTTP 500 errors.
- Prevented rejected kernel jobs from leaking artifact directories or profile locks.
- Preserved favorites across candidate cache replacement and isolated Track access by App owner.
- Cleared stale App owner cookies when kernel login is no longer active.

[Unreleased]: https://github.com/ftweg2/b-music/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/ftweg2/b-music/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/ftweg2/b-music/releases/tag/v1.1.0
[1.0.0]: https://github.com/ftweg2/b-music/releases/tag/v1.0.0
