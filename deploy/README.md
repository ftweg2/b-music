# Isolated B-Music deployment

Production uses prebuilt Linux images, an isolated Compose project named `bmusic`, `/opt/bmusic` data/configuration, loopback ports 13100 (App) and 18100 (kernel), and its own `bmusic.ftwegc.com` Nginx virtual host. No existing site's files are replaced. The VPS does not run a Next development server or build the application.

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

`node deploy/create-access.mjs` generates a strong private gateway password in `deploy/private/access.json`. That directory is ignored by Git and excluded from application images. Native API clients send the gateway's Basic Authorization header; this is separate from Bilibili login. All API, QR and media routes are protected, and the extraction kernel is not publicly exposed.

`node deploy/prepare-data.mjs` snapshots the App and kernel databases plus audio cache into `deploy/private/seed-data`. It refuses to snapshot active local extraction jobs. It never exports the kernel browser profile or Cookie files; only the copied database is marked logged out. The original computer's login and data are unchanged. The VPS requires a fresh Bilibili QR login; use the same Bilibili account to see the migrated library and playback settings.

Each snapshot actually gets a unique `seed-data-UUID` directory, recorded in the private summary. Use the domain as the shared Base URL after migration; the retained localhost instance is a backup, not a second database that automatically synchronizes with the VPS.

The 1 GB VPS uses the branded Google Chrome for Testing Headless Shell 152.0.7977.82 through `PLAYWRIGHT_EXECUTABLE_PATH`. AAC/MSE support was explicitly checked; Playwright's unbranded bundled headless shell was rejected because its AAC check was false. The full Chrome channel remains installed as a fallback. This changes the browser runtime footprint, not the App's API or music features. The upstream binary comes from Google's versioned Chrome for Testing distribution over verified HTTPS.

Only B-Music containers are prevented from swapping; the host's existing swap configuration is not changed. Their hard RAM limits and elevated OOM scores isolate failures from other projects. QR preparation has a 60-second server budget on this VPS and a 90-second client request budget; expiry after QR generation remains unchanged.

For this initial deployment an already-loaded kernel base was extended with prebuilt browser files and two Python source files using `Dockerfile.runtime-layer`, avoiding another large image upload. That operation only packages files; it does not compile the App or install dependencies on the VPS. Use `runtime-layer.dockerignore` as the upload staging directory's `.dockerignore` for this optional path. Normal future builds use the complete `kernel/Dockerfile` locally.

Transfer versioned image archives, source archive and these deployment files over authenticated SSH. Upload into `/home/ubuntu/bmusic-upload`, load the images with `docker load`, and run `sudo bash server-install.sh RELEASE`. The install script refuses an unmanaged `/opt/bmusic` and occupied initial ports. `release.env` contains `BMUSIC_RELEASE=RELEASE`; initial `data.tar.gz` contains only `app/` and `kernel/` snapshots. Source is retained under `/opt/bmusic/releases/RELEASE/source`.

TLS is obtained with Certbot webroot (not the Nginx editing plugin). Only the B-Music vhost is added. The renewal hook reloads Nginx only after this domain's certificate renews and `nginx -t` succeeds. Read the generated private access file to log in to the site; do not publish its contents.

For rollback, retain the previous image tags and data backup, restore the previous `BMUSIC_RELEASE` in `/opt/bmusic/.env`, and run Compose for this project only. Never run global Docker prune/down commands or alter other projects' Nginx/Compose files. On a 1 GB VPS the kernel has a bounded memory/CPU budget and one simultaneous extraction; search remains parallel with that extraction. Audio itself is not cached in the App container.
