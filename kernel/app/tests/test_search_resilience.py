import asyncio
from dataclasses import replace

import pytest

from app.bilibili.search import KernelSearchError, parse_search_payload, search_videos_with_profile, search_total_pages, _parse_duration, _parse_pub_time
from app.config import get_settings
from app.db import get_connection, init_db
from app.profile_manager import create_or_get_profile
from app.strategy_selector import select_strategy_order


@pytest.mark.parametrize("payload", [
    None, [], {"code": -412, "message": "blocked", "data": {"result": []}},
    {"code": 0, "data": None}, {"code": 0, "data": {"result": None}},
])
def test_invalid_upstream_responses_are_errors_not_empty_results(payload):
    with pytest.raises(KernelSearchError):
        parse_search_payload(payload, 1, 20)


def test_bad_rows_and_duplicate_videos_do_not_poison_valid_results():
    row = {"bvid": "BV1xx411c7mD", "title": "Music", "pubdate": 10**50}
    items, more = parse_search_payload({"code": 0, "data": {
        "result": [None, {}, row, row, {"bvid": "invalid"}], "numPages": 1,
    }}, 1, 20)
    assert len(items) == 1
    assert items[0]["pub_time"] is None
    assert more is False


def test_full_last_page_does_not_claim_another_page():
    result, more = parse_search_payload({"data": {
        "result": [{"bvid": "BV1xx411c7mD", "title": "Music"}], "numPages": 1,
    }}, 1, 1)
    assert len(result) == 1
    assert more is False


@pytest.mark.parametrize("value,expected", [("5", 5), (5, 5), (None, None), (True, None), (-1, None), (2.5, None)])
def test_page_count_metadata_is_normalized(value, expected):
    assert search_total_pages({"data": {"numPages": value, "result": []}}) == expected


def test_zero_page_count_does_not_hide_a_nonempty_next_page():
    payload = {"data": {"numPages": 0, "result": [{"bvid": "BV1xx411c7mD", "title": "Music"}]}}
    assert search_total_pages(payload) is None
    assert parse_search_payload(payload, 1, 1)[1] is True


def test_explicit_strategy_order_is_an_allowlist_without_hidden_fallback():
    assert select_strategy_order("auto", None, ["browser_network", "api_dash", "api_dash"]) == ["browser_network", "api_dash"]
    assert select_strategy_order("auto", None, None, available_strategies=["api_dash"]) == ["api_dash"]
    with pytest.raises(ValueError):
        select_strategy_order("auto", None, [])
    with pytest.raises(ValueError):
        select_strategy_order("auto", None, ["unknown"])
    with pytest.raises(ValueError):
        select_strategy_order("auto", None, None, available_strategies=[])


def test_malformed_durations_and_dates_are_not_invented():
    assert _parse_duration("1:bad:30") is None
    assert _parse_duration("1:90") is None
    assert _parse_duration("1:02:03") == 3723
    assert _parse_duration(float("inf")) is None
    assert _parse_pub_time(float("inf")) is None


def test_timed_out_browser_startup_releases_profile_lock(tmp_path, monkeypatch):
    settings = replace(get_settings(), data_dir=tmp_path, db_path=tmp_path / "kernel.sqlite3",
                       artifacts_dir=tmp_path / "artifacts", profiles_dir=tmp_path / "profiles")
    init_db(settings)
    profile = create_or_get_profile("owner", settings)

    class HungManager:
        def __init__(self, _settings):
            pass

        async def open_context(self, _profile_id):
            await asyncio.Future()

    monkeypatch.setattr("app.bilibili.search.BrowserContextManager", HungManager)
    with pytest.raises(KernelSearchError, match="timed out"):
        asyncio.run(search_videos_with_profile(external_owner_id="owner", profile_id=profile["profile_id"],
                                              keyword="music", limit=1, settings=settings, timeout_seconds=1))
    with get_connection(settings) as conn:
        stored = conn.execute("SELECT active_job_id FROM profiles WHERE profile_id=?", (profile["profile_id"],)).fetchone()
    assert stored["active_job_id"] is None
