# Runtime optimization — 2026-09-06

## Objective and invariants

Reduce CPU and memory overhead without removing or changing supported behavior.
Keep all three extraction strategies, raw audio and checksums, QR login and cookie
import, account switching/logout and ownership guards, search pagination/order,
favorites, creators, playlists, playback ranges, streaming/Range/HEAD/downloads,
mobile APIs, cancellation, timeouts and recovery. Credentials remain exclusively
inside the kernel; App storage remains metadata-only. No production VPS changes
are authorized by this local optimization run.

Existing uncommitted login-reliability and deployment work is the baseline, not
something to revert. Tests must use isolated data, never the user's databases,
browser profile or active Bilibili account.

## Baseline

- Kernel: `python -m pytest app/tests -q`: **140 passed**, 4.61 s (Windows).
- App: `npm test`: **21 integration + 102 unit tests passed**.
- Docker Engine was initially stopped. Linux production-image verification is
  required in addition to host unit tests.
- Historical performance numbers in PERFORMANCE_DEPLOYMENT.md are not new
  before/after measurements and must not be reused as this iteration's gains.

## Work and verification gates

- [x] Combine profile resolution and current login status into one kernel request,
  retaining legacy clients/backends and per-request identity freshness.
- [x] Reduce MSE buffer copies/encoding cost, bound allocations before decoding,
  move blocking file work off the event loop, drain on cancellation, and prove
  byte-for-byte/manifest equivalence with valid captures.
- [x] Release consumed HTTP response buffers on success and failure.
- [x] Separate HTTP-only login/search from browser launch while keeping one
  authoritative kernel-owned login state. Verify legacy-profile migration,
  browser/HTTP handoff, concurrent search/extraction, login cancellation, cookie
  updates, import, logout and account changes before enabling this by default.
- [x] Review bounded task/candidate retention and shutdown cleanup without
  truncating successful audio or altering strategy selection.
- [x] Reproducible before/after CPU, memory and latency measurements using the
  same workload, versions and resource limits. Distinguish Python allocations,
  process memory, container memory and response latency.
- [x] Full host tests, typecheck/build, Linux production-image tests, full HTTP
  compatibility, account/range and login resilience tests. Browser-level tests
  must cover native and fallback encoding plus AAC/MSE and audio bytes.
- [x] Completion audit against all invariants above; document remaining real
  upstream/account-holder checks honestly. Do not equate green unit tests with
  production deployment or full real-upstream acceptance.

The objective requires the implementation and verification below, not merely a
passing build. Do not lower memory limits or remove strategies to manufacture a
performance improvement.

## Implemented changes and evidence

### Combined account read

`POST /v1/profiles` accepts the optional `include_login_status` flag. Existing
clients retain their original response shape. The current App needs one internal
HTTP request instead of two; older kernels still use the compatible fallback.
Profile, owner and identity come from one current row, with no identity cache
between incoming requests. Tests compare the exact old/new App result and check
logout, account switching, owner mismatch and simultaneous profile creation.

### MSE allocation and event-loop work

Modern Chromium uses native `Uint8Array.toBase64`; the compatibility encoder is
retained. Encoding happens synchronously before appendBuffer can detach/reuse its
input, eliminating the previous full buffer copy. Limits are checked before
browser encoding and Python decoding. One decoded segment/IO worker is active at
a time. Capture is frozen and accepted deliveries drained before merging; late,
duplicate, missing or failed segments cannot be published as successful audio.
Cancellation drains blocking work before owners/files are released.

Actual HeadlessChrome **152.0.7977.82** in the phase-2 image passed both native and
fallback capture paths: **7 segments, 54,913 bytes**, SHA-256
`657342d4453f3e5fef7301f8bad8b175cedd307dfa42d68a82cb5c85efe7c750`.
Both outputs matched the generated AAC/MP4 bytes exactly. This is a synthetic
media-pipeline check, not a claim of real-upstream availability for every video.

In the same 1-core/512-MiB Linux microbenchmark, an 8-MiB encoding's median was
**38.30 ms (previous algorithm) → 3.05 ms (native)**. A 300-operation profile read
comparison used **164.67 ms → 61.21 ms Python CPU time**, with identical identity
data. These are hot-path measurements, not whole-site speedups. Earlier runs and
different filesystem conditions produced different absolute timings; do not mix
their values into one percentage.

### HTTP-only profile sessions

Login/search can now run without launching Chrome. A profile has one active jar:
standalone HTTP, or the existing browser's shared request context. Existing HTTP
leases drain before a browser handoff; parallel search remains supported. An
owner-only atomic journal remains in kernel profile storage. HTTP cookie changes
are persisted before confirmation, browser ownership is journaled before work,
and interrupted browser ownership recovers from the persistent browser profile.
Cookie deletion propagates, origin storage is preserved, and logout removes both
stores only after guards/leases are released. Idle entries drop credential-cache
references. Initialization errors do not quote stored cookie values.

Host tests include a real Playwright HTTP transport (no browser) proving Set-Cookie,
expiry, profile isolation and logout. A separate no-network, read-only Linux
container verified actual Chrome/HTTP handoff, one-time legacy migration and
interrupted ownership recovery. The final recorded run additionally checks
IndexedDB and records source hashes; it passed against the phase-2 image and is
saved in `tests/performance-reports/runtime-http-final-20260906.json`.
It samples cgroup CPU and memory every 5 ms. The request workload
is serial open/get/close with synthetic persistent cookies and loopback responses;
it is not an App/VPS benchmark. Anonymous memory, working set and total cgroup
memory are reported separately because temporary profile files/page cache affect
the latter two.

Final-image comparison (six runs per mode, alternating order, same 1-core/512-MiB
limit and 256-MiB temporary profile filesystem):

| Measure | Browser-backed reference | HTTP-only profile |
| --- | ---: | ---: |
| Median request lifecycle time | 440.28 ms | 205.72 ms |
| Median cgroup CPU time | 441.84 ms | 208.18 ms |
| Median of sampled per-run anonymous-memory peaks | 101.20 MiB | 50.17 MiB |
| Median of sampled per-run working-set peaks | 375.70 MiB | 318.02 MiB |

This includes the isolated Python test server and runtime, but not the Next App.
It does not assert that production idle memory or total VPS CPU will halve.

An initial legacy fixture used session-only cookies, which Chrome correctly did
not retain after normal close. The fixture was corrected to use explicit expiry
before testing persistent-profile migration; the failure was not hidden by
changing production cookie handling.

### Network response retention

Metadata-only events are classified without allocating an asyncio task per
response. Only the best audio and the stable top-ten diagnostics are retained;
the total candidate count and tie ordering remain unchanged. JSON playurl body
parsing has four concurrent readers, and pending handlers are drained at capture
finish. The number of queued playurl handlers still depends on received events
within the bounded capture lifetime; do not claim all bookkeeping is constant
space. The optimization eliminates task allocation for the bulk metadata-only
path and makes retained candidate storage bounded.

`tests/network-capture-benchmark.py` compares the original module at commit
`ec7445fbb70e0bf1a3abf836b8246dae9fdc1868` with current code, using 20,000 synthetic
events. One host run measured **406.25 → 328.13 ms CPU**, **20,000 → 0 queued
metadata tasks**, and **37,898,037 → 99,902 peak traced Python allocation bytes**.
CPU runs do not enable tracemalloc; allocation runs are separate and do not
represent process RSS. Selection, diagnostic ranking and counters share SHA-256
`3890173341037162dc9557dc05f89a2bc0676470ee312811986b7a62db5aa206`.
The local ignored report is `tests/performance-reports/runtime-network-20260906.json`.

## Validation status

- Phase-1 Linux images built successfully; full local-mode HTTP regression passed
  **1,491 requests / 40 operations**, report
  `tests/mobile-api/reports/f6b16dae-b6e7-44f1-82a9-97d9d81be234.json`.
- Phase-2 kernel image: `bmusic-kernel:20260906-runtime-phase2`, manifest-list digest
  `sha256:d8fac921934dc6b56a0fbac6e8963ed18dc7efe8889da83a7ea1f94352e69e78`.
  **188 Linux kernel tests passed** inside a read-only, no-network, 1-core/512-MiB
  container. The final current-source host suite also passed **188 tests** in
  7.78 s, including the real HTTP transport. Existing FastAPI/Starlette
  deprecation warnings remain unchanged.
- App: **21 integration + 105 unit tests**, typecheck and production build passed.
  **6 MSE hook tests** passed. App source has not changed after its phase-1 image.
- Git diff whitespace check, CI YAML step validation, source-export syntax and
  custom-directory journal-ignore checks passed. Journal files are excluded by
  Git, Docker build context and the source exporter.
- The user explicitly authorized rebuilding/switching the dedicated local QA
  environment after the earlier approval-service failure. The previously blocked
  operation was then performed within that authorization, not via a workaround.
  Both final QA services used `20260906-runtime-phase2`; the App tag reuses the
  already verified unchanged phase-1 App image.

## Final integrated acceptance audit — passed

All reports below were reopened and checked for `passed: true`. Runtime source
hashes in the final HTTP/browser report match the current implementation. The
fixtures used only synthetic identities/audio and isolated databases; no real
Bilibili account, original local instance or VPS was replaced.

| Requirement / gate | Current evidence |
| --- | --- |
| Existing HTTP/API operations, CRUD, fixed search snapshots, errors, CORS and metadata-only behavior | 1,492 requests / 40 operations, `6281d5f9-3a81-43de-a6dc-08006e1bbbcb.json` |
| Verified owner isolation, two accounts, current playback ranges, six-way idempotent writes and optimistic conflicts | 249 requests, `b9605998-4c0b-48a9-9dec-b7951f200583-ranges.json` |
| QR outage/timeout/restriction, six concurrent starts, fixed image, confirmation, expiry/cancel/retry and no Chrome launch | 68 requests, `login-resilience-2026-09-06T04-03-07-868Z.json` |
| Cancellation releases ownership and supports subsequent extraction | 52 requests, `08930657-a1ae-428a-929c-75e8e4a8bbb5-cancel.json` |
| Four admitted concurrent profile readers, safe rejection/Retry-After and bounded recovery | 23 requests, `1d980d61-750d-4fbc-9d65-5d3982e8d492-readers.json` |
| Actual forced kernel termination and recovery retain library/session metadata, reconcile interrupted job, allow new extraction | 12 + 21 requests, `29237c06-49a6-4f71-9219-7a00bc15d825-before-restart.json`, `2ae20c1c-af1a-443a-94e3-1fc92c4d395c-after-restart.json` |
| Actual desktop/mobile QR UI, failed PNG reload, countdown, responsive fit, confirmation and no page errors | `login-ui-e65d7f8e966f4a9c9c5fa606f54e812a/report.json` plus visually inspected desktop/mobile PNGs |
| Real AAC playback, UI playlist creation, stop at explicit end without advancing a two-track queue, desktop-to-phone range sync, visible UP/range controls and account-switch audio stop | `playback-ui-f3894531c757404db62c7d1c5bb8a5f9/report.json` plus visually inspected desktop/mobile PNGs |
| Three strategy implementations and selection policy retained; byte-preserving streaming/downloads, HEAD/Range/validators/checksums | Kernel tests, full HTTP tests and real native/fallback AAC/MSE checks described above; no strategy, codec or output option removed |
| Kernel-only credentials, legacy migration, single active cookie jar, localStorage/IndexedDB preservation and interrupted-owner recovery | `runtime-http-final-20260906.json`, kernel session/ownership/error-redaction tests, journal export exclusions |
| CPU/memory improvement with identical outputs and explicit measurement scope | Final cgroup HTTP lifecycle comparison, encoder comparison and network-capture allocation/CPU report above |

HTTP/UI report paths are under `tests/mobile-api/reports/`; runtime benchmarks are
under `tests/performance-reports/`. There are **1,917 recorded HTTP requests** in
the seven non-UI final acceptance suites; UI browser traffic is additional.

At the final idle checkpoint, active jobs, profile locks/readers, browser leases,
browsers, HTTP leases/contexts and QR watchers were all zero. Both final containers
reported `OOMKilled=false` and restart count 0 after the account-mode rebuild.
The separately tested forced-restart scenario is evidenced above. Docker's
instantaneous idle readings were App **76.48 MiB / 224 MiB**, kernel **66.81 MiB /
512 MiB**; these are not peak, RSS, or guaranteed VPS idle figures. The optional
process-name-only `docker top` query could not be parsed because it omitted a PID
column, so no OS-process-count claim is based on it.

The dedicated QA containers, their network and synthetic App data volume were
removed after verification. Reports and both versioned images were retained;
synthetic test data can be regenerated by the fixtures. The original local kernel
on port 8000 remains; no production VPS deployment, Git commit or push was made.

The local implementation/verification objective is complete. This does not claim
that every future upstream video is accessible or that a real account holder has
completed a new login. Real Bilibili confirmation, authorization, remote service
availability and any later VPS rollout remain separate operational concerns.
