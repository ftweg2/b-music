import asyncio
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import init_db
from app.douyin import covers
from app.douyin.covers import cover_path, image_extension, is_allowed_cover_url, store_cover
from app.douyin.detail import DouyinAweme, parse_aweme_detail
from app.main import app
from app.profile_manager import create_or_get_profile


AWEME_ID = "7684625501147732905"
SIGNED = (
    "https://p3-pc-sign.douyinpic.com/image-cut-tos-priv/abc~tplv-dy-resize-origshort-autoq-75:330"
    "?x-expires=1790000000&x-signature=secret"
)
BACKUP = "https://p9-pc-sign.douyinpic.com/tos-cn-p-0015/abc~tplv-dy-360p.jpeg?x-signature=secret"
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01" + b"\x00" * 64


def make_settings(tmp_path):
    return replace(
        get_settings(),
        data_dir=tmp_path,
        db_path=tmp_path / "kernel.sqlite3",
        artifacts_dir=tmp_path / "artifacts",
        profiles_dir=tmp_path / "profiles",
    )


def aweme(cover_urls) -> DouyinAweme:
    return DouyinAweme(aweme_id=AWEME_ID, desc="", author=None, duration_seconds=None, music=None, cover_urls=list(cover_urls))


def run_store(settings, item, handler):
    return asyncio.run(store_cover(item, settings, transport=httpx.MockTransport(handler)))


def test_detail_keeps_cover_urls_for_kernel_use_only() -> None:
    parsed = parse_aweme_detail({"aweme_detail": {
        "aweme_id": AWEME_ID,
        "video": {"cover": {"url_list": [SIGNED]}, "origin_cover": {"url_list": [BACKUP, SIGNED]}},
    }}, AWEME_ID)

    assert parsed.cover_urls == [SIGNED, BACKUP]


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        (SIGNED, True),
        ("https://p3-pc.douyinpic.com/img/abc.jpeg", True),
        ("http://p3-pc-sign.douyinpic.com/abc", False),
        ("https://douyinpic.com.evil.example/abc", False),
        ("https://user@p3-pc-sign.douyinpic.com/abc", False),
        ("https://lf3-music-east.douyinstatic.com/a.mp3", False),
    ],
)
def test_cover_host_allowlist(url, allowed) -> None:
    assert is_allowed_cover_url(url) is allowed


def test_cover_is_cached_once_from_the_page_supplied_url(tmp_path) -> None:
    settings = make_settings(tmp_path)
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "image/jpeg"}, content=JPEG)

    assert run_store(settings, aweme([SIGNED]), handler) is True
    assert run_store(settings, aweme([SIGNED]), handler) is True

    assert len(requested) == 1
    stored = cover_path(AWEME_ID, settings)
    assert stored is not None and stored.name == f"{AWEME_ID}.jpg"
    assert stored.read_bytes() == JPEG


def test_failed_cover_mirror_falls_back_to_the_next(tmp_path) -> None:
    settings = make_settings(tmp_path)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host.startswith("p3"):
            return httpx.Response(403, content=b"forbidden")
        return httpx.Response(200, headers={"content-type": "image/jpeg"}, content=JPEG)

    assert run_store(settings, aweme([SIGNED, BACKUP]), handler) is True


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, headers={"content-type": "text/html"}, content=b"<html>error</html>"),
        httpx.Response(200, headers={"content-type": "image/jpeg"}, content=b"<html>not really</html>"),
        httpx.Response(200, headers={"content-type": "image/svg+xml"}, content=b"<svg></svg>"),
        httpx.Response(302, headers={"location": "https://evil.example/cover.jpg"}),
    ],
)
def test_non_images_and_foreign_redirects_are_not_cached(tmp_path, response) -> None:
    settings = make_settings(tmp_path)

    assert run_store(settings, aweme([SIGNED]), lambda _request: response) is False
    assert cover_path(AWEME_ID, settings) is None


def test_oversized_covers_are_refused(tmp_path, monkeypatch) -> None:
    settings = make_settings(tmp_path)
    monkeypatch.setattr(covers, "MAX_COVER_BYTES", 32)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "image/jpeg"}, content=JPEG)

    assert run_store(settings, aweme([SIGNED]), handler) is False


def test_untrusted_cover_hosts_are_never_requested(tmp_path) -> None:
    settings = make_settings(tmp_path)

    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not be requested")

    assert run_store(settings, aweme(["https://evil.example/cover.jpg"]), handler) is False


def test_cache_keeps_only_the_newest_covers(tmp_path, monkeypatch) -> None:
    settings = make_settings(tmp_path)
    monkeypatch.setattr(covers, "MAX_STORED_COVERS", 2)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "image/jpeg"}, content=JPEG)

    ids = ["7000000000000000001", "7000000000000000002", "7000000000000000003"]
    for index, aweme_id in enumerate(ids):
        item = DouyinAweme(aweme_id=aweme_id, desc="", author=None, duration_seconds=None, music=None, cover_urls=[SIGNED])
        run_store(settings, item, handler)
        path = cover_path(aweme_id, settings)
        import os
        os.utime(path, (1_000_000 + index, 1_000_000 + index))

    assert cover_path(ids[0], settings) is None
    assert cover_path(ids[2], settings) is not None


def test_image_signatures() -> None:
    assert image_extension(JPEG[:16]) == ".jpg"
    assert image_extension(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8) == ".png"
    assert image_extension(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == ".webp"
    assert image_extension(b"GIF89a" + b"\x00" * 10) == ".gif"
    assert image_extension(b"<svg xmlns=") is None


def test_cover_endpoint_serves_cached_images_only(tmp_path, monkeypatch) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    create_or_get_profile("owner", settings)
    monkeypatch.setattr("app.routers.douyin.get_settings", lambda: settings)
    directory = tmp_path / "douyin-covers"
    directory.mkdir()
    (directory / f"{AWEME_ID}.jpg").write_bytes(JPEG)
    client = TestClient(app)

    ok = client.get(f"/v1/douyin/covers/{AWEME_ID}", params={"external_owner_id": "owner"})
    missing = client.get("/v1/douyin/covers/7000000000000000009", params={"external_owner_id": "owner"})
    traversal = client.get("/v1/douyin/covers/..%2F..%2Fkernel.sqlite3", params={"external_owner_id": "owner"})
    no_owner = client.get(f"/v1/douyin/covers/{AWEME_ID}")

    assert ok.status_code == 200
    assert ok.headers["content-type"] == "image/jpeg"
    assert ok.headers["x-content-type-options"] == "nosniff"
    assert ok.content == JPEG
    assert missing.status_code == 404
    assert traversal.status_code in {400, 404}
    assert no_owner.status_code == 422


def test_resolve_reports_a_cached_cover_without_exposing_its_url(tmp_path, monkeypatch) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    monkeypatch.setattr("app.routers.douyin.get_settings", lambda: settings)

    async def fake_fetch(_aweme_id, _settings, _raise_if_cancelled=None):
        return aweme([SIGNED])

    async def fake_store(item, _settings):
        return item.cover_urls == [SIGNED]

    monkeypatch.setattr("app.routers.douyin.fetch_aweme_detail", fake_fetch)
    monkeypatch.setattr("app.routers.douyin.store_cover", fake_store)

    response = TestClient(app).post("/v1/douyin/resolve", json={
        "external_owner_id": "owner", "profile_id": profile["profile_id"],
        "url": f"https://www.douyin.com/video/{AWEME_ID}",
    })

    assert response.status_code == 200
    assert response.json()["has_cover"] is True
    assert "douyinpic" not in response.text and "signature" not in response.text
