"""Install prebuilt B-Music images on the inspected Antigravity host. No builds."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.request

ROOT = Path("/opt/bmusic")
CADDY = Path("/opt/antigravity/Caddyfile")
DOMAIN = "bmusic.ftwegc.com"


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def inspect(name):
    value = json.loads(subprocess.check_output(["docker", "inspect", name]))[0]
    return {"id": value["Id"], "image": value["Image"], "started": value["State"]["StartedAt"],
            "restarts": value["RestartCount"], "oom": value["State"]["OOMKilled"],
            "running": value["State"]["Running"], "health": value["State"].get("Health", {}).get("Status"),
            "memory": value["HostConfig"]["Memory"], "swap": value["HostConfig"]["MemorySwap"],
            "cpu": value["HostConfig"]["NanoCpus"], "oom_score": value["HostConfig"]["OomScoreAdj"]}


def http_health():
    with urllib.request.urlopen("http://127.0.0.1:8045/", timeout=3) as response:
        body = response.read()
        return {"status": response.status, "sha256": hashlib.sha256(body).hexdigest()}


def assert_primary(before):
    current = inspect("antigravity-manager")
    for key in ("id", "image", "started", "restarts", "memory", "swap", "cpu", "oom_score"):
        if current[key] != before[key]:
            raise RuntimeError("Primary service changed during deployment: " + key)
    if not current["running"] or current["health"] != "healthy" or current["oom"]:
        raise RuntimeError("Primary service is not healthy")
    if http_health()["status"] != 200:
        raise RuntimeError("Primary HTTP health failed")
    return current


def private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(value, handle, indent=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("release")
    parser.add_argument("stage", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.release) or os.geteuid() != 0:
        raise RuntimeError("Invalid release or user")
    if ROOT.is_symlink() or (ROOT.exists() and not (ROOT / ".managed-by-bmusic").is_file()):
        raise RuntimeError("Refusing unmanaged deployment root")
    if ROOT.exists() and (ROOT / ".managed-by-bmusic").read_text().strip() != DOMAIN:
        raise RuntimeError("Deployment marker mismatch")
    stage = args.stage.resolve()
    for service in ("app", "kernel"):
        image = json.loads(subprocess.check_output(["docker", "image", "inspect", f"bmusic-{service}:{args.release}"]))[0]
        if image["Architecture"] != "amd64" or image["Os"] != "linux":
            raise RuntimeError("Wrong image platform")
    before = inspect("antigravity-manager")
    assert_primary(before)
    memory = int(next(line.split()[1] for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith("MemAvailable:"))) / 1024
    if memory < 350 or shutil.disk_usage("/opt").free < 5 * 2**30:
        raise RuntimeError("Insufficient host headroom; primary service takes priority")
    original_caddy = CADDY.read_bytes()
    block = (stage / "bmusic.caddy").read_bytes()
    if DOMAIN.encode() in original_caddy:
        raise RuntimeError("Domain already exists; refusing an unreviewed replacement")
    suffix = b"\n\n" + block
    candidate = original_caddy + suffix
    run(["docker", "exec", "-i", "-w", "/etc/caddy", "antigravity-caddy", "caddy", "validate",
         "--config", "-", "--adapter", "caddyfile"], input=candidate)
    for path in (ROOT, ROOT / "private", ROOT / "data", ROOT / "data/app", ROOT / "data/kernel", ROOT / "releases" / args.release):
        if path.is_symlink():
            raise RuntimeError("Unsafe deployment path")
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(0o750 if path.name != "private" else 0o700)
    (ROOT / ".managed-by-bmusic").write_text(DOMAIN + "\n")
    os.chown(ROOT / "data/app", 10001, 10001)
    for name in ("compose.yml", "compose.antigravity-safe.yml", "priority-guard.py", "bmusic.caddy"):
        shutil.copyfile(stage / name, ROOT / name)
    (ROOT / ".env").write_text("BMUSIC_RELEASE=" + args.release + "\n")
    (ROOT / ".env").chmod(0o600)
    backup = ROOT / "private" / ("caddy-before-" + args.release + ".conf")
    if backup.exists():
        raise RuntimeError("Release backup already exists")
    backup.write_bytes(original_caddy)
    backup.chmod(0o600)
    baseline = {"primary": before, "primary_http": http_health(), "caddy": inspect("antigravity-caddy"),
                "caddy_sha256": hashlib.sha256(original_caddy).hexdigest(), "release": args.release}
    private_json(ROOT / "private" / ("before-" + args.release + ".json"), baseline)
    if (stage / "source.tar.gz").is_file():
        shutil.copyfile(stage / "source.tar.gz", ROOT / "releases" / args.release / "source.tar.gz")
    compose = ["docker", "compose", "--project-directory", str(ROOT), "--env-file", str(ROOT / ".env"),
               "-p", "bmusic", "-f", str(ROOT / "compose.yml"), "-f", str(ROOT / "compose.antigravity-safe.yml")]
    run(compose + ["config", "--quiet"])
    for name in ("bmusic-priority-guard.service", "bmusic-priority-guard.timer"):
        target = Path("/etc/systemd/system") / name
        if target.exists():
            raise RuntimeError("Guard unit already exists; needs explicit review")
        shutil.copyfile(stage / name, target)
        target.chmod(0o644)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", "bmusic-priority-guard.timer"])
    changed_caddy = False
    try:
        run(compose + ["up", "-d", "--pull", "never", "--wait", "--wait-timeout", "180"])
        assert_primary(before)
        run(["python3", str(ROOT / "priority-guard.py")])
        with urllib.request.urlopen("http://127.0.0.1:13100/api/health", timeout=10) as response:
            if response.status != 200:
                raise RuntimeError("App health failed")
        if CADDY.read_bytes() != original_caddy:
            raise RuntimeError("Caddy was edited concurrently; refusing overwrite")
        # Keep the existing single-file bind mount's inode. Caddy does not watch
        # this file; only the explicit validated graceful reload activates it.
        changed_caddy = True
        with CADDY.open("ab") as handle:
            handle.write(suffix)
            handle.flush()
            os.fsync(handle.fileno())
        if CADDY.read_bytes() != candidate:
            raise RuntimeError("Caddy changed concurrently during append")
        run(["docker", "exec", "antigravity-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"])
        time.sleep(2)
        after = assert_primary(before)
        caddy_after = inspect("antigravity-caddy")
        if any(caddy_after[key] != baseline["caddy"][key] for key in ("id", "started", "restarts", "image")):
            raise RuntimeError("Caddy process unexpectedly restarted")
        if http_health() != baseline["primary_http"]:
            raise RuntimeError("Primary HTTP response changed")
        record = {"installed": True, "release": args.release, "primary_unchanged": True,
                  "caddy_original_prefix_unchanged": CADDY.read_bytes().startswith(original_caddy),
                  "primary": after, "caddy": caddy_after, "tls_external_verification": "pending"}
        private_json(ROOT / "private" / ("installed-" + args.release + ".json"), record)
        print(json.dumps(record))
    except BaseException:
        subprocess.run(compose + ["stop", "-t", "10"], check=False)
        if changed_caddy:
            current = CADDY.read_bytes()
            if not current.startswith(original_caddy) or not suffix.startswith(current[len(original_caddy):]):
                raise RuntimeError("Concurrent Caddy edit detected; music stopped, manual rollback review required")
            with CADDY.open("r+b") as handle:
                handle.truncate(len(original_caddy))
                handle.flush()
                os.fsync(handle.fileno())
            run(["docker", "exec", "antigravity-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"])
        raise


if __name__ == "__main__":
    main()
