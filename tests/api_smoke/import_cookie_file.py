from __future__ import annotations

import argparse
import json
from pathlib import Path

import httpx


def main() -> None:
    parser = argparse.ArgumentParser(description="Import a local Cookie file through the kernel HTTP API.")
    parser.add_argument("--base-url", default="http://localhost:8000")
    parser.add_argument("--profile-id", required=True)
    parser.add_argument("--external-owner-id", required=True)
    parser.add_argument(
        "--format",
        choices=["cookie_header", "netscape", "json", "playwright_storage_state"],
        required=True,
    )
    parser.add_argument("--file", required=True)
    args = parser.parse_args()

    cookie_payload = Path(args.file).read_text(encoding="utf-8")
    response = httpx.post(
        f"{args.base_url}/v1/profiles/{args.profile_id}/cookies/import",
        json={
            "external_owner_id": args.external_owner_id,
            "format": args.format,
            "cookies": cookie_payload,
            "source_note": "manually provided by account owner",
        },
        timeout=120,
    )
    response.raise_for_status()
    print(json.dumps(response.json(), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
