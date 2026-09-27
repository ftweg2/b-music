"""Give Antigravity priority while letting B-Music use whatever the host can spare.

Never stops, updates or reconfigures Antigravity. Uses only the local Docker
socket and a loopback HTTP health request. Every run (about 15 s):

* Pressure (host memory below 200 MiB, disk below 5 GiB, or Antigravity
  unhealthy): stop both B-Music containers and record why.
* Otherwise, while B-Music runs: move the kernel's RAM ceiling with the host's
  headroom, between 320 and 768 MiB, always leaving 300 MiB of host memory
  free. Lowering the ceiling pushes the kernel's excess into its swap allowance;
  it does not kill it. CPU needs no guard: Compose gives B-Music a low CPU
  weight and no fixed cap, so it only uses cores Antigravity leaves idle.
* After a guard stop: restart B-Music once Antigravity has been healthy with
  at least 450 MiB free for five minutes. After three automatic restarts in six
  hours the pause is latched for operator review. Containers stopped by an
  operator, or while `private/priority-hold` exists, are never started.
"""
import datetime
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import time
import urllib.request

ROOT = Path("/opt/bmusic")
PRIMARY = "antigravity-manager"
KERNEL = "bmusic-kernel-1"
APP = "bmusic-app-1"
MUSIC = (APP, KERNEL)
MIB = 1024 * 1024

PAUSE_MEMORY_MIB = 200
PAUSE_DISK_GIB = 5
RESUME_MEMORY_MIB = 450
RESUME_DISK_GIB = 6
RESUME_STABLE_SECONDS = 300
MAX_AUTO_RESUMES = 3
AUTO_RESUME_WINDOW_SECONDS = 6 * 3600

KERNEL_FLOOR_MIB = 320
KERNEL_CEILING_MIB = 768
KERNEL_SWAP_MIB = 512
HOST_RESERVE_MIB = 300
# Lowering reacts to 32 MiB so Antigravity gets memory back quickly; raising waits
# for 96 MiB so normal idle fluctuation does not move the ceiling back and forth.
LOWER_STEP_MIB = 32
RAISE_STEP_MIB = 96
EVENT_LOG_MAX_BYTES = 512 * 1024


class DockerConnection(http.client.HTTPConnection):
    def __init__(self, timeout=5):
        super().__init__("localhost", timeout=timeout)
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/var/run/docker.sock")


def docker(method, path, timeout=5, body=None):
    connection = DockerConnection(timeout)
    try:
        payload = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        connection.request(method, path, body=payload, headers=headers)
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


def memory_usage_mib(name):
    """Memory the container holds beyond its page cache. The cache is reclaimable and
    already part of the host's MemAvailable, so counting it here would count it twice."""
    stats = docker("GET", "/containers/" + name + "/stats?stream=false&one-shot=true", timeout=10)
    memory = (stats or {}).get("memory_stats") or {}
    cache = int((memory.get("stats") or {}).get("file") or 0)
    return max(0, int(memory.get("usage") or 0) - cache) / MIB


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


def verify_owned(containers):
    for name, container in containers:
        if (name not in MUSIC or container.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") != "bmusic"
                or container.get("Name", "").lstrip("/") != name):
            raise RuntimeError("Refusing to act on an unowned container")


def pause_targets(containers):
    verify_owned(containers)
    for name, container in containers:
        if container["State"]["Running"]:
            docker("POST", "/containers/" + name + "/stop?t=10", timeout=15)


def resume_targets(containers):
    verify_owned(containers)
    # The App depends on a healthy kernel, so the kernel starts first.
    for name in (KERNEL, APP):
        if any(owned == name for owned, _ in containers):
            docker("POST", "/containers/" + name + "/start", timeout=30)


def pressure_reasons(memory, disk, primary):
    reasons = []
    if memory < PAUSE_MEMORY_MIB:
        reasons.append("host available memory below 200 MiB")
    if disk < PAUSE_DISK_GIB:
        reasons.append("host free disk below 5 GiB")
    if not primary:
        reasons.append("primary service health check failed")
    return reasons


def kernel_memory_target(usage_mib, available, current_limit_mib):
    """The kernel may grow into host memory above the reserve, within floor/ceiling."""
    target = usage_mib + available - HOST_RESERVE_MIB
    target = int(max(KERNEL_FLOOR_MIB, min(KERNEL_CEILING_MIB, target))) // 16 * 16
    if current_limit_mib and current_limit_mib - LOWER_STEP_MIB < target < current_limit_mib + RAISE_STEP_MIB:
        return None
    return target


def adjust_kernel_memory(containers, available):
    kernel = dict(containers).get(KERNEL)
    if not kernel or not kernel["State"]["Running"]:
        return None
    verify_owned([(KERNEL, kernel)])
    current = int(kernel.get("HostConfig", {}).get("Memory") or 0) / MIB
    target = kernel_memory_target(memory_usage_mib(KERNEL), available, current)
    if target is None:
        return None
    docker("POST", "/containers/" + KERNEL + "/update", timeout=15,
           body={"Memory": target * MIB, "MemorySwap": (target + KERNEL_SWAP_MIB) * MIB})
    return {"from_mib": round(current), "to_mib": target}


def private_dir():
    return ROOT / "private"


def load_state():
    try:
        return json.loads((private_dir() / "priority-state.json").read_text())
    except (FileNotFoundError, ValueError):
        return {}


def write_private(name, value):
    descriptor = os.open(private_dir() / name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(value, output, indent=2)


def record_event(action, **details):
    event = {"at": datetime.datetime.now(datetime.UTC).isoformat(), "action": action, **details}
    log = private_dir() / "priority-events.jsonl"
    if log.exists() and log.stat().st_size > EVENT_LOG_MAX_BYTES:
        log.replace(private_dir() / "priority-events.1.jsonl")
    descriptor = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(descriptor, "a") as output:
        output.write(json.dumps(event) + "\n")
    print(json.dumps(event))
    return event


def main(now=None):
    now = time.time() if now is None else now
    if not (ROOT / ".managed-by-bmusic").is_file():
        raise RuntimeError("Unmanaged B-Music root")
    containers = [(name, inspect(name)) for name in MUSIC]
    containers = [(name, container) for name, container in containers if container]
    if not containers:
        return
    state = load_state()
    memory = available_mib()
    disk = shutil.disk_usage(ROOT).free / 2**30
    primary = primary_ok(inspect(PRIMARY))
    reasons = pressure_reasons(memory, disk, primary)
    measurements = {"available_mib": round(memory, 1), "free_disk_gib": round(disk, 2)}

    if any(container["State"]["Running"] for _, container in containers):
        if reasons:
            pause_targets(containers)
            event = record_event("paused-bmusic-only", reasons=reasons, **measurements)
            write_private("priority-pause.json", event)
            state.update(paused_by_guard=True, paused_at=now, healthy_since=None)
            write_private("priority-state.json", state)
            return
        if state.get("paused_by_guard"):
            # An operator started B-Music again; the guard's pause is over.
            state.update(paused_by_guard=False, healthy_since=None)
            write_private("priority-state.json", state)
        change = adjust_kernel_memory(containers, memory)
        if change:
            record_event("kernel-memory-ceiling", **change, **measurements)
        return

    if not state.get("paused_by_guard") or state.get("latched") or (private_dir() / "priority-hold").exists():
        return
    if reasons or memory < RESUME_MEMORY_MIB or disk < RESUME_DISK_GIB:
        if state.get("healthy_since") is not None:
            state["healthy_since"] = None
            write_private("priority-state.json", state)
        return
    if state.get("healthy_since") is None:
        state["healthy_since"] = now
        write_private("priority-state.json", state)
        return
    if now - state["healthy_since"] < RESUME_STABLE_SECONDS:
        return
    resumes = [at for at in state.get("resumes", []) if now - at < AUTO_RESUME_WINDOW_SECONDS]
    if len(resumes) >= MAX_AUTO_RESUMES:
        state.update(latched=True, resumes=resumes)
        write_private("priority-state.json", state)
        record_event("latched-needs-operator", automatic_resumes=len(resumes), **measurements)
        return
    resume_targets(containers)
    state.update(paused_by_guard=False, healthy_since=None, resumes=resumes + [now])
    write_private("priority-state.json", state)
    record_event("resumed-bmusic", automatic_resumes=len(resumes) + 1, **measurements)


if __name__ == "__main__":
    main()
