"""Protect the primary application; never stop/update/reconfigure Antigravity.

Uses only the local Docker socket and a loopback HTTP health request. A safety
pause is latched for operator review, rather than repeatedly restarting music.
"""
import datetime
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import urllib.request

ROOT = Path("/opt/bmusic")
PRIMARY = "antigravity-manager"
MUSIC = ("bmusic-app-1", "bmusic-kernel-1")


class DockerConnection(http.client.HTTPConnection):
    def __init__(self, timeout=5):
        super().__init__("localhost", timeout=timeout)
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/var/run/docker.sock")


def docker(method, path, timeout=5):
    connection = DockerConnection(timeout)
    try:
        connection.request(method, path)
        response = connection.getresponse()
        data = response.read()
        if response.status == 404:
            return None
        if response.status not in (200, 204, 304):
            raise RuntimeError("Docker operation failed with HTTP " + str(response.status))
        return json.loads(data) if data else {}
    finally:
        connection.close()


def inspect(name):
    return docker("GET", "/containers/" + name + "/json")


def available_mib():
    fields = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    return int(fields["MemAvailable"].split()[0]) / 1024


def primary_ok(container):
    if not container or not container["State"]["Running"]:
        return False
    health = container["State"].get("Health", {}).get("Status")
    if health not in (None, "healthy"):
        return False
    try:
        with urllib.request.urlopen("http://127.0.0.1:8045/", timeout=2) as response:
            return response.status == 200
    except Exception:
        return False


def pause_targets(containers):
    for name, container in containers:
        if (name not in MUSIC or container.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") != "bmusic"
                or container.get("Name", "").lstrip("/") != name):
            raise RuntimeError("Refusing to stop an unowned container")
    for name, container in containers:
        if container["State"]["Running"]:
            docker("POST", "/containers/" + name + "/stop?t=10", timeout=15)


def main():
    if not (ROOT / ".managed-by-bmusic").is_file():
        raise RuntimeError("Unmanaged B-Music root")
    containers = [(name, inspect(name)) for name in MUSIC]
    containers = [(name, container) for name, container in containers if container]
    if not any(container["State"]["Running"] for _, container in containers):
        return
    memory = available_mib()
    disk = shutil.disk_usage(ROOT).free / 2**30
    reasons = []
    if memory < 200:
        reasons.append("host available memory below 200 MiB")
    if disk < 5:
        reasons.append("host free disk below 5 GiB")
    if not primary_ok(inspect(PRIMARY)):
        reasons.append("primary service health check failed")
    if not reasons:
        return
    pause_targets(containers)
    record = {"at": datetime.datetime.now(datetime.UTC).isoformat(), "action": "paused-bmusic-only",
              "reasons": reasons, "available_mib": round(memory, 1), "free_disk_gib": round(disk, 2)}
    destination = ROOT / "private" / "priority-pause.json"
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(record, output, indent=2)
    print(json.dumps(record))


if __name__ == "__main__":
    main()
