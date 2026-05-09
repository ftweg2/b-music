from __future__ import annotations

import argparse
import json

import httpx


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a profile or submit an auto-mode job.")
    parser.add_argument("--base-url", default="http://localhost:8000")
    parser.add_argument("--create-profile", action="store_true")
    parser.add_argument("--owner", required=True)
    parser.add_argument("--job-id")
    parser.add_argument("--profile-id")
    parser.add_argument("--url")
    parser.add_argument("--outputs", nargs="+", default=["raw", "m4a"])
    args = parser.parse_args()

    if args.create_profile:
        response = httpx.post(
            f"{args.base_url}/v1/profiles",
            json={"external_owner_id": args.owner},
            timeout=30,
        )
    else:
        missing = [name for name in ["job_id", "profile_id", "url"] if getattr(args, name.replace("-", "_"), None) is None]
        if missing:
            parser.error(f"missing required job fields: {', '.join(missing)}")
        response = httpx.post(
            f"{args.base_url}/v1/jobs",
            json={
                "job_id": args.job_id,
                "external_owner_id": args.owner,
                "profile_id": args.profile_id,
                "url": args.url,
                "strategy_mode": "auto",
                "strategy_order": ["api_dash", "browser_network", "mse_sourcebuffer"],
                "outputs": args.outputs,
            },
            timeout=30,
        )
    response.raise_for_status()
    print(json.dumps(response.json(), indent=2))


if __name__ == "__main__":
    main()
