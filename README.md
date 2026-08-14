# B-Music

[![CI](https://github.com/ftweg2/b-music/actions/workflows/ci.yml/badge.svg)](https://github.com/ftweg2/b-music/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/release-1.2.0-7c3aed.svg)](https://github.com/ftweg2/b-music/releases/tag/v1.2.0)

B-Music is a local-first Bilibili music discovery app with a separate, Dockerized audio kernel. It helps a trusted local user search and rank music-like videos, keep a metadata-only library, and prepare original audio from authorized CTF material or videos the user can normally access.

B-Music 是一个本地优先的 Bilibili 音乐发现项目。Web App 负责搜索、排序、收藏、播放和客户端下载体验；Docker 内核负责登录态与授权音频处理，二者通过 HTTP API 隔离。

## Project status

`v1.2.0` is the current stable release. It is intended for a single trusted local operator, with the App and extraction kernel running as separate processes. The HTTP API, resumable device-owned downloads, artifact manifests, and three sequential extraction strategies are release-supported; this project is not an internet-facing multi-tenant service.

## Highlights

- Chinese Next.js interface for search, followed creators, favorites, queues, streaming playback, and device-owned offline downloads.
- Explicit ranking with text relevance, creator preference, music likelihood, recency, and interaction signals.
- Metadata-only App storage: no App-side audio/video copies, cookies, browser profiles, or signed media URLs; downloads stream directly to the client device.
- Dockerized FastAPI kernel with `api_dash`, `browser_network`, and `mse_sourcebuffer` strategies.
- Kernel-owned Bilibili login state with QR login and user-supplied cookie/storage-state import.
- Raw artifact preservation, SHA-256 checksums, strategy reports, and sanitized errors.
- Bounded, user-triggered search and sequential extraction strategies.

The project is useful as a constrained, auditable reference for CTF audio forensics: it keeps browser credentials inside a dedicated kernel boundary, preserves source audio instead of defaulting to lossy MP3, and records how each artifact was produced.

## Architecture

```text
Browser
   │
   ▼
Next.js App (:3000) ── metadata ──► SQLite
   │
   │ HTTP API only
   ▼
FastAPI Kernel (:8000, Docker) ───► profiles + artifacts
```

The App and kernel intentionally have different trust boundaries. The App never reads kernel SQLite, profile files, or artifact storage directly.

## Requirements

- Docker Engine with Docker Compose v2
- Node.js 22 or later
- npm 10 or later

Python 3.12 is only required when running kernel tests outside Docker.

## Quick start

Start the kernel:

```bash
cd kernel
docker compose up --build -d
```

The safe default publishes the kernel on `127.0.0.1:8000`. Copy `kernel/.env.example` to `kernel/.env` only when you need to customize it.

Start the App in another terminal:

```bash
cd bili-music-app
cp .env.example .env
npm ci
npm run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Kernel health is available at [http://127.0.0.1:8000/health](http://127.0.0.1:8000/health), and its OpenAPI UI is at [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

## Configuration

The checked-in examples are safe local defaults:

- [`kernel/.env.example`](kernel/.env.example)
- [`bili-music-app/.env.example`](bili-music-app/.env.example)

Runtime `.env` files, SQLite databases, browser profiles, imported session state, and media artifacts are ignored by Git. The project is designed for one trusted local operator; it is not an internet-facing multi-tenant service.

## Verification

```bash
cd kernel
python -m pytest app/tests

cd ../bili-music-app
npm test
npm run typecheck
npm run build
```

Validate the container configuration without starting it:

```bash
docker compose -f kernel/docker-compose.yml config --quiet
```

Release `v1.2.0` was validated with 71 kernel tests plus 44 App tests, typecheck, and production-build suites. Strategy coverage is explicit:

| Strategy | Release validation |
| --- | --- |
| `api_dash` | Automated DASH download, bounded streaming, media-pipeline, manifest, and failure-path tests |
| `browser_network` | Forced authenticated end-to-end capture; video responses were rejected and the resulting AAC artifact was verified as audio-only |
| `mse_sourcebuffer` | Forced end-to-end `SourceBuffer.appendBuffer` capture; 51 audio segments were observed and assembled into a verified AAC artifact without strategy fallback |

The two browser validations used the same 247.64-second accessible test video on 2026-08-13. They demonstrate the release paths, not a promise that every remote video will remain accessible: upstream behavior, authorization, DRM, regional policy, and account state can still prevent extraction.

## Safety and authorized use

Use B-Music only for authorized CTF material or videos the authenticated user can normally access. The project does not implement CAPTCHA bypass, DRM/EME bypass, membership or region bypass, anti-bot evasion, account pooling, credential export, or cookie exfiltration.

See [SECURITY.md](SECURITY.md), [kernel security boundaries](kernel/docs/SECURITY_BOUNDARY.md), and [App security boundaries](bili-music-app/src/docs/SECURITY_BOUNDARY.md).

## Documentation

- [Kernel architecture](kernel/docs/ARCHITECTURE.md)
- [Kernel API](kernel/docs/KERNEL_API.md)
- [Strategy policy](kernel/docs/STRATEGY_POLICY.md)
- [Cookie import](kernel/docs/COOKIE_IMPORT.md)
- [App API usage](bili-music-app/src/docs/API_USAGE.md)
- [Deployment guide](bili-music-app/src/docs/CLOUD_DEPLOYMENT.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Maintainers and governance](MAINTAINERS.md)
- [Changelog](CHANGELOG.md)

The tools under `tests/` are external acceptance clients. They communicate with the kernel over HTTP and do not access kernel internals.

## License

Licensed under the [Apache License 2.0](LICENSE).
