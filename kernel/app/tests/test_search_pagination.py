from app.bilibili.search import _search_url


def test_search_url_includes_requested_page() -> None:
    url = _search_url("夜航星", limit=20, page=3)

    assert "page=3" in url
    assert "page_size=20" in url
