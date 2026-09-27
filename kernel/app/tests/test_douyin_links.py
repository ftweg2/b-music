import pytest

from app.douyin.links import aweme_id_from_url, parse_douyin_url
from app.models import SourceName
from app.sources import source_for_url, validate_video_ref


AWEME_ID = "7687946506598968422"


@pytest.mark.parametrize(
    "url",
    [
        f"https://www.douyin.com/video/{AWEME_ID}",
        f"https://www.douyin.com/video/{AWEME_ID}/?previous_page=app_code_link",
        f"https://douyin.com/note/{AWEME_ID}",
        f"https://m.douyin.com/share/video/{AWEME_ID}/",
        f"https://www.iesdouyin.com/share/video/{AWEME_ID}/?region=CN&mid=1",
        f"https://www.douyin.com/jingxuan?modal_id={AWEME_ID}",
        f"https://www.douyin.com/user/self?aweme_id={AWEME_ID}",
        f"http://www.douyin.com/video/{AWEME_ID}",
    ],
)
def test_page_links_resolve_to_canonical_video_url(url) -> None:
    ref = parse_douyin_url(url)

    assert ref is not None
    assert ref.aweme_id == AWEME_ID
    assert ref.canonical_url == f"https://www.douyin.com/video/{AWEME_ID}"


def test_short_link_keeps_share_code_for_in_job_resolution() -> None:
    ref = parse_douyin_url("https://v.douyin.com/iRNBho6x/")

    assert ref is not None
    assert ref.aweme_id is None
    assert ref.short_code == "iRNBho6x"
    assert ref.canonical_url == "https://v.douyin.com/iRNBho6x/"


def test_non_douyin_hosts_are_left_to_other_sources() -> None:
    assert parse_douyin_url("https://www.bilibili.com/video/BV1GJ411x7h7") is None
    assert parse_douyin_url("BV1GJ411x7h7") is None
    assert parse_douyin_url(f"https://douyin.com.example.com/video/{AWEME_ID}") is None
    assert parse_douyin_url(f"https://example.com/video/{AWEME_ID}") is None


@pytest.mark.parametrize(
    "url",
    [
        "https://www.douyin.com/",
        "https://www.douyin.com/video/12345",
        "https://www.douyin.com/user/MS4wLjABAAAA",
        "https://v.douyin.com/",
        "https://v.douyin.com/abc/def/",
        f"ftp://www.douyin.com/video/{AWEME_ID}",
        f"https://user:pass@www.douyin.com/video/{AWEME_ID}",
        f"https://www.douyin.com:8443/video/{AWEME_ID}",
    ],
)
def test_unusable_douyin_links_are_rejected(url) -> None:
    with pytest.raises(ValueError):
        parse_douyin_url(url)


def test_aweme_id_from_url_ignores_other_hosts() -> None:
    assert aweme_id_from_url(f"https://www.iesdouyin.com/share/video/{AWEME_ID}/") == AWEME_ID
    assert aweme_id_from_url(f"https://evil.example/share/video/{AWEME_ID}/") is None


def test_validate_video_ref_routes_by_source_without_network() -> None:
    douyin = validate_video_ref(f"https://www.douyin.com/jingxuan?modal_id={AWEME_ID}")
    bilibili = validate_video_ref("https://www.bilibili.com/video/BV1GJ411x7h7?p=1")
    bare_bvid = validate_video_ref("BV1GJ411x7h7")

    assert douyin.source == SourceName.DOUYIN
    assert douyin.canonical_url == f"https://www.douyin.com/video/{AWEME_ID}"
    assert bilibili.source == SourceName.BILIBILI
    assert bilibili.canonical_url == "https://www.bilibili.com/video/BV1GJ411x7h7"
    assert bare_bvid.canonical_url == bilibili.canonical_url


def test_validate_video_ref_still_rejects_unknown_hosts() -> None:
    with pytest.raises(ValueError, match="Bilibili"):
        validate_video_ref("https://example.com/video/BV1GJ411x7h7")


def test_source_for_canonical_url() -> None:
    assert source_for_url(f"https://www.douyin.com/video/{AWEME_ID}") == SourceName.DOUYIN
    assert source_for_url("https://v.douyin.com/iRNBho6x/") == SourceName.DOUYIN
    assert source_for_url("https://www.bilibili.com/video/BV1GJ411x7h7") == SourceName.BILIBILI
