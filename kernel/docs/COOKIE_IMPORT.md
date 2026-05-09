# Cookie Import

Cookie import is allowed only when the local user voluntarily provides their own Bilibili Cookie or an authorized CTF account Cookie.

The import target is always one kernel-owned `profile_id`. Imported session state is used only inside that profile.

## Supported Formats

- `cookie_header`: browser header text such as `name=value; other=value`.
- `netscape`: Netscape cookie file format.
- `json`: JSON object or list of cookie objects.
- `playwright_storage_state`: Playwright `storage_state.json`.

## API

```http
POST /v1/profiles/{profile_id}/cookies/import
```

Request:

```json
{
  "external_owner_id": "user_or_team_123",
  "format": "cookie_header",
  "cookies": "name=value; other=value",
  "source_note": "manually provided by account owner"
}
```

Response contains only sanitized identity:

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

## Local CLI

```bash
cd kernel
python -m app.tools.import_cookies \
  --profile-id p_xxx \
  --external-owner-id user_or_team_123 \
  --format cookie_header \
  --file /run/secrets/bilibili.cookies.txt
```

The CLI reads the file, imports into the profile, verifies login status, and prints only sanitized identity info.

## Forbidden

- Do not return Cookies from any API.
- Do not print Cookie values.
- Do not log Cookie values.
- Do not write real Cookies into code, tests, docs, examples, README, or command-line arguments.
- Do not share Cookies across users.
- Do not build account pools.
- Do not use Cookies to bypass CAPTCHA, DRM/EME, membership, region, or access controls.
