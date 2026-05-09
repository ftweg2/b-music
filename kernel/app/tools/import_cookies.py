from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from app.db import init_db
from app.profile_manager import (
    CookieImportError,
    ProfileLockedError,
    ProfileNotFoundError,
    ProfileOwnershipError,
    import_cookies_to_profile,
)
from app.security import sanitize_text


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Import user-provided Bilibili cookies into a kernel-owned profile."
    )
    parser.add_argument("--profile-id", required=True)
    parser.add_argument("--external-owner-id", required=True)
    parser.add_argument(
        "--format",
        choices=["cookie_header", "netscape", "json", "playwright_storage_state"],
        required=True,
    )
    parser.add_argument("--file", required=True, help="Path to a local cookie file or mounted secret.")
    args = parser.parse_args()

    cookie_path = Path(args.file)
    payload = cookie_path.read_text(encoding="utf-8")
    try:
        init_db()
        result = asyncio.run(
            import_cookies_to_profile(
                profile_id=args.profile_id,
                external_owner_id=args.external_owner_id,
                format_name=args.format,
                cookies_payload=payload,
            )
        )
    except (CookieImportError, ProfileLockedError, ProfileOwnershipError, ProfileNotFoundError, ValueError) as exc:
        raise SystemExit(f"cookie import failed: {sanitize_text(exc)}") from exc

    print(
        json.dumps(
            {
                "profile_id": result.profile_id,
                "status": result.status,
                "logged_in": result.logged_in,
                "bili_uid": result.bili_uid,
                "nickname": result.nickname,
                "last_verified_at": result.last_verified_at,
                "message": result.message,
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
