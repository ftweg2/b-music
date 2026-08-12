# B-Music

[![CI](https://github.com/ftweg2/b-music/actions/workflows/ci.yml/badge.svg)](https://github.com/ftweg2/b-music/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/release-1.0.0-7c3aed.svg)](CHANGELOG.md)

B-Music is a local-first Bilibili music discovery app with a separate, Dockerized audio kernel. It helps a trusted local user search and rank music-like videos, keep a metadata-only library, and prepare original audio from authorized CTF material or videos the user can normally access.

B-Music 是一个本地优先的 Bilibili 音乐发现项目。Web App 负责搜索、排序、收藏和播放体验；Docker 内核负责登录态与授权音频处理，二者通过 HTTP API 隔离。

## Highlights

- Chinese Next.js interface for search, followed creators, favorites, queues, and streaming playback.
- Explicit ranking with text relevance, creator preference, music likelihood, recency, and interaction signals.
- Metadata-only App storage: no audio/video files, cookies, browser profiles, or signed media URLs.
- Dockerized FastAPI kernel with `api_dash`, `browser_network`, and `mse_sourcebuffer` strategies.
- Kernel-owned Bilibili login state with QR login and user-supplied cookie/storage-state import.
- Raw artifact preservation, SHA-256 checksums, strategy reports, and sanitized errors.
- Bounded, user-triggered search and sequential extraction strategies.

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
- [Changelog](CHANGELOG.md)

The tools under `tests/` are external acceptance clients. They communicate with the kernel over HTTP and do not access kernel internals.

## License

Licensed under the [Apache License 2.0](LICENSE).
