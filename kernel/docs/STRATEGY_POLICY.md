# Strategy Policy

The kernel supports three strategies:

1. `api_dash`
2. `browser_network`
3. `mse_sourcebuffer`

Strategies run behind a common interface:

- `name`
- `supports(context) -> bool`
- `run(context) -> StrategyResult`

`StrategyResult` includes status, reason, selected media, raw artifacts, timings, sanitized debug info, and failure code on failure.

## Force Mode

Force mode runs only the specified strategy. It does not fall back.

## Auto Mode

Auto mode chooses order from:

- user-provided `strategy_order`, if present
- default order
- historical success rate
- recent failure reason
- average duration
- whether the profile is logged in
- context hints

Default order:

1. `api_dash`
2. `browser_network`
3. `mse_sourcebuffer`

The MVP runs strategies sequentially and does not parallelize.

## Metrics

The kernel persists per-strategy metrics:

- `strategy_name`
- `total_attempts`
- `success_count`
- `fail_count`
- `last_success_at`
- `last_failure_at`
- `last_failure_reason`
- `avg_duration_ms`

## Strategy Report

Every attempted strategy is recorded in `strategy_report.json`, including failures. Full signed URLs, cookies, and sensitive headers must not appear in reports.

## MSE Diagnostics

`mse_sourcebuffer` is a last-resort strategy. It now records sanitized diagnostics for:

- MediaSource and ManagedMediaSource availability.
- `URL.createObjectURL(MediaSource)` and `sourceopen` activity.
- SourceBuffer MIME types and append counts.
- HTML video element readiness and codec support.
- Chromium CDP Media player events, messages, properties, and errors.

The Docker image installs and defaults to the Playwright `chrome` channel because Bilibili DASH audio normally uses AAC/MP4. Playwright's bundled open-source Chromium may not report support for those codecs, which prevents normal player/MSE initialization. This is a media compatibility setting, not stealth or anti-bot evasion.

`MSE_CAPTURE_MS` controls how long the strategy keeps the real player open and records audio SourceBuffer appends. The default Docker value is `45000`. `MSE_PLAYBACK_RATE` defaults to `4.0` so normal browser playback can buffer more audio during that window. Longer videos may still require larger values because MSE capture can only record bytes the normal player actually buffers.
