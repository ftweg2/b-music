from __future__ import annotations

from dataclasses import dataclass

import httpx


class BilibiliApiError(RuntimeError):
    def __init__(self, failure_code: str, message: str) -> None:
        self.failure_code = failure_code
        super().__init__(message)


@dataclass(frozen=True)
class VideoPage:
    cid: int
    page: int
    part: str | None = None


@dataclass(frozen=True)
class VideoMetadata:
    bvid: str
    aid: int
    cid: int
    title: str
    pages: list[VideoPage]


async def fetch_metadata(
    client: httpx.AsyncClient,
    bvid: str,
    user_agent: str,
) -> VideoMetadata:
    response = await client.get(
        "https://api.bilibili.com/x/web-interface/view",
        params={"bvid": bvid},
        headers={
            "user-agent": user_agent,
            "referer": f"https://www.bilibili.com/video/{bvid}",
        },
    )
    if response.status_code != 200:
        raise BilibiliApiError("METADATA_FAILED", f"metadata HTTP {response.status_code}")
    payload = response.json()
    if payload.get("code") != 0:
        raise BilibiliApiError("METADATA_FAILED", f"metadata code {payload.get('code')}")

    data = payload.get("data") or {}
    pages = [
        VideoPage(cid=int(page["cid"]), page=int(page.get("page", index + 1)), part=page.get("part"))
        for index, page in enumerate(data.get("pages") or [])
        if page.get("cid") is not None
    ]
    if not pages:
        raise BilibiliApiError("CID_NOT_FOUND", "metadata did not contain any page cid")

    return VideoMetadata(
        bvid=bvid,
        aid=int(data["aid"]),
        cid=pages[0].cid,
        title=str(data.get("title") or bvid),
        pages=pages,
    )
