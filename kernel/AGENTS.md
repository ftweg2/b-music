# Kernel Instructions

`kernel/` is the only runtime service for this repository. It contains the Dockerized FastAPI extraction kernel, its internal HTTP API, docs, tests, tools, and local storage placeholder.

Do not create a backend service here. Do not create a frontend product, user system, account system, or full platform. `tests/webui/` is only an external manual acceptance tool that calls the kernel HTTP API.

## Purpose

This kernel processes authorized Bilibili CTF challenge videos and user-owned accessible Bilibili videos. It extracts original audio as faithfully as possible for CTF audio analysis.

This is not a general-purpose downloader, scraping farm, anti-bot bypass tool, DRM bypass tool, or account automation system.

## Cookie Boundary

Allowed:

- User-provided Bilibili Cookie import for the local user's own account or authorized CTF account.
- User-provided Playwright `storage_state.json` import for the local user's own account or authorized CTF account.
- Import into the specified kernel-owned `profile_id` only.
- Use imported session state only for authorized CTF videos or videos the user can normally access.
- Verify login status with sanitized identity such as `bili_uid`, `nickname`, and `last_verified_at`.
- Discard the raw imported Cookie payload after import.
- Store browser session state only inside kernel profile storage.
- QR login may expose only a screenshot image for the matching `external_owner_id` and `profile_id`; QR token internals must not be returned or logged.

Forbidden:

- Cookie export.
- Any API returning Cookie, localStorage, sessionStorage, storage state, browser profile files, QR token internals, or sensitive headers.
- Logging Cookie values, authorization headers, QR login tokens, full signed media URLs, or sensitive request headers.
- Storing Cookies in backend-facing metadata.
- Cross-user Cookie reuse, account pooling, Cookie sharing, Cookie theft, or Cookie extraction from other users.
- CAPTCHA bypass, DRM/EME bypass, membership bypass, region bypass, anti-bot evasion, or access-control bypass.
- Hardcoding real Cookies in code, tests, README, examples, docs, or command-line arguments.

## Strategy Rules

The kernel implements these strategies behind a common interface:

- `api_dash`
- `browser_network`
- `mse_sourcebuffer`

Jobs support `auto` and `force` strategy modes. The MVP runs strategies sequentially and must not parallelize them.

## Artifact Rules

- Preserve raw audio artifacts.
- Do not default to MP3.
- Every artifact must include `sha256`.
- Write `artifact_manifest.json`, `metadata.json`, and `strategy_report.json`.
- All API errors, logs, and reports must be sanitized.
