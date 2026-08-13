# Changelog

All notable changes to B-Music are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-08-13

### Added

- Audio-only media validation with `ffprobe` for API and authenticated browser captures.
- Job cancellation during downloads, browser capture, MSE capture, and media processing.
- Owner-scoped authorization tests for jobs, artifacts, profiles, QR images, and diagnostics.
- Bounded MSE segment count, per-segment size, and total-capture size limits.
- Dependency review, container health smoke testing, and tag-driven GitHub Release automation.
- Public support, conduct, and maintainer guidance for contributors.

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

[1.1.0]: https://github.com/ftweg2/b-music/releases/tag/v1.1.0
[1.0.0]: https://github.com/ftweg2/b-music/releases/tag/v1.0.0
