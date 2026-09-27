# QR login reliability

The web/native API contract is unchanged: explicit start returns a PNG URL and a bounded lifetime; status returns only verified identity metadata. The kernel alone owns credentials. Users still scan and confirm in the Bilibili app.

## Why the previous flow failed

- The VPS trace showed preparation timing out during Playwright locator visibility checks in QR capture. The uncaught `TimeoutError` escaped the route as HTTP 500.
- Preparation loaded and rasterized the full passport page on a 512 MiB runtime.
- The watcher reloaded the page every 60 seconds, replacing the server's QR while clients kept displaying the original image.
- Image expiry used the session creation time, while the client countdown began only after slow preparation completed.

## Current flow

The kernel uses the generate/poll endpoints used by the [first-party login page](https://passport.bilibili.com/login). It renders the returned HTTPS Bilibili URL into a PNG using pinned pure-Python QR/PNG libraries, without navigating or screenshotting that page. The challenge key is held only in the private runtime and is excluded from runtime representations and API responses. No automatic token refresh or CAPTCHA bypass is implemented; upstream restrictions are surfaced explicitly.

Requests use the profile's existing [Playwright request context and shared cookie jar](https://playwright.dev/python/docs/api/class-apirequestcontext). Poll confirmation alone does not mark login successful: the kernel verifies the identity with Bilibili's nav endpoint. Cookies remain in that kernel browser profile; there is no App credential store or independent visitor authentication.

### HTTP-only runtime optimization

For new or migrated profiles, preparing/polling QR and authenticated search no
longer launch Chrome just to send HTTP requests. A standalone request context
owns the profile's active cookie jar. If Chrome is already serving an extraction,
readers share Chrome's request context instead. Transitions wait for existing
HTTP leases to drain, so there are never two independently mutating cookie jars.

Cookie changes are atomically persisted before an HTTP response can confirm login.
The private `http-session.json` journal stays inside that profile, has owner-only
permissions on Linux, and is excluded from exports along with the browser profile.
Its `browser` owner marker causes recovery from the persistent browser rather than
an older HTTP snapshot after an interrupted browser operation. Clean browser close
hands the latest cookies back to HTTP. Cookie deletions transfer too; browser
localStorage/IndexedDB are not copied or discarded. Logout clears the journal and
browser files only after leases close. Idle runtime entries drop credential-cache
references. No credentials or journal contents are added to App storage or APIs.

The existing start/poll/expiry/identity/error contracts remain unchanged. Legacy
profiles may require one browser startup for migration; this is not a guarantee
that every request on an older profile will immediately be browser-free.

- Concurrent starts and retries share one preparation; disconnecting a request does not duplicate the browser. Explicit logout/shutdown cancels preparation.
- Each PNG remains unchanged for its lifetime (at most 180 seconds, possibly shorter if Bilibili expires it). The image-read and client clocks begin at readiness.
- Polling is sequential and lifetime-bound. Up to three consecutive transient failures are tolerated with bounded backoff. Restrictions stop the flow without an automatic alternate access path.
- Timeout/unavailability errors carry a stable code and retry hint through the App API; ordinary upstream failures no longer become an unhandled HTTP 500.
- Expiry, cancellation and failures invalidate the QR and close the profile lease. An already verified account cannot be silently replaced by login/start.

## Verification

`app/tests/test_login_resilience.py` covers upstream responses, ownership/session lifecycle, cancellation, concurrent starts, transient failures, QR stability and typed HTTP errors. `tests/mobile-api/login-resilience.mjs` verifies the same boundaries through the actual Linux App/kernel images using the guarded isolated HTTP fixture.

`deploy/probe-login.py` makes two bounded real-upstream checks inside a disposable kernel profile. It never scans or confirms an account, prints no challenge/cookie values, and cleans up its test sessions. Real user confirmation remains a manual end-to-end step.
