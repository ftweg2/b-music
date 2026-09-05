"""Temporary blank-page startup diagnostic; never touches a login profile."""
import asyncio
import json
import tempfile
import time
import os
from playwright.async_api import async_playwright

async def main():
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="bmusic-browser-probe-") as directory:
        async with async_playwright() as driver:
            print(json.dumps({"stage": "driver", "seconds": time.monotonic()-started}), flush=True)
            executable = os.getenv("BMUSIC_PROBE_EXECUTABLE")
            options = {}
            if os.getenv("BMUSIC_PROBE_EXACT") == "1":
                from app.config import get_settings
                options["user_agent"] = get_settings().bilibili_user_agent
            context = await driver.chromium.launch_persistent_context(
                directory, executable_path=executable, channel=None if executable else os.getenv("BMUSIC_PROBE_CHANNEL", "chrome") or None, headless=True,
                args=["--disable-dev-shm-usage", *json.loads(os.getenv("BMUSIC_PROBE_ARGS", "[]"))], timeout=120000,
                **options,
            )
            print(json.dumps({"stage": "browser", "seconds": time.monotonic()-started}), flush=True)
            page = await context.new_page()
            if os.getenv("BMUSIC_PROBE_EXACT") == "1":
                await page.set_viewport_size({"width":1280 if os.getenv("BMUSIC_PROBE_WIDE")=="1" else 520,"height":720})
            if os.getenv("BMUSIC_PROBE_LOGIN") == "1":
                response = await page.goto("https://passport.bilibili.com/login", wait_until="domcontentloaded", timeout=45000)
                print(json.dumps({"stage":"login-page","seconds":time.monotonic()-started,"status":response.status,"title":await page.title(),"frames":[frame.url for frame in page.frames]}),flush=True)
                print((await page.locator("body").inner_text())[:1200],flush=True)
                print(json.dumps(await page.evaluate("""() => Array.from(document.querySelectorAll('canvas,img')).map(e=>({tag:e.tagName,id:e.id,classes:e.className,width:e.width,height:e.height,sourceKind:e.src?e.src.split(':')[0]:null,sourceLength:e.src?e.src.length:0})).slice(0,30)""")),flush=True)
                if os.getenv("BMUSIC_PROBE_SCREENSHOT")=="1":
                    await page.screenshot(path="/tmp/bmusic-probe-login.png",full_page=True)
            codecs = await page.evaluate("""() => ({aac: MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'), opus: MediaSource.isTypeSupported('audio/webm; codecs="opus"')})""")
            print(json.dumps({"stage": "codecs", **codecs}), flush=True)
            await context.close()
            print(json.dumps({"stage": "closed", "seconds": time.monotonic()-started}), flush=True)

asyncio.run(main())
