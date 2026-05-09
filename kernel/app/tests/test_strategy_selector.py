from app.models import StrategyMode, StrategyName
from app.browser.network_capture import score_candidate
from app.security import sanitize_dict
from app.strategy_selector import StrategyMetricSnapshot, select_strategy_order


def test_force_mode_runs_only_requested_strategy() -> None:
    assert select_strategy_order(
        StrategyMode.FORCE,
        StrategyName.BROWSER_NETWORK,
        None,
    ) == [StrategyName.BROWSER_NETWORK]


def test_auto_mode_default_order_when_no_metrics() -> None:
    assert select_strategy_order(StrategyMode.AUTO, None, None) == [
        StrategyName.API_DASH,
        StrategyName.BROWSER_NETWORK,
        StrategyName.MSE_SOURCEBUFFER,
    ]


def test_auto_mode_accepts_user_strategy_order() -> None:
    order = select_strategy_order(
        StrategyMode.AUTO,
        None,
        [StrategyName.MSE_SOURCEBUFFER, StrategyName.API_DASH],
        logged_in=True,
    )
    assert order[:2] == [StrategyName.MSE_SOURCEBUFFER, StrategyName.API_DASH]


def test_auto_mode_can_consider_success_metrics() -> None:
    metrics = {
        StrategyName.API_DASH: StrategyMetricSnapshot(
            strategy_name=StrategyName.API_DASH,
            total_attempts=10,
            success_count=0,
            fail_count=10,
            last_failure_reason="PLAYURL_HTTP_403",
            avg_duration_ms=5000,
        ),
        StrategyName.BROWSER_NETWORK: StrategyMetricSnapshot(
            strategy_name=StrategyName.BROWSER_NETWORK,
            total_attempts=10,
            success_count=10,
            fail_count=0,
            avg_duration_ms=1000,
        ),
    }
    order = select_strategy_order(
        StrategyMode.AUTO,
        None,
        None,
        metrics=metrics,
        logged_in=True,
    )
    assert StrategyName.BROWSER_NETWORK in order
    assert order.index(StrategyName.BROWSER_NETWORK) <= order.index(StrategyName.API_DASH)


def test_network_scoring_rejects_captcha_json() -> None:
    score, reasons = score_candidate(
        "https://security.bilibili.com/th/captcha/cc/check",
        200,
        "xhr",
        {"content-type": "application/json; charset=utf-8"},
    )

    assert score < 0
    assert "blocked_non_media_endpoint" in reasons


def test_network_scoring_accepts_audio_m4s_candidate() -> None:
    score, reasons = score_candidate(
        "https://upos-sz-mirrorcos.bilivideo.com/audio.m4s",
        206,
        "media",
        {"content-type": "audio/mp4", "content-length": "1048576"},
    )

    assert score > 0
    assert "audio_mp4_content_type" in reasons
    assert "media_extension" in reasons


def test_network_scoring_rejects_plain_json_api() -> None:
    score, reasons = score_candidate(
        "https://api.bilibili.com/x/web-interface/view",
        200,
        "xhr",
        {"content-type": "application/json; charset=utf-8"},
    )

    assert score < 0
    assert "structured_non_media_content_type" in reasons


def test_sanitize_dict_recurses_into_lists() -> None:
    sanitized = sanitize_dict(
        {
            "items": [
                {
                    "message": "download https://example.com/audio.m4s?token=secret",
                    "Cookie": "SESSDATA=secret",
                }
            ]
        }
    )

    assert sanitized["items"][0]["message"] == "download https://example.com/audio.m4s?<redacted>"
    assert sanitized["items"][0]["Cookie"] == "<redacted>"
