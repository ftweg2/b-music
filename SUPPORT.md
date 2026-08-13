# Support

## Supported use

B-Music supports the latest release on a local machine for one trusted operator. The supported setup is Docker Compose v2 for the kernel, Node.js 22 or later for the App, and an up-to-date Chromium-based browser.

Use the project only for authorized CTF material or videos your authenticated account can normally access. CAPTCHA, DRM/EME, membership, region, anti-bot, and access-control bypasses are outside the project scope and will not be supported.

## Before opening an issue

1. Reproduce the problem on the latest release.
2. Check kernel health at `http://127.0.0.1:8000/health` and App health at `http://127.0.0.1:3000/api/health`.
3. Run the checks documented in [README.md](README.md#verification).
4. Search existing issues for the same symptom.
5. Reduce the report to synthetic, non-sensitive reproduction steps.

For reproducible bugs, open a [bug report](https://github.com/ftweg2/b-music/issues/new?template=bug_report.yml). For scoped improvements, use the [feature request](https://github.com/ftweg2/b-music/issues/new?template=feature_request.yml). Support is best-effort and no response-time or compatibility SLA is provided.

Never post cookies, credentials, authorization headers, QR token internals, Playwright storage state, browser profiles, full signed media URLs, local databases, extracted media, or unredacted logs. Report security issues through [SECURITY.md](SECURITY.md), not a public issue.
