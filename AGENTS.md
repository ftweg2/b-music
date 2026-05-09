# bili-ctf-audio-kernel Project Instructions

## Project Identity

`bili-ctf-audio-kernel` is a kernel-only repository. The only runtime service lives under `kernel/`.

No backend service, frontend product, user system, or full platform should be implemented in this repository. A backend may be built later by another project.

`tests/webui/` is only an external manual acceptance tool. It must call the kernel HTTP API and must not import kernel internals, read SQLite, read `kernel/storage`, or access browser profile files.

This kernel processes authorized Bilibili CTF challenge videos and user-owned accessible Bilibili videos. It extracts original audio as faithfully as possible for CTF audio analysis.

This is not a general-purpose downloader, scraping farm, anti-bot bypass tool, DRM bypass tool, or account automation system.

## Hard Security Boundaries

- Only process authorized CTF materials or videos the authenticated user can normally access.
- Do not implement CAPTCHA bypass, DRM/EME bypass, membership bypass, region bypass, anti-bot evasion, credential theft, cookie export, or cookie exfiltration.
- Do not create any API that returns Cookie, localStorage, sessionStorage, QR login tokens, browser profile files, or sensitive headers.
- Browser login state must stay inside kernel-owned profile storage.
- QR login may return only a short-lived screenshot image for the matching owner/profile; QR token internals must never be returned or logged.
- User-provided Bilibili cookie import is allowed for authorized CTF accounts and user-owned accounts.
- User-provided Playwright `storage_state.json` import is allowed for authorized CTF accounts and user-owned accounts.
- Imported cookies and storage state may be used only inside the specified `profile_id`.
- Raw imported cookie payloads must be deleted or discarded after import.
- Cookie, storage state, and browser profile data must never be exported or leaked from the kernel.
- The future backend may store profile ownership metadata, but this kernel must not expose raw session secrets.
- No cookie export endpoint is allowed.
- Do not log cookies, authorization headers, QR login tokens, full signed media URLs, or sensitive request headers.
- Do not implement account pooling, cookie sharing between users, cookie theft, or cookie extraction from other users.
- Do not use cookies to bypass membership, region, CAPTCHA, DRM/EME, or access controls.
- Do not hardcode real cookies in code, tests, README, docs, examples, or command-line arguments.

## Extraction Strategies

The kernel implements three strategies behind a common interface:

- `api_dash`: fast public/API DASH audio extraction.
- `browser_network`: authenticated Playwright network capture fallback.
- `mse_sourcebuffer`: last-resort job-scoped MSE SourceBuffer segment capture scaffold.

Jobs support:

- `auto` strategy mode, using the requested strategy order when provided, default order, historical metrics, recent failure reasons, average duration, login state, and context hints.
- `force` strategy mode, running only the specified strategy with no fallback.

The MVP must not parallelize strategies.

## Artifact And Logging Rules

- Preserve raw audio artifacts.
- Do not default to MP3.
- Every artifact must include `sha256`.
- Write `artifact_manifest.json`, `metadata.json`, and `strategy_report.json` for each job.
- All logs, API errors, strategy reports, and debug info must be sanitized.
- Do not log full signed media URLs, cookies, authorization headers, QR login tokens, or sensitive request headers.
