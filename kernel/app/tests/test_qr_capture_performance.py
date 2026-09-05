import asyncio
import base64
from pathlib import Path
from app.profile_manager import _capture_login_qr


def test_existing_qr_png_is_reused_without_screenshot_or_locator_wait(tmp_path):
    payload = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + (140).to_bytes(4,"big") * 2
    class Handle:
        async def json_value(self): return "data:image/png;base64," + base64.b64encode(payload).decode()
        async def dispose(self): pass
    class Page:
        async def wait_for_function(self, expression, **kwargs):
            assert kwargs["timeout"] == 10000
            return Handle()
        def locator(self, selector): raise AssertionError("must not rasterize an existing QR bitmap")
        async def screenshot(self, **kwargs): raise AssertionError("must not screenshot")
    target = tmp_path / "qr.png"
    asyncio.run(_capture_login_qr(Page(), target))
    assert target.read_bytes() == payload


def test_qr_capture_has_one_bounded_wait_and_preserves_selector_priority(tmp_path):
    class Locator:
        def __init__(self, page, selector): self.page, self.selector = page, selector
        @property
        def first(self): return self
        async def wait_for(self, **kwargs): self.page.waits.append(kwargs["timeout"])
        async def is_visible(self): return self.selector in self.page.visible
        async def screenshot(self, *, path): self.page.selected=self.selector; Path(path).write_bytes(b"test png")
    class Page:
        def __init__(self, visible): self.visible=visible; self.waits=[]; self.selected=None
        def locator(self, selector): return Locator(self,selector)
        async def screenshot(self, *, path, full_page): self.selected="page"; Path(path).write_bytes(b"test page")
    for visible,expected in [({".qrcode-box","canvas"},".qrcode-box"),(set(),"page")]:
        page=Page(visible)
        asyncio.run(_capture_login_qr(page,tmp_path/(expected.replace(".","")+".png")))
        assert page.waits==[3000]
        assert page.selected==expected
