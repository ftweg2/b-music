from __future__ import annotations

import re


# Covers, avatars, emotes (Bilibili's image CDN) and web fonts. Extraction pages
# never need them; skipping them saves renderer memory and bandwidth on small
# machines. Only these URLs are intercepted, so media and player requests keep
# their normal, unrouted network path.
DECORATIVE_URL = re.compile(
    r"^https?://i\d\.hdslb\.com/bfs/|\.(?:woff2?|ttf|otf)(?:$|[?#])",
    re.IGNORECASE,
)


async def skip_decorative_resources(page: object) -> None:
    await page.route(DECORATIVE_URL, _abort)


async def _abort(route: object) -> None:
    await route.abort()
