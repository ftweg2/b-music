"""Headless UI regression against the isolated Compose fixture, never production."""
import asyncio
import json
import socket
import uuid
from pathlib import Path
from playwright.async_api import async_playwright


async def main():
    output = Path("/qa/reports") / ("login-ui-" + uuid.uuid4().hex)
    output.mkdir(parents=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path="/opt/chrome-headless-shell-linux64/chrome-headless-shell")
        context = await browser.new_context(viewport={"width": 1280, "height": 900})
        api = context.request
        # The single-label Compose name "app" is also a preloaded HTTPS TLD
        # in Chrome. Use its isolated container IP for this HTTP-only fixture.
        app_url = "http://" + socket.gethostbyname("app") + ":3000"
        async def state():
            return await (await api.get("http://kernel:8000/__fixture/state")).json()
        assert (await state())["fixture"] == "isolated-only"
        await api.post(app_url + "/api/kernel/login/logout", data={"confirmed": True})
        await api.post("http://kernel:8000/__fixture/control", data={"uid": None, "login_generate_error": 0, "login_generate_delay": 0, "login_poll_errors": 0})
        initial = await state()
        before = initial["login_generates"]
        page = await context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        failed_image = False
        async def qr_route(route):
            nonlocal failed_image
            if not failed_image:
                failed_image = True
                await route.abort()
            else:
                await route.continue_()
        await page.route("**/api/kernel/login/qr?**", qr_route)
        await page.goto(app_url + "/settings", wait_until="networkidle")
        await page.get_by_role("button", name="扫码登录", exact=True).click()
        await page.get_by_role("button", name="重新加载二维码", exact=True).wait_for()
        await page.get_by_role("button", name="重新加载二维码", exact=True).click()
        await page.wait_for_function("() => { const image = document.querySelector('.qrWrap img'); return image && image.complete && image.naturalWidth > 0; }")
        assert "剩余" in await page.locator(".qrWrap").inner_text()
        assert (await state())["login_generates"] == before + 1
        for width, height, name in [(1280, 900, "desktop"), (390, 844, "mobile")]:
            await page.set_viewport_size({"width": width, "height": height})
            assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            if name == "mobile":
                await page.wait_for_function("() => { const r = document.querySelector('.qrWrap img').getBoundingClientRect(); return r.top >= 0 && r.bottom < innerHeight - 160; }")
            await page.screenshot(path=str(output / f"{name}.png"))
        await api.post("http://kernel:8000/__fixture/control", data={"uid": "888888"})
        await page.get_by_role("button", name="更换账号", exact=True).wait_for(timeout=20000)
        assert await page.locator(".qrWrap").count() == 0
        assert not errors, errors
        final = await state()
        assert final["launches"] == initial["launches"], "QR must not launch a kernel Chrome"
        report = {"passed": True, "checks": ["failed PNG reload does not create a session", "visible countdown", "desktop/mobile fit", "confirmed identity closes QR", "no JS page errors", "no kernel Chrome launch"], "artifacts": str(output)}
        (output / "report.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report))
        await api.post(app_url + "/api/kernel/login/logout", data={"confirmed": True})
        await api.post("http://kernel:8000/__fixture/control", data={"uid": None})
        await browser.close()


asyncio.run(main())
