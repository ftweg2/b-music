from app.bilibili.bvid import normalize_video_url, parse_bvid
from app.security import validate_bilibili_video_ref


def test_parse_plain_bvid() -> None:
    assert parse_bvid("BV1GJ411x7h7") == "BV1GJ411x7h7"


def test_parse_bilibili_url() -> None:
    url = "https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333.337.search-card.all.click"
    assert parse_bvid(url) == "BV1GJ411x7h7"


def test_normalize_video_url() -> None:
    assert normalize_video_url("BV1GJ411x7h7") == "https://www.bilibili.com/video/BV1GJ411x7h7"


def test_validate_rejects_non_bilibili_host() -> None:
    try:
        validate_bilibili_video_ref("https://example.com/video/BV1GJ411x7h7")
    except ValueError as exc:
        assert "Bilibili" in str(exc)
    else:
        raise AssertionError("expected validation failure")


def test_parse_invalid() -> None:
    assert parse_bvid("not-a-bvid") is None
