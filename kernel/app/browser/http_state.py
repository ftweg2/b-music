"""Private cookie handoff journal inside a single kernel-owned profile.

Only one runtime is authoritative. While Chrome is active the journal says
``browser``; an interrupted process must reopen that persistent profile rather
than resurrect an older HTTP cookie snapshot. LocalStorage/IndexedDB remain in
the existing browser profile, never copied into App metadata or this journal.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import tempfile

from app.async_work import run_blocking


@dataclass(frozen=True)
class CookieSnapshot:
    source: str
    cookies: list[dict] = field(repr=False)


class CookieStateStore:
    def __init__(self, directory: Path):
        self.directory = directory
        self.path = directory / "http-session.json"
        self._last_bytes: bytes | None = None

    def forget(self) -> None:
        """Do not retain serialized credentials in the idle lifecycle registry."""
        self._last_bytes = None

    async def load(self) -> CookieSnapshot | None:
        def read(_stop):
            if self.path.is_symlink():
                raise RuntimeError("Unsafe kernel HTTP session file")
            try:
                raw = self.path.read_bytes()
            except FileNotFoundError:
                self._last_bytes = None
                return None
            try:
                value = json.loads(raw)
                if (not isinstance(value, dict) or value.get("version") != 1
                        or value.get("source") not in {"http", "browser"}
                        or not isinstance(value.get("cookies"), list)
                        or not all(isinstance(cookie, dict) for cookie in value["cookies"])):
                    raise ValueError("invalid session journal")
            except (ValueError, TypeError):
                # Never include file contents, cookie values or parser excerpts.
                raise RuntimeError("Kernel HTTP session state is invalid") from None
            self._last_bytes = raw
            return CookieSnapshot(source=value["source"], cookies=value["cookies"])
        return await run_blocking(read)

    async def save(self, source: str, cookies: list[dict]) -> None:
        if source not in {"http", "browser"}:
            raise ValueError("invalid session owner")
        def write(_stop):
            raw = json.dumps({"version": 1, "source": source, "cookies": cookies},
                             separators=(",", ":"), sort_keys=True).encode("utf-8")
            if raw == self._last_bytes and self.path.is_file() and not self.path.is_symlink():
                return
            self.directory.mkdir(parents=True, exist_ok=True)
            descriptor, filename = tempfile.mkstemp(prefix=".http-session-", dir=self.directory)
            temporary = Path(filename)
            try:
                with os.fdopen(descriptor, "wb") as output:
                    output.write(raw)
                    output.flush()
                    os.fsync(output.fileno())
                # mkstemp creates an owner-only file on the Linux deployment.
                temporary.replace(self.path)
                if os.name == "posix":
                    directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                self._last_bytes = raw
            finally:
                temporary.unlink(missing_ok=True)
        await run_blocking(write)

    async def has_browser_files(self) -> bool:
        def inspect(_stop):
            if not self.directory.exists():
                return False
            return any(entry.name not in {"http-session.json", "login_sessions"}
                       and not entry.name.startswith(".http-session-")
                       for entry in self.directory.iterdir())
        return await run_blocking(inspect)
