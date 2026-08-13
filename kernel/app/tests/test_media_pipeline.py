import subprocess
import sys

import pytest

from app.media_pipeline import _run_command
from app.strategies.base import StrategyCancelled


def test_run_command_can_cancel_child_process() -> None:
    checks = 0

    def cancel_requested() -> bool:
        nonlocal checks
        checks += 1
        return checks > 1

    with pytest.raises(StrategyCancelled):
        _run_command(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            timeout=5,
            cancel_requested=cancel_requested,
        )


def test_run_command_enforces_timeout() -> None:
    with pytest.raises(subprocess.TimeoutExpired):
        _run_command(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            timeout=0,
        )
