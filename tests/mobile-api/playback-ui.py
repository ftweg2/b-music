"""Real desktop/mobile playback against the guarded synthetic Compose fixture."""
import asyncio
import json
import socket
import uuid
from pathlib import Path

from playwright.async_api import async_playwright


async def main():
    output = Path("/qa/reports") / ("playback-ui-" + uuid.uuid4().hex)
    output.mkdir(parents=True)
    report = {"passed": False, "checks": [], "artifacts": str(output)}
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path="/opt/chrome-headless-shell-linux64/chrome-headless-shell")
        api = await p.request.new_context()
        app = "http://" + socket.gethostbyname("app") + ":3000"
        kernel = "http://kernel:8000"
        errors = []
        unexpected_prepares = []

        async def request(path, method="GET", data=None, expected=200, base=app):
            response = await api.fetch(base + path, method=method, data=data)
            try:
                payload = await response.json()
                assert response.status == expected, f"{path}: {response.status} {payload}"
                return payload
            finally:
                await response.dispose()

        async def until(read, predicate, label, seconds=20):
            deadline = asyncio.get_running_loop().time() + seconds
            while asyncio.get_running_loop().time() < deadline:
                value = await read()
                if predicate(value):
                    return value
                await asyncio.sleep(0.1)
            raise AssertionError("Timed out: " + label)

        async def login(uid):
            await request("/api/kernel/login/logout", "POST", {"confirmed": True})
            await request("/__fixture/control", "POST", {"uid": None}, base=kernel)
            await request("/api/kernel/login/start", "POST", {})
            await request("/__fixture/control", "POST", {"uid": uid}, base=kernel)
            status = await until(lambda: request("/api/kernel/login/status"),
                                 lambda s: s.get("loggedIn") and s.get("biliUid") == uid, "login")
            assert status["libraryMode"] == "account"
            await until(lambda: request("/__fixture/state", base=kernel), lambda s: s["locks"] == 0, "login cleanup")
            return status

        async def play_and_stop(page, start, end):
            await page.get_by_role("button", name="播放全部", exact=True).click()
            await page.wait_for_function("""([start,end]) => {
                const audio=document.querySelector('.playerDock audio');
                return audio && !audio.paused && audio.currentTime >= start-0.1 && audio.currentTime < end;
            }""", arg=[start, end], timeout=20000)
            source = await page.locator(".playerDock audio").get_attribute("src")
            await page.wait_for_function("""end => {
                const audio=document.querySelector('.playerDock audio');
                return audio && audio.paused && Math.abs(audio.currentTime-end) < 0.15;
            }""", arg=end, timeout=15000)
            await asyncio.sleep(0.5)
            assert await page.locator(".playerDock audio").get_attribute("src") == source, "explicit end advanced the queue"
            assert (await page.locator(".playerTrackTitle").inner_text()).strip() == first["title"]
            assert not unexpected_prepares, "explicit end unexpectedly prepared the next track"
            return source

        async def protect_queue(route):
            payload = route.request.post_data_json or {}
            if payload.get("candidateId") == songs[1]["id"] or payload.get("bvid") == songs[1]["bvid"]:
                unexpected_prepares.append("next track prepared without a manual action")
                await route.abort()
            else:
                await route.continue_()

        try:
            assert (await request("/__fixture/state", base=kernel))["fixture"] == "isolated-only"
            await login("111111")
            search = await request("/api/search", "POST", {"keyword": "Fixture UI", "useRemote": True, "provider": "kernel", "limit": 20})
            songs = search["candidates"][:2]
            assert len(songs) == 2
            first = songs[0]
            resource = "/api/playback-ranges/" + first["bvid"]
            current = (await request(resource))["playbackRange"]
            await request(resource, "PATCH", {"startSeconds": 2, "endSeconds": 5,
                          "expectedRevision": current["revision"], "expectedAccountId": "bili:111111"})
            prepared = (await request("/api/tracks/prepare", "POST", {"candidateId": first["id"],
                            "strategyMode": "force", "strategy": "browser_network"}))["track"]
            await until(lambda: request("/api/tracks/" + str(prepared["id"])),
                        lambda v: v["track"]["status"] == "ready", "audio ready")

            desktop = await browser.new_context(viewport={"width": 1280, "height": 900})
            await desktop.route("**/api/tracks/prepare", protect_queue)
            page = await desktop.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            await page.goto(app + "/playlists", wait_until="networkidle")
            name = "Runtime UI " + uuid.uuid4().hex[:8]
            await page.get_by_role("button", name="＋ 新建歌单", exact=True).click()
            await page.get_by_label("歌单名称", exact=True).fill(name)
            await page.get_by_role("button", name="创建歌单", exact=True).click()
            await page.get_by_role("heading", name=name, exact=True).wait_for()
            playlist = next(item for item in (await request("/api/playlists"))["playlists"] if item["name"] == name)
            for song in songs:
                await request(f"/api/playlists/{playlist['id']}/items", "POST", {"candidateId": song["id"]})
            playlist_path = f"/playlists/{playlist['id']}"
            await page.goto(app + playlist_path, wait_until="networkidle")
            await play_and_stop(page, 2, 5)
            report["checks"].append("UI playlist creation and real AAC playback respect 2–5 seconds without advancing a two-track queue")
            await page.get_by_role("button", name="设置播放区间", exact=True).click()
            await page.get_by_label("播放开始时间", exact=True).fill("0:01")
            await page.get_by_label("播放结束时间", exact=True).fill("0:03")
            await page.get_by_role("button", name="保存区间", exact=True).click()
            await page.get_by_role("dialog", name="设置播放区间", exact=True).wait_for(state="hidden")
            saved = (await request(resource))["playbackRange"]
            assert [saved["startSeconds"], saved["endSeconds"]] == [1, 3]
            await page.screenshot(path=str(output / "desktop.png"))

            mobile = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
            await mobile.route("**/api/tracks/prepare", protect_queue)
            phone = await mobile.new_page()
            phone.on("pageerror", lambda error: errors.append(str(error)))
            await phone.goto(app + playlist_path, wait_until="networkidle")
            await play_and_stop(phone, 1, 3)
            assert await phone.get_by_role("button", name="设置播放区间", exact=True).is_visible()
            assert await phone.locator(".playerFollowButton").is_visible()
            for control in [phone.get_by_role("button", name="设置播放区间", exact=True), phone.locator(".playerFollowButton")]:
                box = await control.bounding_box()
                assert box and box["x"] >= -1 and box["y"] >= -1 and box["x"] + box["width"] <= 391 and box["y"] + box["height"] <= 845
            assert await phone.evaluate("document.documentElement.scrollWidth <= innerWidth")
            await phone.get_by_role("button", name="设置播放区间", exact=True).click()
            await phone.get_by_role("dialog", name="设置播放区间", exact=True).wait_for()
            await phone.screenshot(path=str(output / "mobile.png"))
            report["checks"].append("a separate phone context reads the desktop-saved range; UP/range controls remain visible without horizontal overflow")
            await phone.get_by_label("播放开始时间", exact=True).fill("0:00")
            await phone.get_by_label("播放结束时间", exact=True).fill("")
            await phone.get_by_role("button", name="保存区间", exact=True).click()
            await phone.get_by_role("dialog", name="设置播放区间", exact=True).wait_for(state="hidden")
            await phone.get_by_role("button", name="播放全部", exact=True).click()
            await phone.wait_for_function("() => { const a=document.querySelector('.playerDock audio'); return a && !a.paused; }")
            await login("222222")
            await phone.wait_for_function("() => { const a=document.querySelector('.playerDock audio'); return a && a.paused && !a.getAttribute('src'); }", timeout=12000)
            assert (await request(resource))["playbackRange"]["accountId"] == "bili:222222"
            report["checks"].append("changing the verified account stops the old audio and clears its source/queue")
            assert not errors, errors
            assert not unexpected_prepares, unexpected_prepares
            report["checks"].append("no uncaught page JavaScript errors")
            report["passed"] = True
        except Exception as error:
            report["failure"] = str(error)
            raise
        finally:
            (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report))
            await api.dispose()
            await browser.close()


asyncio.run(main())
