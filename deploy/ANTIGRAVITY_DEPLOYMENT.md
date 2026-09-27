# Antigravity-priority deployment — 2026-09-06, updated 2026-09-27

The live site is https://bmusic.ftwegc.com on `47.254.129.176`, with App
`20260927-douyin-r8` and kernel `20260927-douyin-r7`. The App and kernel were built on the local Windows Docker
Linux engine. The VPS only received and loaded prebuilt images; it performed no
application build or dependency installation. Source and data archives were
also verified after upload.

## Isolation and priority

Antigravity has priority; B-Music is not boxed in (since 2026-09-27).

| Service | RAM limit | Swap allowance | CPU limit | CPU shares | OOM adjustment |
| --- | ---: | ---: | ---: | ---: | ---: |
| B-Music App | 256 MiB | 0 | none (2 cores) | 128 | 800 |
| B-Music kernel | 320–768 MiB, set by the guard | 512 MiB above RAM | none (2 cores) | 128 | 900 |

Antigravity keeps its own 900 MiB and 1.5-core limit with the default CPU weight
of 1024. B-Music can use idle cores, and under contention it gets about one
eighth of Antigravity's CPU share. The kernel starts at 320 MiB of RAM
(`memswap_limit: 832m` is RAM plus swap). The guard then raises or lowers the
ceiling with host headroom, always leaving 300 MiB of host memory available.
Lowering the ceiling below the kernel's usage moves the excess into its swap
allowance; it does not kill the kernel. The App cannot swap. The existing host
swap configuration and Antigravity limits were not changed. Antigravity remained healthy with restart count zero;
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
recorded in `/opt/bmusic/private/priority-pause.json`.

Since 2026-09-27 the guard also does two more things:

- While B-Music runs, it sets the kernel's RAM ceiling to its memory use (excluding
  page cache, which host available memory already counts) plus host
  available memory, minus the 300 MiB reserve, within 320–768 MiB. It lowers the
  ceiling on a 32 MiB change and raises it only on a 96 MiB change, so idle
  fluctuation does not move it.
- After its own stop, it restarts the kernel and then the App. Antigravity must
  first have been healthy, with at least 450 MiB free and 6 GiB of disk, for five
  minutes. After three automatic restarts within six hours, the pause is latched
  for operator review.

The guard never starts containers an operator stopped, or while
`/opt/bmusic/private/priority-hold` exists. It keeps its state in
`private/priority-state.json` and logs every stop, restart and ceiling change to
`private/priority-events.jsonl`.

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

## Douyin support and dynamic resources — 2026-09-27

At 07:20 UTC, App `20260927-douyin-r6` and kernel `20260927-douyin-r7` added Douyin
links (one public item per pasted link, no login) and covers for both sources.
The dynamic overlay and guard described above were installed at the same time.
The API change is additive only, and the App reports revision 1.3.0. Kernel `r7`
is `r6` plus one fix: closing a lookup browser after an unavailable answer no
longer records a spurious crash.

Local validation used the production limits:

- The kernel image passed 339 tests.
- App compatibility acceptance passed 11 checks, 1,503 requests and all 41
  operations; ranges acceptance passed 3 checks.
- A real Douyin link was searched, its cover shown, and it was prepared, streamed
  and downloaded.

Before replacement, a disposable container of the new kernel image ran on the VPS
with the production limits and no production data. It read two of three public
Douyin items from the German VPS in about 16 seconds each; covers and MP3 downloads
also worked. The third item was unavailable (`core_dep`) from China as well,
because it was deleted or private, not region-blocked.

The kernel image was transferred as an 82,185-byte delta over `dash-r3`. The App
has a newer Node base (24.21.0), so it was transferred as a 100.8 MB archive. The
images are:

- App `sha256:687c8430f619c589808f13c3d0596d87d891dc1d11c42f9805a3062c5b91449b`
- Kernel `sha256:58658d094de9d298779b599f8a0c540d99fc93cf3fe6f1d331cf113f4bcfb9e9`

Loading throttled itself and monitored Antigravity.

The script `deploy/private/deploy_douyin_r7.py` did the following:

- Its dry run confirmed that the only Compose changes were the two images, the
  App's RAM and Node heap, and both CPU limits.
- It stopped both music containers with no job active.
- It backed up both databases, the kernel profiles, `.env`, both Compose files and
  the old guard to `/opt/bmusic/private/before-douyin-r7-20260927T072008Z`.
- It archived the 2026-09-13 pause record, from a resolved Antigravity upgrade, as
  `priority-pause-20260913T034812Z.json`.
- It installed the new files and started both services, which were back in about 15
  seconds.

Afterwards:

- The kernel and App were healthy, with the new limits.
- Antigravity's and Caddy's container IDs, start times, limits, restart counts,
  Compose file and Caddyfile hashes were unchanged.
- Public HTTPS and API revision 1.3.0 passed, and the existing Bilibili login
  remained active.
- A live kernel Douyin check resolved in 7.0 seconds with a JPEG cover. Its job
  produced a 1,052,781-byte MP3 in 4.1 seconds.
- Antigravity answered every health probe within 5 ms, host memory stayed at or
  above 500 MiB, and neither music container recorded an OOM event.

The first guard version had two problems. It switched the kernel ceiling between
496 and 528 MiB as idle memory drifted. It also counted the kernel's page cache
(181 of 256 MiB) both in the kernel's usage and in host available memory, which
set the ceiling about 180 MiB too high. The guard was replaced in place with the
32/96 MiB hysteresis and with the page cache excluded from the kernel's usage. No
container was restarted. Its first installed copy is kept in the backup directory
as `priority-guard.py.r7-initial`.

The record is `/opt/bmusic/private/douyin-r7-deployment.json`. The sources are
`/opt/bmusic/releases/20260927-douyin-r6/source.tar.gz` and
`/opt/bmusic/releases/20260927-douyin-r7/source.tar.gz`. The previous images,
`bmusic-app:20260906-heart-r5` and `bmusic-kernel:20260906-dash-r3`, remain on the
VPS for rollback.

## Next.js security update — 2026-09-27

After the Douyin release, `npm audit` reported new advisories against the App's
production dependencies:

- Next.js 16.3.0 has a critical remote code execution in the Image Optimization
  API with AVIF files (GHSA-2xp9-vwfh-vxw4), plus an advisory for Windows-hosted
  servers (GHSA-p293-qw3h-jr36).
- sharp 0.35.3 has libheif vulnerabilities (GHSA-rgj7-g3m4-5g8c).

The live `/_next/image` endpoint was reachable and rejected remote URLs. The App
configures no remote image patterns, so exploitation was unlikely. It was
patched anyway.

App `20260927-douyin-r8` uses Next.js 16.3.6, sharp 0.35.4 and
baseline-browser-mapping 2.11.26; the App code is unchanged. Local validation:

- `npm audit --omit=dev` reports no vulnerabilities.
- `npm test` passed 122 tests, and typecheck and the production build passed.
- Compatibility acceptance passed 11 checks, 1,503 requests and all 41 operations
  against kernel `r7`. Ranges and account acceptance passed 3 checks with 248
  requests.
- The image no longer bundles the musl (Alpine) sharp variants, which the Debian
  runtime does not use.

The image transferred as a 12.2 MB delta over `r6`, and its ID is
`sha256:23a748c0927f4d2c5104a43ae8845c11770c86ee0cb410487c758205d52ff463`.
`deploy/private/deploy_app_r8.py` first did a dry run: the only Compose change was
the App image, and no job was active. At 07:50 UTC it replaced only the App,
after backing up `.env` and the App database to
`/opt/bmusic/private/before-app-r8-20260927T075003Z`. The App was healthy again
within about 6 seconds.

The App's limits were unchanged, and Next reported 16.3.6. The kernel,
Antigravity and Caddy were verified unchanged. Public HTTPS, API revision 1.3.0,
the Bilibili login, the cached Douyin cover and OpenAPI all passed. The record is
`/opt/bmusic/private/app-r8-deployment.json`. The source is
`/opt/bmusic/releases/20260927-douyin-r8/source.tar.gz`. App `r6` remains on the
VPS for rollback.

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

After a protection pause the guard restarts B-Music by itself once the host has
been healthy for five minutes. Check `private/priority-events.jsonl` for its
reason. If the pause is latched (`"latched": true` in `private/priority-state.json`),
confirm that Antigravity is healthy and that there is enough memory and disk,
then start B-Music manually:

```sh
docker compose -p bmusic -f compose.yml -f compose.antigravity-safe.yml up -d --pull never --wait
```

Starting B-Music manually ends the guard's pause. To clear a latch, remove the
`latched` and `resumes` entries from `private/priority-state.json`. To keep
B-Music stopped while investigating, create `private/priority-hold`. Preserve
the pause report as an incident record. To disable the music service,
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
