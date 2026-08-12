# Changelog

All notable changes to B-Music are documented here. The project follows [Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/ftweg2/b-music/releases/tag/v1.0.0
