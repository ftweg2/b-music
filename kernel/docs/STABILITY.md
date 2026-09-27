# Stability iteration

This iteration changes execution and lifecycle behavior, not the extraction authorization boundary. Dependency and browser image versions remain pinned together; no unverified bulk dependency upgrade is included.

## Jobs

- Repeating the same job ID with the same owner, profile, canonical video, strategy parameters and outputs returns the existing job with reused=true. Different parameters return 409; a different owner is rejected.
- A conditional database claim allows only a queued, unstarted job to run. Duplicate runners and terminal-job replays return without touching the live profile lock.
- MAX_ACTIVE_JOBS defaults to 2, bounded to 1–8. New jobs above capacity receive HTTP 503 with Retry-After: 3 and X-Kernel-Job-Accepted: false. Idempotent retries are still accepted without scheduling another job.
- JOB_TIMEOUT_SECONDS defaults to 300, bounded to 30–1800. It covers all strategies and media processing. This is a cooperative timeout: network/browser cleanup and worker draining may add a short cleanup interval.
- Unexpected strategy exceptions become sanitized failed attempts; only explicitly configured fallback strategies may run.
- Failure/cancellation state is saved before writing diagnostic reports. A report-write failure does not leave a job permanently running.
- Media workers receive cancellation and are drained before ordinary profile release. A cancelled parent cannot publish a late successful result.
- Explicit cancellation interrupts active task awaits; queued tasks observe the cancellation flag on startup so their cleanup is not skipped.
- SHUTDOWN_GRACE_SECONDS defaults to 10, bounded to 1–30. Shutdown does not wait indefinitely for an uncooperative task. Startup recovery reconciles interrupted jobs.
- Douyin metadata lookups (`POST /v1/douyin/resolve`) start a browser, so they count toward MAX_ACTIVE_JOBS together with jobs. With the production value of 1, at most one of {job, Douyin lookup} runs at a time; the other side gets 503 + Retry-After: 3.
- Expired artifacts are removed at startup and then hourly while the kernel runs, so disk use stays bounded without restarts.

## Small-machine behavior

- API DASH downloads the selected stream from its primary CDN node, then each `backupUrl` node, with a second pass after one second. Reports record which mirror succeeded (`mirror_index`).
- WBI signing keys are reused for ten minutes instead of being fetched before every playurl request.
- `browser_network` stops capturing as soon as the player's playurl audio list has been parsed, instead of always waiting NETWORK_CAPTURE_MS. The list contains every audio quality, so a longer wait cannot improve the choice.
- Extraction pages skip Bilibili image-CDN assets and web fonts (only those URLs are intercepted; media is untouched), and profile browsers are muted.
- A Douyin lookup browser uses one renderer and no GPU/sync/extension services, runs one at a time by default (DOUYIN_MAX_BROWSERS), and a crash or out-of-memory kill fails the lookup immediately instead of holding the slot until the timeout. Inside a job, a timeout, busy pool or crash is retried once.
- Downloaded Douyin media must start with a real audio/video container signature; a CDN error page returned with HTTP 200 is discarded and the next mirror is tried.

Measured on a desktop (Edge, Windows): a Douyin lookup peaked at ~550 MB before and ~430 MB after the lean launch flags; the Bilibili browser strategy peaked at ~635 MB before and ~546 MB after skipping decorative resources. The production kernel runs Chrome Headless Shell under a 320 MiB limit with swap, so absolute numbers there differ; validate on the target host before raising any concurrency setting.

## Container

The image no longer copies a missing AGENTS.md. The build context excludes storage, credentials, test dependencies and caches. Compose uses an init process, a 512 MB shared-memory area for Chromium, a restart policy, and a 30-second stop grace period. The image explicitly runs one API worker because profile/job ownership is coordinated within one kernel process.

The HTTP/media checks, profile-owner checks, sequential strategy policy, Range streaming and raw audio preservation remain in place.

## Deployment and validation

Unit tests use isolated temporary databases and simulated providers. Changes have not been deployed to an existing kernel container. Rebuild in the actual deployment environment after checking for active jobs; real Bilibili access and long-running playback still require integration acceptance.
