# Antigravity-priority deployment — 2026-09-06

The live site is https://bmusic.ftwegc.com on `47.254.129.176`, with App
`20260906-heart-r5` and kernel `20260906-dash-r3`. The App and kernel were built on the local Windows Docker
Linux engine. The VPS only received and loaded prebuilt images; it performed no
application build or dependency installation. Source and data archives were
also verified after upload.

## Isolation and priority

| Service | RAM limit | Swap allowance | CPU limit | CPU shares | OOM adjustment |
| --- | ---: | ---: | ---: | ---: | ---: |
| B-Music App | 160 MiB | 0 | 0.25 core | 128 | 800 |
| B-Music kernel | 320 MiB | 512 MiB | 0.50 core | 128 | 900 |

The kernel's `memswap_limit: 832m` is the combined RAM and swap limit. The App
cannot swap. The existing host swap configuration and Antigravity limits were
not changed. Antigravity remained healthy with restart count zero;
its image, container ID and startup time stayed unchanged. Its Compose file's
SHA-256 also stayed unchanged. Caddy received only an appended B-Music site block
through a validated graceful reload. Its existing configuration prefix, container
ID and startup time were preserved.

The project uses `/opt/bmusic`, the `bmusic` Compose project/network, and loopback
ports 13100 and 18100. The active configuration combines `compose.yml` and
`compose.antigravity-safe.yml`.

`bmusic-priority-guard.timer` checks about every 15 seconds. It stops only the two
verified B-Music containers if available host memory falls below 200 MiB, free
disk falls below 5 GiB, or Antigravity's local health check fails. A pause is
recorded in `/opt/bmusic/private/priority-pause.json` and requires operator review;
the guard does not repeatedly restart B-Music under pressure.

## Real-video OOM incident and correction

The initial 320 MiB kernel limit with zero swap passed synthetic acceptance but
was insufficient for a real authenticated Bilibili video page. At 09:28 UTC,
Chromium incurred a cgroup OOM kill. Its extraction occupied the only job slot
until the existing 300-second timeout completed, so another submission received
HTTP 503 (`kernel is busy`). The profile lock was then released normally. This
was a deployment resource-budget error, not an account rejection or an
Antigravity protection pause.

At 09:42 UTC, a configuration-only correction enabled 512 MiB of kernel swap.
The locally built images remain `20260906-antig-r2`; no source rebuild was
needed. The corrected Compose file was validated locally, uploaded, compared
against the full existing Compose configuration, backed up, and applied with
`docker update --memory-swap 832m bmusic-kernel-1`. Both music containers, the
login session, Antigravity and Caddy retained their container IDs/start times.
The change is persisted in `compose.antigravity-safe.yml` for future starts.

The two affected real tracks were retried sequentially through the App API with
the existing VPS login. Both became ready in 47.5 and 52.3 seconds. Their AAC
files contained 6,194,613 and 10,539,118 bytes, with durations 269.504 and 264.363
seconds. Full App stream SHA-256 checks and HTTP 206 range checks passed.
Across 51 samples, kernel swap peaked at 225.7 MiB, host available memory stayed
above 294.4 MiB and Antigravity health responses took at most 1 ms. There were
zero additional OOM kills and no protection pause. The historical OOM counter
remained 1 at that checkpoint because the container was not restarted to erase it.

The service still admits one extraction at a time to prioritize Antigravity;
new concurrent preparation requests may receive the existing busy response.
These timings are measurements of these two tracks, not guarantees for all
upstream pages. Configuration backup/update records and the real retry report
are under `/opt/bmusic/private` (`kernel-swap-real-retry.json`).

## API DASH authenticated-session fix

The old API DASH strategy created an anonymous HTTPX client even after a user
had logged in. On this VPS its metadata calls repeatedly returned HTTP 412.
A bounded comparison against the same video returned 412 anonymously and 200
using the existing profile session, through both HTTPX and Playwright's HTTP
transport. This established the missing login session as the cause of those
failures; it did not establish an IP ban.

Kernel `20260906-dash-r3` routes metadata, WBI and playurl GETs through the
profile's existing HTTP cookie owner. Set-Cookie remains owned and persisted
there; consumed API bodies are disposed. The API lease closes before the
signed audio URL is downloaded with the existing streaming/range downloader.
The App does not receive account cookies or signed upstream URLs. An
HTTP-owned profile needs no Chromium launch for API DASH.

Local validation passed 196 tests at the deployment limits. An additional test
of the built image exercised real Playwright HTTP transport, cookie rotation,
DASH download and FFmpeg output against an isolated local upstream, with zero
Chromium launches and no OOM. The image was built locally and transferred as a
15,252-byte OCI delta referencing the exact base already on the VPS; the
resulting complete image digest was verified as
`sha256:749ab3a32799ad6caa784eb9017aad72353e5bfa60efdcbae29e66fcef3acdbf`.
Restoring this delta onto a fresh Docker host requires loading the retained
`20260906-antig-r2` base archive first.

The kernel was updated at 10:02 UTC after checking that no job was active and
backing up both databases plus the stopped kernel's profiles locally on the
VPS. App, Antigravity and Caddy were not restarted; their container identities
and the primary configuration/limits were verified unchanged. All music limits
and the priority guard remain in force. `.env` now sets
`BMUSIC_KERNEL_RELEASE=20260906-dash-r3` while preserving the App release.

The user's failed track 30 (`BV1BntR6sE81`) was retried in **forced API DASH**
mode. It succeeded with a single API DASH attempt in 4,096 ms, becoming ready
through the App in 5.2 seconds. Its 6,141,987-byte AAC file lasts 270.118 seconds;
the full App stream checksum and HTTP 206 range checks passed. Across 12
samples, kernel RAM peaked at 137.9 MiB, kernel swap stayed zero and host memory
available stayed above 483.2 MiB. Antigravity health responses took at most 1 ms,
with no failures, new OOM kills or guard pause. These are observations of this
track, not guaranteed preparation times for all videos.

VPS records: `/opt/bmusic/private/dash-r3-deployment.json`,
`/opt/bmusic/private/dash-r3-real-retry.json`; source archive:
`/opt/bmusic/releases/20260906-dash-r3/source.tar.gz` (SHA-256
`639b37a167864e118c967b0b2c032b9d7e5ec7af1f2227dad4fcbcf3cacc8824`).
The deployment record identifies the rollback backup directory. Keep the
kernel release override in mind when restoring `.env`.

## Default API DASH setting

At 10:37 UTC, App `20260906-default-dash-r4` made forced API DASH the player
default and the default for App prepare/refresh requests omitting all strategy
parameters. Explicit automatic/browser/MSE choices are still honored. The
settings page, selector label and API documentation describe the new default.

The image was built locally after 21 integration tests, 105 unit tests and
typechecking passed. Strategy parsing was checked for omitted parameters and
explicit alternatives. The VPS received a checksum-verified image delta; only
the App was replaced, with a consistent App database and environment backup.
Its image is `sha256:adc7a61fe9de15b86da3b9d2ff5615d44bc4ed9c5bed9ef98bf228148e3d8d30`.
Kernel, Antigravity and Caddy container identities/start times and all resource
limits remained unchanged. Desktop and mobile browsers verified the API DASH
default, manual switching and the default after reload; public HTTPS/API checks
passed and the existing Bilibili login remained active.

The deployment/backup record is
`/opt/bmusic/private/default-dash-r4-deployment.json`; source is retained at
`/opt/bmusic/releases/20260906-default-dash-r4/source.tar.gz`, SHA-256
`bf786e7d4a395d7867b95b4f230a72ece554134abe9daa4db94b7a1554317896`.

## Player favorite indicator

At 10:54 UTC, App `20260906-heart-r5` connected the player heart to the current
account/song's saved favorite state and library change events. Successful saves
show a filled red heart, including after reload. Older metadata reads cannot
undo a newer favorite action, and completion after switching songs cannot mark
the new song as favorited. The existing add-to-favorites behavior is preserved.

Local checks passed: 21 integration tests, 105 unit tests, typecheck, production
image build, and browser checks for saving, reloading, external favorite changes,
failed saves, delayed reads and song switches. The compact mobile layout remains
unchanged and its stored favorite state also synchronizes. Read-only production
browser checks confirmed a real existing favorite displays red after reload;
HTTPS, API health/library reads and the existing Bilibili login passed.

Only the App was replaced. Kernel, Antigravity and Caddy container identities,
start times and resource limits were verified unchanged. The App image is
`sha256:b28d821c6c455fbdb722e867d43251321d0bf86b34741c5fd329989309bd6167`.
The consistent App database/environment backup is recorded in
`/opt/bmusic/private/heart-r5-deployment.json`. The uploaded source archive is
`/opt/bmusic/releases/20260906-heart-r5/source.tar.gz`, SHA-256
`6040bedb42601aeba8f6e185a5dd2295a0334c57309e999c1ee9656d5935f1fb`.

## Initial deployment verification and data

- Local Linux kernel: 188 tests passed at 320 MiB/0.5 core.
- App: 21 integration and 105 unit tests, typecheck, and production image build.
- Production-limit isolated acceptance: 1,499 full API requests, 252 account/range
  requests, 65 login-resilience requests, 60 cancellation requests and 23 reader
  concurrency/recovery requests passed. Actual desktop/mobile QR and AAC playback,
  range synchronization and account-switch audio stopping passed.
- Actual native and fallback MSE capture each preserved all 54,913 synthetic AAC
  bytes at the deployment limits. The separate mixed legacy/current repeated
  8-MiB encoder benchmark exceeded 320 MiB; it is not represented as passing or as
  a production workload. The App/kernel acceptance services recorded no OOM kills.
- VPS HTTPS, static resources, APIs, Origin guards and real Bilibili QR generation
  passed. QR preparation through the public site took about 1.5 seconds. The test
  pending QR was cancelled; no real account confirmation is claimed.
- Migrated 2 favorites, 9 tracks and 1 playback range, plus 25 checksum-verified
  artifact files. No browser profile, cookies or HTTP session journal was copied.
  The original local instance remains available. Sign in with the original
  Bilibili account to access its account-scoped library.
- Final read-only audit: both containers healthy, restart count zero, and cgroup
  OOM counters zero. The primary service remained healthy and unchanged.

The final idle checkpoint showed App 123.2 MiB, kernel 73.79 MiB and approximately
503.6 MiB host memory available. These are observations after verification, not
peak guarantees. TLS 1.3 and the exact domain certificate were verified; the
current certificate expires on 2026-12-05 and is managed by Caddy.

## Operations and recovery

Use the complete Compose configuration for every operation:

```sh
cd /opt/bmusic
docker compose -p bmusic -f compose.yml -f compose.antigravity-safe.yml ps
systemctl status bmusic-priority-guard.timer --no-pager
```

After a protection pause, inspect its reason, confirm Antigravity is healthy and
restore sufficient memory/disk headroom before manually starting B-Music:

```sh
docker compose -p bmusic -f compose.yml -f compose.antigravity-safe.yml up -d --pull never --wait
```

Preserve the pause report as an incident record. To disable the music service,
use this project's `stop` command; do not stop or recreate Antigravity/Caddy.
Keep both limit overlays in use during updates. Validate replacements locally,
take a consistent data backup, and retain the existing image tag for rollback.

The original Caddy bytes are retained at
`/opt/bmusic/private/caddy-before-20260906-antig-r2.conf`. Deployment, seed and final
audit records are under `/opt/bmusic/private`; the validated source archive is at
`/opt/bmusic/releases/20260906-antig-r2/source.tar.gz`. Transfer archives and
installation helpers remain in `/opt/bmusic-upload-20260906-antig-r2`.

Detailed local reports are Git-ignored under `deploy/private/qa-antig-r2`,
`deploy/private/final-audit-20260906-antig-r2.json`, and `tests/mobile-api/reports`.
No Git commit/push was performed by this deployment.
