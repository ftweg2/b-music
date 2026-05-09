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

```http
POST /v1/profiles/{profile_id}/login/start
GET /v1/profiles/{profile_id}/login/status
```

Login start opens the normal Bilibili login page inside the kernel-owned profile and returns a QR screenshot URL. It must not return cookies, QR token internals, storage state, localStorage, sessionStorage, browser profile paths, or sensitive headers.

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
  "message": "Scan the QR image from the kernel profile login page...",
  "qr_image_url": "/v1/profiles/p_xxx/login/ls_xxx/qr.png?external_owner_id=user_or_team_123",
  "qr_image_sha256": "abc123...",
  "expires_in_seconds": 180
}
```

The QR image is a screenshot artifact from the profile-owned login page. Treat it as sensitive UI material: display it only to the profile owner and do not log it. The kernel keeps the browser context open while the QR login is pending, polls sanitized identity via normal Bilibili identity checks, then stores only `bili_uid`, `nickname`, login status, and verification time.

```http
GET /v1/profiles/{profile_id}/login/{login_session_id}/qr.png?external_owner_id=user_or_team_123
```

Returns only the QR screenshot PNG for that owner/profile/session. It does not return QR token internals.

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
GET /v1/jobs/{job_id}
POST /v1/jobs/{job_id}/cancel
GET /v1/jobs/{job_id}/artifacts
GET /v1/jobs/{job_id}/artifacts/{name}
```

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
