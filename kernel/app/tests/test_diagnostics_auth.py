import pytest
from fastapi import HTTPException

from app.config import get_settings
from app.routers.diagnostics import require_operator_token


def test_diagnostics_are_disabled_without_operator_token(monkeypatch) -> None:
    monkeypatch.delenv("KERNEL_OPERATOR_TOKEN", raising=False)
    get_settings.cache_clear()
    try:
        with pytest.raises(HTTPException) as exc_info:
            require_operator_token(None)
        assert exc_info.value.status_code == 503
    finally:
        get_settings.cache_clear()


def test_diagnostics_require_matching_operator_token(monkeypatch) -> None:
    monkeypatch.setenv("KERNEL_OPERATOR_TOKEN", "test-operator-token")
    get_settings.cache_clear()
    try:
        with pytest.raises(HTTPException) as exc_info:
            require_operator_token("wrong-token")
        assert exc_info.value.status_code == 403
        assert require_operator_token("test-operator-token") is None
    finally:
        get_settings.cache_clear()
