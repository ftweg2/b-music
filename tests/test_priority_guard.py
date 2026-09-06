import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("bmusic_priority_guard", Path(__file__).parents[1] / "deploy/priority-guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def container(name, project="bmusic", running=True):
    return {"Name": "/" + name, "Config": {"Labels": {"com.docker.compose.project": project}},
            "State": {"Running": running}}


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
