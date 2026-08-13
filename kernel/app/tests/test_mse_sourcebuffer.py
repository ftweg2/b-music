import asyncio

from app.strategies.mse_sourcebuffer import (
    _bounded_browser_result,
    _keep_mse_media_playing,
    _trigger_mse_player_load,
)


class FakePage:
    def __init__(self) -> None:
        self.scripts: list[str] = []

    async def wait_for_selector(self, _selector: str, timeout: int) -> None:
        assert timeout == 5000

    async def evaluate(self, script: str, _rate: float) -> None:
        self.scripts.append(script)


def test_mse_play_triggers_do_not_await_browser_play_promises() -> None:
    async def run() -> None:
        page = FakePage()
        await _trigger_mse_player_load(page, 4.0)
        await _keep_mse_media_playing(page, 4.0)

        assert len(page.scripts) == 2
        assert all("async (rate)" not in script for script in page.scripts)
        assert all("playPromise.catch(() => {})" in script for script in page.scripts)

    asyncio.run(run())


def test_bounded_browser_result_returns_fallback_on_timeout() -> None:
    async def run() -> None:
        fallback = {"error": "timed out"}
        result = await _bounded_browser_result(
            asyncio.Event().wait(),
            fallback,
            timeout_seconds=0.001,
        )
        assert result is fallback

    asyncio.run(run())
