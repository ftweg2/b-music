from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.config import Settings, get_settings
from app.profile_manager import profile_storage_dir


@dataclass
class ManagedBrowserContext:
    context: object
    playwright: object

    async def close(self) -> None:
        await self.context.close()
        await self.playwright.stop()


class BrowserContextManager:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    async def open_context(
        self,
        profile_id: str,
        *,
        add_mse_hook: bool = False,
    ) -> ManagedBrowserContext:
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise RuntimeError("Playwright is not installed") from exc

        user_data_dir = profile_storage_dir(profile_id, self.settings)
        user_data_dir.mkdir(parents=True, exist_ok=True)
        playwright = await async_playwright().start()
        launch_options: dict[str, object] = {
            "user_data_dir": str(user_data_dir),
            "headless": self.settings.playwright_headless,
            "user_agent": self.settings.bilibili_user_agent,
            "args": ["--disable-dev-shm-usage"],
        }
        if self.settings.playwright_browser_channel:
            launch_options["channel"] = self.settings.playwright_browser_channel
        context = await playwright.chromium.launch_persistent_context(**launch_options)
        if add_mse_hook:
            hook_path = Path(__file__).with_name("mse_hook.js")
            await context.add_init_script(path=str(hook_path))
        return ManagedBrowserContext(context=context, playwright=playwright)
