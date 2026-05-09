from __future__ import annotations

import argparse
from pathlib import Path

import httpx


def main() -> None:
    parser = argparse.ArgumentParser(description="Download a job artifact.")
    parser.add_argument("--base-url", default="http://localhost:8000")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--output-dir", default=".")
    args = parser.parse_args()

    response = httpx.get(
        f"{args.base_url}/v1/jobs/{args.job_id}/artifacts/{args.name}",
        timeout=60,
    )
    response.raise_for_status()
    output_path = Path(args.output_dir) / args.name
    output_path.write_bytes(response.content)
    print(str(output_path.resolve()))


if __name__ == "__main__":
    main()
