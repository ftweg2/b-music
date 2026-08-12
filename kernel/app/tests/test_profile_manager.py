from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier

from app.config import Settings, get_settings
from app.db import get_connection, init_db
from app.profile_manager import create_or_get_profile


def test_create_or_get_profile_is_atomic_for_concurrent_requests(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    worker_count = 8
    barrier = Barrier(worker_count)

    def create_profile() -> dict[str, str]:
        barrier.wait()
        return create_or_get_profile("concurrent-owner", settings)

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        results = list(executor.map(lambda _: create_profile(), range(worker_count)))

    profile_ids = {result["profile_id"] for result in results}
    statuses = [result["status"] for result in results]

    assert len(profile_ids) == 1
    assert statuses.count("created") == 1
    assert statuses.count("exists") == worker_count - 1

    profile_id = next(iter(profile_ids))
    with get_connection(settings) as conn:
        rows = conn.execute(
            "SELECT profile_id, external_owner_id FROM profiles WHERE external_owner_id=?",
            ("concurrent-owner",),
        ).fetchall()
    assert [dict(row) for row in rows] == [
        {"profile_id": profile_id, "external_owner_id": "concurrent-owner"}
    ]
    assert (settings.profiles_dir / profile_id).is_dir()


def make_settings(tmp_path) -> Settings:
    return replace(
        get_settings(),
        data_dir=tmp_path,
        db_path=tmp_path / "kernel.sqlite3",
        artifacts_dir=tmp_path / "artifacts",
        profiles_dir=tmp_path / "profiles",
    )
