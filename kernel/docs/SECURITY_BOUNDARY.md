# Security Boundary

This kernel is for authorized CTF audio extraction only.

## Hard Boundaries

- Only process authorized CTF materials or videos the authenticated user can normally access.
- Do not implement CAPTCHA bypass.
- Do not implement DRM/EME bypass or decryption.
- Do not implement membership, region, or access-control bypass.
- Do not implement anti-bot evasion or stealth plugins.
- Do not steal, export, or exfiltrate credentials.
- Do not expose Cookie, localStorage, sessionStorage, QR login token internals, browser profile files, or sensitive headers.
- Do not log cookies, authorization headers, QR login tokens, full signed media URLs, or sensitive request headers.

## Profile And Login State

Browser login state stays inside kernel-owned profile storage. A future backend may store profile ownership metadata and sanitized login status, but raw browser profiles and session secrets must never be exported or leaked from the kernel.

The HTTP runtime's owner-only cookie handoff journal is also profile data, not
metadata or an audio artifact. It never leaves the kernel, is not served by any
route, and is removed by the same guarded logout as the browser profile. HTTP and
browser runtimes for one profile never own independent live cookie jars. Origin
storage remains in the persistent browser profile. Storage-state initialization
errors must not quote cookie values in API responses or logs.

QR login is allowed only as normal user-driven login inside the kernel-owned profile, including the first-party web QR endpoints through that profile's shared request context. The kernel may return a short-lived QR PNG image URL for the matching `external_owner_id` and `profile_id`; it must not return QR token internals, cookies, storage state, or browser profile files. Treat QR images as sensitive UI material and do not log them. User confirmation and independently verified Bilibili identity remain required; upstream restrictions must not be bypassed.

## Allowed Cookie Import

Allowed:

- Import user-provided Bilibili cookies into a kernel-owned browser profile.
- Import user-provided browser Cookie header text into a kernel-owned browser profile.
- Import user-provided Playwright `storage_state.json` into a kernel-owned browser profile.
- Use imported cookies only inside the specified `profile_id`.
- Use the profile to access videos the user can normally access.
- Use the profile for authorized CTF challenge videos.
- Verify login status after import with sanitized identity info such as `bili_uid` and `nickname`.
- Delete or discard the raw imported cookie payload after successful import.
- Store browser session state only inside kernel profile storage.

Forbidden:

- Do not return cookies from any API.
- Do not expose localStorage, sessionStorage, storage state, browser profile files, or sensitive headers from any API.
- Do not log cookies.
- Do not log full signed media URLs.
- Do not store cookies in backend-facing metadata.
- Do not implement account pooling.
- Do not implement cookie sharing between users.
- Do not use cookies to bypass membership, region, CAPTCHA, DRM/EME, or access controls.
- Do not implement cookie theft or cookie extraction from other users.
- Do not hardcode real cookies in code, tests, README, docs, examples, or command-line arguments.

## API Response Rules

API responses may include:

- `profile_id`
- `external_owner_id`
- sanitized login status
- `bili_uid`
- `nickname`
- job status
- sanitized errors
- strategy attempts
- artifact metadata
- artifact checksums

API responses must never include:

- cookies
- localStorage
- sessionStorage
- storage state
- browser profile paths
- QR token internals
- sensitive headers
- full signed media URLs

## Logs

All debug info and errors must pass through sanitization before being persisted or returned.
