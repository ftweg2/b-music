from __future__ import annotations

import hashlib
import time
from pathlib import PurePosixPath
from urllib.parse import urlencode, urlparse

import httpx

from .metadata import BilibiliApiError


MIXIN_KEY_ENC_TAB = [
    46,
    47,
    18,
    2,
    53,
    8,
    23,
    32,
    15,
    50,
    10,
    31,
    58,
    3,
    45,
    35,
    27,
    43,
    5,
    49,
    33,
    9,
    42,
    19,
    29,
    28,
    14,
    39,
    12,
    38,
    41,
    13,
    37,
    48,
    7,
    16,
    24,
    55,
    40,
    61,
    26,
    17,
    0,
    1,
    60,
    51,
    30,
    4,
    22,
    25,
    54,
    21,
    56,
    59,
    6,
    63,
    57,
    62,
    11,
    36,
    20,
    34,
    44,
    52,
]


def _extract_key_part(url: str) -> str:
    path = PurePosixPath(urlparse(url).path)
    return path.stem


def _mixin_key(img_key: str, sub_key: str) -> str:
    raw = img_key + sub_key
    return "".join(raw[index] for index in MIXIN_KEY_ENC_TAB if index < len(raw))[:32]


async def get_wbi_keys(client: httpx.AsyncClient, user_agent: str) -> tuple[str, str]:
    response = await client.get(
        "https://api.bilibili.com/x/web-interface/nav",
        headers={"user-agent": user_agent, "referer": "https://www.bilibili.com/"},
    )
    if response.status_code != 200:
        raise BilibiliApiError("WBI_SIGN_FAILED", f"WBI nav HTTP {response.status_code}")
    payload = response.json()
    data = payload.get("data") or {}
    wbi_img = data.get("wbi_img") or {}
    img_url = wbi_img.get("img_url")
    sub_url = wbi_img.get("sub_url")
    if not img_url or not sub_url:
        raise BilibiliApiError("WBI_SIGN_FAILED", "WBI keys missing")
    return _extract_key_part(img_url), _extract_key_part(sub_url)


async def sign_wbi_params(
    client: httpx.AsyncClient,
    params: dict[str, object],
    user_agent: str,
) -> dict[str, object]:
    img_key, sub_key = await get_wbi_keys(client, user_agent)
    mixin_key = _mixin_key(img_key, sub_key)
    signed = dict(params)
    signed["wts"] = int(time.time())
    filtered = {
        key: "".join(ch for ch in str(value) if ch not in "!'()*")
        for key, value in sorted(signed.items())
    }
    query = urlencode(filtered)
    signed["w_rid"] = hashlib.md5((query + mixin_key).encode("utf-8")).hexdigest()
    return signed
