"""Rate-limit prebuilt image import while monitoring the primary service.

This loads an archive; it never builds an image or installs dependencies.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
import threading
import urllib.request


def headroom():
    memory = int(next(line.split()[1] for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith("MemAvailable:"))) / 1024
    started = time.monotonic()
    with urllib.request.urlopen("http://127.0.0.1:8045/", timeout=2) as response:
        if response.status != 200:
            raise RuntimeError("Primary service health failed")
        response.read()
    if memory < 220 or time.monotonic() - started > 1.5:
        raise RuntimeError("Primary service headroom is low; image import aborted")
    return memory


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("sha256")
    args = parser.parse_args()
    digest = hashlib.sha256()
    with args.archive.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != args.sha256:
        raise RuntimeError("Image archive checksum mismatch")
    headroom()
    process = subprocess.Popen(["nice", "-n", "19", "ionice", "-c", "3", "docker", "load"], stdin=subprocess.PIPE)
    start = last_check = time.monotonic()
    total = 0
    done = threading.Event()
    monitor_errors = []
    def monitor():
        while not done.wait(2):
            try:
                headroom()
            except Exception as error:
                monitor_errors.append(str(error))
                process.terminate()
                return
    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    try:
        with args.archive.open("rb") as source:
            for chunk in iter(lambda: source.read(128 * 1024), b""):
                if time.monotonic() - last_check >= 2:
                    memory = headroom()
                    print(json.dumps({"imported_mib": round(total / 2**20, 1), "available_mib": round(memory, 1)}), flush=True)
                    last_check = time.monotonic()
                process.stdin.write(chunk)
                total += len(chunk)
                delay = total / (4 * 2**20) - (time.monotonic() - start)
                if delay > 0:
                    time.sleep(min(delay, 0.25))
        process.stdin.close()
        while process.poll() is None:
            headroom()
            time.sleep(1)
        if monitor_errors:
            raise RuntimeError(monitor_errors[0])
        if process.returncode != 0:
            raise RuntimeError("Docker load failed")
        print(json.dumps({"loaded": True, "bytes": total, "primary_http_healthy": True}))
    except BaseException:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
        raise
    finally:
        done.set()
        watcher.join(timeout=3)


if __name__ == "__main__":
    main()
