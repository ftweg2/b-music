from __future__ import annotations

import argparse
import json
import time

import httpx


TERMINAL = {"succeeded", "failed", "cancelled"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Poll a kernel job until terminal state.")
    parser.add_argument("--base-url", default="http://localhost:8000")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--interval", type=float, default=2.0)
    args = parser.parse_args()

    while True:
        response = httpx.get(f"{args.base_url}/v1/jobs/{args.job_id}", timeout=30)
        response.raise_for_status()
        payload = response.json()
        print(json.dumps(payload, indent=2))
        if payload["status"] in TERMINAL:
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
