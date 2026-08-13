from app.config import get_settings


def test_invalid_numeric_environment_values_fall_back(monkeypatch) -> None:
    monkeypatch.setenv("NETWORK_CAPTURE_MS", "not-a-number")
    monkeypatch.setenv("MSE_PLAYBACK_RATE", "not-a-number")
    monkeypatch.setenv("REQUEST_TIMEOUT_SECONDS", "not-a-number")
    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert settings.network_capture_ms == 12000
        assert settings.mse_playback_rate == 4.0
        assert settings.request_timeout_seconds == 30.0
    finally:
        get_settings.cache_clear()


def test_nonfinite_float_environment_value_falls_back(monkeypatch) -> None:
    monkeypatch.setenv("MSE_PLAYBACK_RATE", "nan")
    get_settings.cache_clear()
    try:
        assert get_settings().mse_playback_rate == 4.0
    finally:
        get_settings.cache_clear()


def test_numeric_environment_values_are_bounded(monkeypatch) -> None:
    monkeypatch.setenv("NETWORK_CAPTURE_MS", "0")
    monkeypatch.setenv("MSE_MAX_SEGMENTS", "999999")
    monkeypatch.setenv("REQUEST_TIMEOUT_SECONDS", "0")
    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert settings.network_capture_ms == 1000
        assert settings.mse_max_segments == 100_000
        assert settings.request_timeout_seconds == 1.0
    finally:
        get_settings.cache_clear()
