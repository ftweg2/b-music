# Kernel Integration

The extraction kernel is a separate service. This app communicates with it only through HTTP APIs.

Implemented integration:

- Search can call the kernel metadata search endpoint when the user selects `内核登录态搜索`.
- Playback preparation creates or reuses a metadata-only `Track`.
- `POST /api/tracks/prepare` submits a kernel job with `outputs: ["m4a"]`.
- `GET /api/tracks/[id]` polls kernel job status and stores sanitized artifact metadata after success.
- `GET /api/tracks/[id]/stream` proxies the kernel artifact stream and forwards `Range` requests.

Playback latency policy:

- The UI defaults to forced `api_dash` for first-click playback because it is the lightest kernel path and avoids launching Chromium on small VPS instances.
- Users can still choose the slower authenticated/browser fallback from the player kernel settings when `api_dash` is not enough.
- The App can enqueue a candidate for explicit background prewarm, but it still stores only Track metadata and never copies the audio artifact into App storage.

The app may store:

- `candidateId`
- Bilibili metadata already stored on `CandidateVideo`
- kernel `job_id`
- artifact name
- artifact size
- artifact mime type
- artifact sha256
- duration and expiration metadata
- Track status and sanitized failure reason

The app must not store:

- cookies
- browser profile files
- storage state
- signed media URLs
- audio/video files
- full artifact response bodies

The kernel remains the only component that owns browser profiles, login state, extraction strategies, and artifact files.
