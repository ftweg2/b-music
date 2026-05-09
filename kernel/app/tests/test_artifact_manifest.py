import hashlib
import json

from app.artifact_manager import build_artifact_record, write_artifact_manifest
from app.profile_manager import parse_cookie_import
from app.security import sanitize_dict, sanitize_text, sanitize_url


def test_artifact_record_includes_sha256(tmp_path) -> None:
    artifact = tmp_path / "raw.m4s"
    artifact.write_bytes(b"ctf-audio")

    record = build_artifact_record(artifact, "raw", "api_dash")

    assert record.sha256 == hashlib.sha256(b"ctf-audio").hexdigest()
    assert record.size_bytes == len(b"ctf-audio")


def test_manifest_includes_artifact_checksum(tmp_path) -> None:
    artifact = tmp_path / "raw.m4s"
    artifact.write_bytes(b"ctf-audio")
    record = build_artifact_record(artifact, "raw", "api_dash")

    manifest = write_artifact_manifest(tmp_path, [record], "api_dash")
    payload = json.loads((tmp_path / manifest.name).read_text(encoding="utf-8"))

    assert payload["artifacts"][0]["name"] == "raw.m4s"
    assert payload["artifacts"][0]["sha256"] == hashlib.sha256(b"ctf-audio").hexdigest()
    assert manifest.sha256


def test_parse_cookie_header_import() -> None:
    payload = "Cookie: SESSDATA=fake-value; bili_jct=fake-csrf; DedeUserID=123"

    cookies, origins = parse_cookie_import("cookie_header", payload)

    assert origins == []
    assert {cookie["name"] for cookie in cookies} == {"SESSDATA", "bili_jct", "DedeUserID"}
    assert all(cookie["domain"] == ".bilibili.com" for cookie in cookies)


def test_parse_playwright_storage_state_filters_non_bilibili_origins() -> None:
    cookies, origins = parse_cookie_import(
        "playwright_storage_state",
        {
            "cookies": [{"name": "SESSDATA", "value": "fake-value", "domain": ".bilibili.com", "path": "/"}],
            "origins": [
                {"origin": "https://www.bilibili.com", "localStorage": [{"name": "k", "value": "v"}]},
                {"origin": "https://example.com", "localStorage": [{"name": "x", "value": "y"}]},
            ],
        },
    )

    assert cookies[0]["name"] == "SESSDATA"
    assert origins == [
        {"origin": "https://www.bilibili.com", "localStorage": [{"name": "k", "value": "v"}]}
    ]


def test_sanitize_text_redacts_sensitive_headers() -> None:
    text = "Cookie=SESSDATA=fake-secret Authorization=Bearer fake-token"

    sanitized = sanitize_text(text)

    assert "fake-secret" not in sanitized
    assert "fake-token" not in sanitized
    assert "<redacted>" in sanitized


def test_sanitize_dict_redacts_sensitive_keys() -> None:
    payload = {
        "cookie": "SESSDATA=fake-secret",
        "authorization": "Bearer fake-token",
        "storage_state": {"cookies": [{"value": "fake-secret"}]},
        "safe": "job status",
    }

    sanitized = sanitize_dict(payload)

    assert sanitized["cookie"] == "<redacted>"
    assert sanitized["authorization"] == "<redacted>"
    assert sanitized["storage_state"] == "<redacted>"
    assert sanitized["safe"] == "job status"


def test_sanitize_url_removes_signed_query() -> None:
    url = "https://example.bilivideo.com/audio.m4s?token=fake-secret&expires=123"

    sanitized = sanitize_url(url)

    assert "fake-secret" not in sanitized
    assert sanitized == "https://example.bilivideo.com/audio.m4s?<redacted>"
