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

## Container

The image no longer copies a missing AGENTS.md. The build context excludes storage, credentials, test dependencies and caches. Compose uses an init process, a 512 MB shared-memory area for Chromium, a restart policy, and a 30-second stop grace period. The image explicitly runs one API worker because profile/job ownership is coordinated within one kernel process.

The HTTP/media checks, profile-owner checks, sequential strategy policy, Range streaming and raw audio preservation remain in place.

## Deployment and validation

Unit tests use isolated temporary databases and simulated providers. Changes have not been deployed to an existing kernel container. Rebuild in the actual deployment environment after checking for active jobs; real Bilibili access and long-running playback still require integration acceptance.
