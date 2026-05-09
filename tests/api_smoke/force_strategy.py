from __future__ import annotations

import argparse
import json

import httpx


def main() -> None:
    parser = argparse.ArgumentParser(description="Submit a force-mode extraction job.")
    parser.add_argument("--base-url", default="http://localhost:8000")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--profile-id", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument(
        "--strategy",
        choices=["api_dash", "browser_network", "mse_sourcebuffer"],
        required=True,
    )
    parser.add_argument("--outputs", nargs="+", default=["raw", "m4a"])
    args = parser.parse_args()

    response = httpx.post(
        f"{args.base_url}/v1/jobs",
        json={
            "job_id": args.job_id,
            "external_owner_id": args.owner,
            "profile_id": args.profile_id,
            "url": args.url,
            "strategy_mode": "force",
            "strategy": args.strategy,
            "outputs": args.outputs,
        },
        timeout=30,
    )
    response.raise_for_status()
    print(json.dumps(response.json(), indent=2))


if __name__ == "__main__":
    main()
