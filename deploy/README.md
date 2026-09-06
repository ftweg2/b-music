# Isolated B-Music deployment

Production uses prebuilt Linux images, an isolated Compose project named `bmusic`, `/opt/bmusic` data/configuration, loopback ports 13100 (App) and 18100 (kernel), and its own `bmusic.ftwegc.com` Nginx virtual host. No existing site's files are replaced. The VPS does not run a Next development server or build the application.

The current deployment uses App `20260906-heart-r5` and kernel `20260906-dash-r3` on the shared Antigravity host
`47.254.129.176`, serving `https://bmusic.ftwegc.com` through the existing Caddy.
Both Linux images were built and validated locally before upload. B-Music has
lower CPU priority, 160/320 MiB App/kernel RAM limits, a 512 MiB kernel swap allowance, and a guard that stops only
B-Music when host resources or Antigravity health require it. Antigravity's
container, resource limits and Compose configuration were preserved. See
[the current deployment and recovery record](ANTIGRAVITY_DEPLOYMENT.md).

API DASH now uses the kernel profile's existing HTTP session for metadata, WBI
and playurl requests. It no longer silently makes those requests anonymously
after Bilibili login. The media transfer remains streamed through HTTPX without
launching a browser or copying account cookies to a second session. The kernel
image can be updated independently with `BMUSIC_KERNEL_RELEASE` in `.env`;
when absent it uses `BMUSIC_RELEASE` like the App.

The player defaults to **API DASH**. App prepare/refresh requests that omit all
strategy parameters also use forced `api_dash`. Explicit automatic and browser
strategies remain available; selecting an automatic strategy is a user choice.

The earlier local runtime-optimization images were `20260906-runtime-phase2`.
See [runtime optimization and measurement scope](RUNTIME_OPTIMIZATION.md) for
their changes and performance evidence. The Nginx deployment instructions and
older image tags below describe the previous host; do not apply its installer
to the current Caddy/Antigravity host.

Build locally with Docker:

```powershell
docker build -t bmusic-app:20260905-optimized bili-music-app
docker build -t bmusic-kernel:20260905-optimized kernel
```

Validate the actual images with the production resource limits on an isolated network:

```powershell
$env:BMUSIC_RELEASE='20260905-optimized'
$env:QA_LIBRARY_MODE='account'
docker compose -p bmusic-image-qa -f deploy/compose.yml -f deploy/compose.verify.yml up -d --wait
node tests/mobile-api/ranges-acceptance.mjs
docker compose -p bmusic-image-qa -f deploy/compose.yml -f deploy/compose.verify.yml down -v
```

Use `QA_LIBRARY_MODE=local` and `tests/mobile-api/acceptance.mjs` for the complete compatibility API regression. Verification uses synthetic audio, not a user's Bilibili account.

The website no longer uses an extra HTTP Basic Auth username/password prompt. Web and native clients use `https://bmusic.ftwegc.com` without a gateway Authorization header. HTTPS and Bilibili QR login remain enabled; the extraction kernel is still bound to loopback and is not publicly exposed directly. No gateway password needs to be generated or uploaded. Existing private credential backups are left untouched but are no longer used by the deployment.

This is a shared service with one active Bilibili login, not independent per-device multi-user authentication. Anyone who can reach the URL can access the App and its exposed library, playback and account operations. Bilibili login partitions library metadata by the verified current account; it does not authenticate each website visitor. Origin checks are not a substitute for per-user access control. Use this deployment only when that shared-access model is intended.

Run `node deploy/check-site.mjs` for a read-only, anonymous HTTPS check of HTML, static assets, APIs and Bilibili login status. It asserts that the gateway does not send a `WWW-Authenticate` challenge, sends no Authorization or Cookie header, and saves a timestamped report under the Git-ignored `deploy/private/` directory. Optional `--check-origin` sends deliberately invalid playlist requests to validate Origin handling without creating a playlist. Only use `--check-login` on an operator-controlled, logged-out test service: it explicitly creates and cancels a test QR session and refuses an already logged-in or pending-login service. Do not use that flag for routine live-site checks.

`node deploy/prepare-data.mjs` snapshots the App and kernel databases plus audio cache into `deploy/private/seed-data`. It refuses to snapshot active local extraction jobs. It never exports the kernel browser profile or Cookie files; only the copied database is marked logged out. The original computer's login and data are unchanged. The VPS requires a fresh Bilibili QR login; use the same Bilibili account to see the migrated library and playback settings.

Each snapshot actually gets a unique `seed-data-UUID` directory, recorded in the private summary. Use the domain as the shared Base URL after migration; the retained localhost instance is a backup, not a second database that automatically synchronizes with the VPS.

The 1 GB VPS uses the branded Google Chrome for Testing Headless Shell 152.0.7977.82 through `PLAYWRIGHT_EXECUTABLE_PATH`. AAC/MSE support was explicitly checked; Playwright's unbranded bundled headless shell was rejected because its AAC check was false. The full Chrome channel remains installed as a fallback. This changes the browser runtime footprint, not the App's API or music features. The upstream binary comes from Google's versioned Chrome for Testing distribution over verified HTTPS.

On the current Antigravity host, the App cannot swap. The kernel retains its 320 MiB RAM limit and may use up to 512 MiB of the existing host swap (`memswap_limit: 832m` means RAM plus swap). The initial no-swap setting killed Chromium on a real video page and was corrected on 2026-09-06. The host swap configuration, Antigravity limits, low music CPU priority and protection guard are unchanged. QR preparation has a 60-second server budget on this VPS and a 90-second client request budget; expiry after QR generation remains unchanged.

The login reliability update uses Bilibili's first-party QR generate/poll flow through the same kernel profile cookie jar, avoiding the full passport page and screenshots. The PNG is fixed for the session, expiry begins at readiness, and transient failures have bounded recovery and typed errors. See [login reliability](../kernel/docs/LOGIN_RELIABILITY.md). For a small update against the previously verified runtime, build **locally** with `docker build -f deploy/Dockerfile.kernel-update -t bmusic-kernel:RELEASE kernel`; the normal full Dockerfile also includes the pinned QR dependencies. Transfer prebuilt images with `export-images.mjs` and `docker load`; do not build or install application dependencies on the VPS.

Run `node tests/mobile-api/login-resilience.mjs` only with the guarded isolated Compose fixture. `deploy/probe-login.py` performs bounded real-upstream checks inside a disposable Linux profile without reading or logging out the active user. Actual account confirmation must be completed by the account holder.

For this initial deployment an already-loaded kernel base was extended with prebuilt browser files and two Python source files using `Dockerfile.runtime-layer`, avoiding another large image upload. That operation only packages files; it does not compile the App or install dependencies on the VPS. Use `runtime-layer.dockerignore` as the upload staging directory's `.dockerignore` for this optional path. Normal future builds use the complete `kernel/Dockerfile` locally.

Transfer versioned image archives, source archive and these deployment files over authenticated SSH. Upload into `/home/ubuntu/bmusic-upload`, load the images with `docker load`, and run `sudo bash server-install.sh RELEASE`. The install script refuses an unmanaged `/opt/bmusic` and occupied initial ports. `release.env` contains `BMUSIC_RELEASE=RELEASE`; initial `data.tar.gz` contains only `app/` and `kernel/` snapshots. Source is retained under `/opt/bmusic/releases/RELEASE/source`.

TLS is obtained with Certbot webroot (not the Nginx editing plugin). Only the B-Music vhost is added. The renewal hook reloads Nginx only after this domain's certificate renews and `nginx -t` succeeds. Open the site directly, then use the App's Bilibili QR login when needed.

For rollback, retain the previous image tags and data backup, restore the previous `/opt/bmusic/.env` including any `BMUSIC_KERNEL_RELEASE` override, and run Compose for this project only. Never run global Docker prune/down commands or alter other projects' Nginx/Compose files. On a 1 GB VPS the kernel has a bounded memory/CPU budget and one simultaneous extraction; search remains parallel with that extraction. Audio itself is not cached in the App container.
