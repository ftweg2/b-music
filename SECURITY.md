# Security Policy

## Supported version

Security fixes are applied to the latest release on the `main` branch.

## Reporting a vulnerability

Do not open a public issue for a vulnerability or include credentials, cookies, storage state, signed URLs, profile data, or extracted media in a report.

Use [GitHub private vulnerability reporting](https://github.com/ftweg2/b-music/security/advisories/new). Include a concise impact description, affected component, reproduction steps using synthetic data, and any suggested mitigation. Reports are reviewed as availability permits; a response will normally acknowledge receipt within seven days.

## Scope

High-priority areas include:

- Cookie, storage-state, QR token, or browser-profile disclosure.
- Cross-profile or cross-owner access.
- Unsanitized signed media URLs or sensitive headers in responses, logs, or artifacts.
- Path traversal in artifact/profile handling.
- SSRF or unsafe proxy behavior.
- Extraction-strategy concurrency that crosses job/profile boundaries.

The following are outside the intended scope: CAPTCHA bypass, DRM/EME bypass, membership or region bypass, anti-bot evasion, credential theft, and processing content without authorization. Please do not test those behaviors against third-party systems.
