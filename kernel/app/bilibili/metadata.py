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


async def resolve_video_metadata(
    client: httpx.AsyncClient,
    bvid: str,
    user_agent: str,
) -> dict[str, object]:
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
    owner = data.get("owner") if isinstance(data.get("owner"), dict) else {}
    pages = data.get("pages") if isinstance(data.get("pages"), list) else []
    duration = data.get("duration")
    return {
        "bvid": bvid,
        "aid": str(data.get("aid")) if data.get("aid") is not None else None,
        "title": str(data.get("title") or bvid),
        "description": str(data.get("desc") or "") or None,
        "creator_mid": str(owner.get("mid")) if owner.get("mid") is not None else None,
        "creator_name": str(owner.get("name")) if owner.get("name") else None,
        "cover_url": str(data.get("pic")) if data.get("pic") else None,
        "duration_seconds": int(duration) if isinstance(duration, int | float) else None,
        "pub_time": _timestamp_iso(data.get("pubdate")),
        "source_url": f"https://www.bilibili.com/video/{bvid}",
        "category": str(data.get("tname")) if data.get("tname") else None,
        "tags": [],
        "pages": [
            {
                "cid": int(page["cid"]),
                "page": int(page.get("page", index + 1)),
                "part": page.get("part"),
            }
            for index, page in enumerate(pages)
            if isinstance(page, dict) and page.get("cid") is not None
        ],
    }


def _timestamp_iso(value: object) -> str | None:
    from datetime import UTC, datetime

    try:
        timestamp = int(value)
    except (TypeError, ValueError):
        return None
    if timestamp <= 0:
        return None
    return datetime.fromtimestamp(timestamp, UTC).isoformat()


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
