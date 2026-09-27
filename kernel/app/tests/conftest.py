import pytest

from app.bilibili.wbi import reset_wbi_key_cache
from app.douyin import detail


@pytest.fixture(autouse=True)
def isolated_process_caches():
    """Process-wide caches must not leak results between tests."""
    reset_wbi_key_cache()
    detail._DETAIL_CACHE.clear()
    yield
    reset_wbi_key_cache()
    detail._DETAIL_CACHE.clear()
