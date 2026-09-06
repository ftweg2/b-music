"""Compare the checked-in baseline with current network capture on synthetic events.

CPU timings run without tracemalloc. Separate memory runs report peak *traced
Python allocations*, not RSS or total Chrome/container memory. No network calls.
"""
import asyncio
import gc
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import sys
import time
import tracemalloc
import types

ROOT = Path(__file__).resolve().parents[1]
BASELINE_REVISION = "ec7445fbb70e0bf1a3abf836b8246dae9fdc1868"
sys.path.insert(0, str(ROOT / "kernel"))
from app.browser.network_capture import NetworkCapture


class Page:
    def on(self, _event, handler):
        self.handler = handler
    def remove_listener(self, _event, _handler):
        self.handler = None


class Response:
    status = 206
    request = types.SimpleNamespace(resource_type="media")
    headers = {"content-type": "audio/mp4", "content-length": "100000"}
    def __init__(self, index):
        self.url = f"https://example.bilivideo.com/audio-{index}.m4s?token=synthetic-{index}"


async def measure(capture_type, count, trace=False):
    gc.collect()
    if trace:
        tracemalloc.start()
    capture, page = capture_type(), Page()
    capture.attach(page)
    started, cpu = time.perf_counter(), time.process_time()
    for index in range(count):
        page.handler(Response(index))
    queued_tasks = len(capture._pending_tasks)
    await capture.finish()
    output = {"best": capture.best_candidate().sanitized_dict(), "top": capture.sanitized_candidates(),
              "summary": capture.sanitized_summary()}
    result = {"wall_ms": (time.perf_counter() - started) * 1000, "cpu_ms": (time.process_time() - cpu) * 1000,
              "queued_tasks": queued_tasks,
              "response_sha256": hashlib.sha256(json.dumps(output, sort_keys=True).encode()).hexdigest()}
    if trace:
        result["peak_traced_python_bytes"] = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
    return result


async def main():
    baseline_source = subprocess.check_output(
        ["git", "-c", f"safe.directory={ROOT.as_posix()}", "show", f"{BASELINE_REVISION}:kernel/app/browser/network_capture.py"],
        cwd=ROOT, encoding="utf-8")
    module = types.ModuleType("runtime_baseline_network_capture")
    sys.modules[module.__name__] = module
    exec(compile(baseline_source, "baseline:network_capture.py", "exec"), module.__dict__)
    result = {"scope": "20000 synthetic metadata-only network events, identical selection/ranking/counters",
              "baseline_revision": BASELINE_REVISION,
              "baseline_source_sha256": hashlib.sha256(baseline_source.encode()).hexdigest(),
              "memory_scope": "tracemalloc peak Python allocations; not process RSS", "results": {}}
    for label, capture_type in [("baseline", module.NetworkCapture), ("optimized", NetworkCapture)]:
        timings = [await measure(capture_type, 20_000) for _ in range(3)]
        memory = await measure(capture_type, 20_000, trace=True)
        assert all(sample["response_sha256"] == memory["response_sha256"] for sample in timings)
        result["results"][label] = {
            "median_cpu_ms": statistics.median(sample["cpu_ms"] for sample in timings),
            "median_wall_ms": statistics.median(sample["wall_ms"] for sample in timings),
            "peak_traced_python_bytes": memory["peak_traced_python_bytes"],
            "queued_tasks": memory["queued_tasks"], "response_sha256": memory["response_sha256"],
        }
    assert result["results"]["baseline"]["response_sha256"] == result["results"]["optimized"]["response_sha256"]
    destination = ROOT / "tests" / "performance-reports" / "runtime-network-20260906.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({**result, "report": str(destination)}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
