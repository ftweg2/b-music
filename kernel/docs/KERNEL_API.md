# Kernel API

Base URL: `http://localhost:8000`

No API may return Cookie, localStorage, sessionStorage, storage state, browser profile data, QR login token internals, or sensitive headers. User-provided cookie import is allowed for authorized CTF accounts and user-owned accounts; cookie export is forbidden.

## Health

```http
GET /healthz
GET /health
```

## Profiles

```http
POST /v1/profiles
```

Request:

```json
{
  "external_owner_id": "user_or_team_123"
}
```

Response:

```json
{
  "profile_id": "p_xxx",
  "external_owner_id": "user_or_team_123",
  "status": "created"
}
```

The optional boolean request field `include_login_status: true` adds `login` to
this response, using the same fields (including null identity fields) as the
login-status endpoint. Profile ownership and status are resolved from one fresh
database row. Requests without this field retain the original response shape.
The App uses this combined read and falls back to the old two-request flow when
an older kernel omits `login`; identity is never cached across incoming requests.

```http
POST /v1/profiles/{profile_id}/login/start
GET /v1/profiles/{profile_id}/login/status?external_owner_id=user_or_team_123
```

Login start uses the normal first-party Bilibili web QR endpoints inside the kernel-owned profile's request context and returns a QR PNG URL. It does not load or screenshot the full login page. It must not return cookies, QR token internals, storage state, localStorage, sessionStorage, browser profile paths, or sensitive headers.

HTTP-only login/search now use an isolated Playwright request runtime without
launching Chrome. When an extraction already owns the browser, HTTP readers use
that browser's request context instead. One kernel profile has only one active
cookie jar; transitions drain existing readers. A private owner-only journal in
the profile directory supports cookie persistence and crash recovery, and is
never an API artifact. Existing Chromium profiles bootstrap once; localStorage
and other browser-origin data remain in the existing browser profile.

Request:

```json
{
  "external_owner_id": "user_or_team_123"
}
```

Response:

```json
{
  "login_session_id": "ls_xxx",
  "status": "pending",
  "message": "Scan the Bilibili QR image and confirm on your phone...",
  "qr_image_url": "/v1/profiles/p_xxx/login/ls_xxx/qr.png?external_owner_id=user_or_team_123",
  "qr_image_sha256": "abc123...",
  "expires_in_seconds": 180
}
```

The QR image is a PNG encoded from Bilibili's first-party challenge. Treat it as sensitive UI material: display it only to the profile owner and do not log it. The kernel keeps the profile context open while QR login is pending, polls the same challenge without replacing the PNG, and separately verifies identity before recording `bili_uid`, `nickname`, login status, and verification time. Cookies remain solely in that kernel browser profile. Concurrent starts reuse one preparation; the returned lifetime begins at readiness and is at most 180 seconds. Preparation/upstream timeouts return 504 with a stable `X-Error-Code` and `Retry-After`; temporary connection failures return 502/503. Restrictions are not bypassed. See [reliability and failure handling](LOGIN_RELIABILITY.md).

```http
GET /v1/profiles/{profile_id}/login/{login_session_id}/qr.png?external_owner_id=user_or_team_123
```

Returns only the QR PNG for that owner/profile/session. It does not return QR token internals.

```http
GET /v1/profiles/{profile_id}/login/status?external_owner_id=user_or_team_123
```

The `external_owner_id` query is recommended for backend integration so the kernel can verify profile ownership before returning sanitized login status.

```http
POST /v1/profiles/{profile_id}/cookies/import
```

Purpose: import user-provided cookies into the specified kernel profile.

Request:

```json
{
  "external_owner_id": "user_or_team_123",
  "format": "cookie_header",
  "cookies": "... or object ...",
  "source_note": "manually provided by account owner"
}
```

Supported formats: `cookie_header`, `netscape`, `json`, `playwright_storage_state`.

Response:

```json
{
  "profile_id": "p_xxx",
  "status": "imported",
  "logged_in": true,
  "bili_uid": "123456",
  "nickname": "example",
  "last_verified_at": "2026-05-06T12:00:00+00:00",
  "message": "cookies imported into kernel profile; raw payload discarded"
}
```

Security requirements:

- Validate `external_owner_id` owns `profile_id`.
- Do not persist the raw import request body outside the browser profile.
- Do not log the raw request body.
- Do not return cookies.
- Redact cookie values in all errors.
- Lock profile during import.
- Verify login status after import.
- Store only sanitized login metadata.

## Jobs

```http
POST /v1/jobs
```

Auto mode:

```json
{
  "job_id": "j_001",
  "external_owner_id": "user_or_team_123",
  "profile_id": "p_xxx",
  "url": "https://www.bilibili.com/video/BV...",
  "strategy_mode": "auto",
  "strategy_order": ["api_dash", "browser_network", "mse_sourcebuffer"],
  "outputs": ["raw", "m4a", "wav"]
}
```

Force mode:

```json
{
  "job_id": "j_002",
  "external_owner_id": "user_or_team_123",
  "profile_id": "p_xxx",
  "url": "https://www.bilibili.com/video/BV...",
  "strategy_mode": "force",
  "strategy": "browser_network",
  "outputs": ["raw", "m4a", "wav"]
}
```

```http
GET /v1/jobs/{job_id}?external_owner_id=user_or_team_123
POST /v1/jobs/{job_id}/cancel
GET /v1/jobs/{job_id}/artifacts?external_owner_id=user_or_team_123
GET /v1/jobs/{job_id}/artifacts/{name}?external_owner_id=user_or_team_123
HEAD /v1/jobs/{job_id}/artifacts/{name}?external_owner_id=user_or_team_123
```

Cancellation requires a JSON body containing the owner:

```json
{"external_owner_id": "user_or_team_123"}
```

All job status, cancellation, artifact listing, and artifact download requests verify
`external_owner_id` against the immutable job owner recorded at submission.

Artifact downloads support byte ranges, including `206` and `416`. `HEAD` returns the same metadata without a body. Successful responses include `Accept-Ranges`, `Content-Length`, `X-Content-SHA256`, `X-File-Size`, and a strong SHA-256-based `ETag`; clients may resume with `Range` and `If-Range`.

## Metadata Search

```http
POST /v1/search/videos
```

Purpose: perform a user-triggered Bilibili video metadata search through a kernel-owned `profile_id`. The kernel may use the profile's normal browser login state internally, but it returns only sanitized metadata. It must never return cookies, browser storage, sensitive headers, browser profile files, or signed media URLs.

Request:

```json
{
  "external_owner_id": "user_or_team_123",
  "profile_id": "p_xxx",
  "keyword": "夜航星",
  "limit": 20
}
```

Response:

```json
{
  "provider": "kernel_bilibili",
  "profile_id": "p_xxx",
  "logged_in": true,
  "results": [
    {
      "bvid": "BV...",
      "aid": "123",
      "title": "example",
      "creator_mid": "123456",
      "creator_name": "UP",
      "cover_url": "https://i0.hdslb.com/...",
      "duration_seconds": 260,
      "pub_time": "2026-05-08T00:00:00+00:00",
      "source_url": "https://www.bilibili.com/video/BV...",
      "category": "音乐",
      "tags": []
    }
  ]
}
```

Security requirements:

- Validate `external_owner_id` owns `profile_id`.
- Lock the profile during the search request.
- Apply a conservative per-profile rate limit.
- Return metadata only.
- Do not expose Cookie, storage state, browser profile files, sensitive headers, or full signed media URLs.
- Do not use this endpoint for crawling, account pooling, or access-control bypass.

## Video Resolve

```http
POST /v1/videos/resolve
```

Purpose: resolve a single Bilibili BV id into sanitized video metadata. This is useful when an App receives a direct BV id or video URL and wants metadata without exposing browser profile state.

Request:

```json
{
  "external_owner_id": "user_or_team_123",
  "profile_id": "p_xxx",
  "bvid": "BV1xx411c7mD"
}
```

Response:

```json
{
  "provider": "kernel_bilibili",
  "profile_id": "p_xxx",
  "logged_in": true,
  "bvid": "BV1xx411c7mD",
  "aid": "123",
  "title": "example",
  "description": "example",
  "creator_mid": "123456",
  "creator_name": "UP",
  "cover_url": "https://i0.hdslb.com/...",
  "duration_seconds": 260,
  "pub_time": "2026-05-08T00:00:00+00:00",
  "source_url": "https://www.bilibili.com/video/BV1xx411c7mD",
  "category": "音乐",
  "tags": [],
  "pages": [
    {
      "cid": 123,
      "page": 1,
      "part": "P1"
    }
  ]
}
```

Security requirements are the same as metadata search: validate profile ownership, return metadata only, and never return cookies, browser storage, sensitive headers, browser profile files, or signed media URLs.

## Diagnostics

```http
GET /v1/diagnostics
POST /v1/diagnostics/cleanup/artifacts
```

`GET /v1/diagnostics` returns sanitized runtime/storage health such as job state counts, active profile locks, nonterminal jobs, orphan artifact rows, artifact file count, artifact bytes, and artifact retention hours.

`POST /v1/diagnostics/cleanup/artifacts` runs artifact retention cleanup immediately.

Diagnostics require `X-Kernel-Operator-Token` matching `KERNEL_OPERATOR_TOKEN`.
When the token is unset, these endpoints return `503` and remain disabled.

Job states:

- `queued`
- `validating_profile`
- `preparing_context`
- `running_api_dash`
- `running_browser_network`
- `running_mse_sourcebuffer`
- `processing_media`
- `succeeded`
- `failed`
- `cancelled`

## Strategies

```http
GET /v1/strategies
GET /v1/strategies/metrics
```
