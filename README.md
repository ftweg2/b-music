# bili-ctf-audio-kernel

Workspace for the current Bilibili music MVP experiments.

Current folders:

- `kernel/`: Dockerized extraction kernel for authorized Bilibili CTF/user-owned videos.
- `bili-music-app/`: Next.js App layer for search, favorites, followed UP creators, Track metadata, and playback stream proxy.
- `tests/`: external acceptance tools for the kernel.

The App and kernel have different security boundaries. The App must not store Cookie, browser state, signed media URLs, or audio/video files. The kernel owns Bilibili login state and extraction artifacts.

## App Docs

- `bili-music-app/src/docs/API_USAGE.md`: Web/Android API calls and operational notes.
- `bili-music-app/src/docs/CLOUD_DEPLOYMENT.md`: App + kernel cloud deployment guide.
- `bili-music-app/src/docs/OPERATIONS_CHECKLIST.md`: quality and follow-up checklist.

## Kernel Notes

The extraction kernel runtime service lives in `kernel/`. It is still separate from the App layer and must not grow a backend, frontend product, user system, or platform layer inside `kernel/`.

## Layout

- `kernel/`: Dockerized FastAPI extraction kernel, docs, tests, local storage placeholder.
- `tests/webui/`: manual acceptance WebUI that calls the kernel HTTP API with `fetch`.
- `tests/api_smoke/`: small API client scripts for smoke testing.

The WebUI and smoke scripts are external test tools. They must not import kernel internals, read SQLite, read `kernel/storage`, or access browser profile files.

## Run Kernel

```bash
cd kernel
cp .env.example .env
docker compose up --build
```

Default base URL: `http://localhost:8000`

Health:

```bash
curl http://localhost:8000/health
```

The Docker image defaults Playwright to the `chrome` channel for media codec compatibility. `mse_sourcebuffer` depends on normal browser MSE playback, and Bilibili DASH audio commonly uses AAC/MP4 codecs that bundled open-source Chromium may not advertise. Tune `MSE_CAPTURE_MS` and `MSE_PLAYBACK_RATE` if you force MSE on longer videos.

## Run Manual WebUI

```bash
cd tests/webui
python -m http.server 9000
```

Open `http://localhost:9000`.

The WebUI is only a manual API acceptance tool. It is not a backend or product frontend.

## Security Summary

Allowed:

- User voluntarily imports their own Bilibili Cookie or authorized CTF account Cookie into their own `profile_id`.
- Kernel uses that profile for authorized CTF videos or videos the user can normally access.
- Kernel verifies sanitized login identity such as `bili_uid`, `nickname`, and login status.

Forbidden:

- Cookie export or leakage.
- Any API returning Cookie, storage state, localStorage, sessionStorage, browser profile files, or sensitive headers.
- Logging Cookie values or full signed media URLs.
- Cross-user Cookie reuse, account pooling, CAPTCHA bypass, DRM/EME bypass, membership/region/access-control bypass.
- Hardcoding real Cookies in code, tests, README, examples, or command-line arguments.

See `kernel/docs/SECURITY_BOUNDARY.md` and `kernel/docs/COOKIE_IMPORT.md`.
