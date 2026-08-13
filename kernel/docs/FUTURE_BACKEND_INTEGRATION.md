# Future Backend Integration

A future backend can call this kernel through its HTTP API. The backend should remain an orchestrator and should not implement Bilibili extraction logic.

## Backend May Store

- `external_owner_id`
- `profile_id`
- `bili_uid`
- `nickname`
- login status
- job metadata
- artifact metadata
- artifact checksums
- sanitized strategy reports

## Backend Must Never Store Or Request

- cookies
- localStorage
- sessionStorage
- storage state
- browser profile files
- browser profile paths usable for session theft
- QR login token internals
- sensitive request headers
- full signed media URLs

## Recommended Flow

1. Backend calls `POST /v1/profiles` with its own external owner id.
2. Backend calls `POST /v1/profiles/{profile_id}/login/start` with `external_owner_id`.
3. Backend displays `qr_image_url` from the kernel to that same owner only.
4. Backend polls `GET /v1/profiles/{profile_id}/login/status?external_owner_id=...` and stores only sanitized identity/status.
5. Backend submits jobs with `POST /v1/jobs`.
6. Backend polls `GET /v1/jobs/{job_id}?external_owner_id=...` using the same owner id.
7. Backend lists and downloads artifacts through the kernel API.

The backend may pass user-provided cookies, browser Cookie header text, or Playwright storage state to the kernel import API when the local user owns the account or is using an authorized CTF account. The backend must not store that raw payload, log it, share it across users, or request it back from the kernel.

The kernel remains the only component holding browser profiles and login state.

## QR Login Boundary

The QR screenshot is transmitted as an image artifact only. The backend must not request QR token internals, cookies, storage state, or browser profile files. Treat the QR screenshot as short-lived sensitive UI material and show it only to the user/team that owns `external_owner_id`.

For multi-user deployments, use one stable `external_owner_id` per backend user/team. The kernel maps each owner to its own `profile_id`, stores browser files under that profile directory, verifies ownership on login/job/cookie import APIs, and locks a profile during login, cookie import, or extraction jobs.
