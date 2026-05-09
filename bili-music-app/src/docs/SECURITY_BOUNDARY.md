# Security Boundary

This app is metadata-only for stored data. Playback is allowed only as a stream proxy from the external kernel to the browser.

Forbidden:

- Audio extraction.
- Video/audio download or storage in App storage.
- Cookie storage.
- Browser login state storage.
- Playwright or browser automation.
- WBI signing or signed media URL extraction.
- CAPTCHA bypass.
- DRM/EME bypass.
- Anti-bot evasion.
- Region, membership, or access-control bypass.
- Account pools.
- Infinite crawling or batch scraping.
- Persisting full artifact response bodies.
- Storing signed kernel artifact URLs.

Allowed:

- User-triggered Bilibili metadata search.
- Conservative remote search provider calls with timeout and result limits.
- Local SQLite storage of sanitized candidate metadata.
- Local SQLite storage of Track metadata: kernel job id, artifact name, size, checksum, mime type, duration, status, and expiration.
- Manual preferred UP creator configuration.
- Kernel integration through HTTP APIs only.
- Streaming kernel artifacts through `/api/tracks/[id]/stream` with Range header passthrough.
