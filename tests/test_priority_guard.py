import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("bmusic_priority_guard", Path(__file__).parents[1] / "deploy/priority-guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def container(name, project="bmusic", running=True, memory_mib=320):
    return {"Name": "/" + name, "Config": {"Labels": {"com.docker.compose.project": project}},
            "State": {"Running": running}, "HostConfig": {"Memory": memory_mib * guard.MIB}}


def test_pause_only_targets_owned_music_containers(monkeypatch):
    calls = []
    monkeypatch.setattr(guard, "docker", lambda method, path, **_kwargs: calls.append((method, path)))
    guard.pause_targets([(name, container(name)) for name in guard.MUSIC])
    assert calls == [("POST", "/containers/" + name + "/stop?t=10") for name in guard.MUSIC]


@pytest.mark.parametrize("name,project", [("antigravity-manager", "bmusic"), ("bmusic-app-1", "other-project")])
def test_unowned_container_rejected_before_any_stop(monkeypatch, name, project):
    calls = []
    monkeypatch.setattr(guard, "docker", lambda *args, **kwargs: calls.append(args))
    with pytest.raises(RuntimeError, match="unowned"):
        guard.pause_targets([("bmusic-kernel-1", container("bmusic-kernel-1")), (name, container(name, project))])
    assert calls == []


def test_low_memory_pauses_music_without_touching_primary(tmp_path, monkeypatch):
    (tmp_path / ".managed-by-bmusic").write_text("bmusic.ftwegc.com\n")
    (tmp_path / "private").mkdir()
    monkeypatch.setattr(guard, "ROOT", tmp_path)
    monkeypatch.setattr(guard, "available_mib", lambda: 150)
    monkeypatch.setattr(guard, "inspect", lambda name: container(name))
    monkeypatch.setattr(guard, "primary_ok", lambda value: True)
    stopped = []
    monkeypatch.setattr(guard, "pause_targets", lambda values: stopped.extend(name for name, _ in values))
    guard.main()
    assert stopped == list(guard.MUSIC)
    assert (tmp_path / "private/priority-pause.json").is_file()


class Host:
    """A fake host: Docker calls are recorded, measurements are set per test."""

    def __init__(self, tmp_path, monkeypatch, running=True, memory=500.0, primary=True, kernel_usage=150.0, kernel_limit=320):
        (tmp_path / ".managed-by-bmusic").write_text("bmusic.ftwegc.com\n")
        (tmp_path / "private").mkdir(exist_ok=True)
        self.calls = []
        self.running = running
        self.memory = memory
        self.primary = primary
        self.kernel_usage = kernel_usage
        self.kernel_limit = kernel_limit
        monkeypatch.setattr(guard, "ROOT", tmp_path)
        monkeypatch.setattr(guard, "available_mib", lambda: self.memory)
        monkeypatch.setattr(guard, "primary_ok", lambda _value: self.primary)
        monkeypatch.setattr(guard, "memory_usage_mib", lambda _name: self.kernel_usage)
        monkeypatch.setattr(guard, "inspect", self.inspect)
        monkeypatch.setattr(guard, "docker", self.docker)
        self.root = tmp_path

    def inspect(self, name):
        if name == guard.PRIMARY:
            return container(name, project="antigravity")
        return container(name, running=self.running, memory_mib=self.kernel_limit if name == guard.KERNEL else 256)

    def docker(self, method, path, timeout=5, body=None):
        self.calls.append((method, path, body))
        if path.endswith("/stop?t=10"):
            self.running = False
        if path.endswith("/start"):
            self.running = True
        return {}

    def state(self):
        path = self.root / "private/priority-state.json"
        return guard.json.loads(path.read_text()) if path.exists() else {}

    def events(self):
        path = self.root / "private/priority-events.jsonl"
        return [guard.json.loads(line)["action"] for line in path.read_text().splitlines()] if path.exists() else []


@pytest.mark.parametrize(
    ("usage", "available", "current", "expected"),
    [
        (150, 600, 320, 448),    # room to grow: usage + available - 300 reserve, in 16 MiB steps
        (300, 900, 320, 768),    # capped at the ceiling
        (300, 250, 768, 320),    # Antigravity needs memory: back to the floor
        (150, 480, 320, None),   # change below the 32 MiB step is ignored
        (150, 550, 320, None),   # growth waits for 96 MiB of headroom
        (150, 614, 496, 464),    # shrinking reacts to 32 MiB
    ],
)
def test_kernel_memory_target(usage, available, current, expected):
    assert guard.kernel_memory_target(usage, available, current) == expected


def test_kernel_usage_excludes_page_cache_already_in_host_available(monkeypatch):
    # Observed on the VPS: 256 MiB usage, of which 181 MiB was page cache.
    stats = {"memory_stats": {"usage": 256 * guard.MIB, "stats": {"file": 181 * guard.MIB, "anon": 69 * guard.MIB}}}
    monkeypatch.setattr(guard, "docker", lambda *_args, **_kwargs: stats)
    assert guard.memory_usage_mib(guard.KERNEL) == 75


def test_idle_fluctuation_does_not_move_the_ceiling_back_and_forth():
    # Observed on the VPS: available memory drifting by ~30 MiB flipped 496 <-> 528.
    current = 496
    for available in (727.9, 764.7, 735.7, 759.4, 740.0):
        assert guard.kernel_memory_target(70, available, current) is None


def test_idle_host_lets_the_kernel_grow_without_touching_the_app_or_primary(tmp_path, monkeypatch):
    host = Host(tmp_path, monkeypatch, memory=600, kernel_usage=200, kernel_limit=320)

    guard.main(now=1000)

    assert host.calls == [("POST", "/containers/bmusic-kernel-1/update",
                           {"Memory": 496 * guard.MIB, "MemorySwap": (496 + 512) * guard.MIB})]
    assert host.events() == ["kernel-memory-ceiling"]


def test_primary_needing_memory_pushes_the_kernel_back_to_its_floor(tmp_path, monkeypatch):
    host = Host(tmp_path, monkeypatch, memory=260, kernel_usage=500, kernel_limit=768)

    guard.main(now=1000)

    assert host.calls[-1][2]["Memory"] == 448 * guard.MIB
    host.memory, host.kernel_usage, host.kernel_limit = 210, 300, 448
    guard.main(now=1015)
    assert host.calls[-1][2]["Memory"] == 320 * guard.MIB


def test_pressure_stops_music_then_resumes_after_five_healthy_minutes(tmp_path, monkeypatch):
    host = Host(tmp_path, monkeypatch, memory=150)

    guard.main(now=1000)
    assert host.running is False
    assert host.state()["paused_by_guard"] is True

    host.memory = 500
    guard.main(now=1015)                  # healthy streak starts
    guard.main(now=1015 + 299)            # not yet five minutes
    assert host.running is False
    guard.main(now=1015 + 300)
    assert host.running is True
    starts = [path for method, path, _ in host.calls if path.endswith("/start")]
    assert starts == ["/containers/bmusic-kernel-1/start", "/containers/bmusic-app-1/start"]
    assert host.events() == ["paused-bmusic-only", "resumed-bmusic"]
    assert host.state()["paused_by_guard"] is False


def test_resume_needs_more_headroom_than_the_pause_line(tmp_path, monkeypatch):
    host = Host(tmp_path, monkeypatch, memory=150)
    guard.main(now=1000)

    host.memory = 300                     # above 200 but below the 450 MiB resume line
    for second in range(1015, 2000, 15):
        guard.main(now=second)
    assert host.running is False


def test_a_dip_during_the_healthy_window_restarts_the_wait(tmp_path, monkeypatch):
    host = Host(tmp_path, monkeypatch, memory=150)
    guard.main(now=1000)
    host.memory = 500
    guard.main(now=1015)
    host.primary = False
    guard.main(now=1200)
    host.primary = True
    guard.main(now=1215)
    guard.main(now=1015 + 300)
    assert host.running is False
    guard.main(now=1215 + 300)
    assert host.running is True


def test_repeated_pressure_latches_for_the_operator(tmp_path, monkeypatch):
    host = Host(tmp_path, monkeypatch)
    now = 1000
    for _ in range(guard.MAX_AUTO_RESUMES):
        host.memory = 150
        guard.main(now=now)
        host.memory = 500
        guard.main(now=now + 15)
        guard.main(now=now + 315)
        assert host.running is True
        now += 400
    host.memory = 150
    guard.main(now=now)
    host.memory = 500
    guard.main(now=now + 15)
    guard.main(now=now + 315)

    assert host.running is False
    assert host.state()["latched"] is True
    assert host.events()[-1] == "latched-needs-operator"


def test_operator_stopped_music_is_never_started(tmp_path, monkeypatch):
    host = Host(tmp_path, monkeypatch, running=False, memory=900)

    for second in range(1000, 2000, 15):
        guard.main(now=second)

    assert host.calls == []


def test_hold_file_keeps_a_guard_pause_in_place(tmp_path, monkeypatch):
    host = Host(tmp_path, monkeypatch, memory=150)
    guard.main(now=1000)
    (tmp_path / "private/priority-hold").write_text("keep stopped\n")
    host.memory = 900

    for second in range(1015, 2000, 15):
        guard.main(now=second)

    assert host.running is False


def test_manual_restart_clears_the_guard_pause(tmp_path, monkeypatch):
    host = Host(tmp_path, monkeypatch, memory=150)
    guard.main(now=1000)
    host.running = True                   # operator ran `docker compose up`
    host.memory = 500

    guard.main(now=1015)

    assert host.state()["paused_by_guard"] is False


def test_start_and_update_refuse_unowned_containers(monkeypatch):
    calls = []
    monkeypatch.setattr(guard, "docker", lambda *args, **kwargs: calls.append(args))
    with pytest.raises(RuntimeError, match="unowned"):
        guard.resume_targets([("bmusic-kernel-1", container("bmusic-kernel-1", project="antigravity"))])
    with pytest.raises(RuntimeError, match="unowned"):
        guard.adjust_kernel_memory([("bmusic-kernel-1", container("bmusic-kernel-1", project="other"))], 900)
    assert calls == []
