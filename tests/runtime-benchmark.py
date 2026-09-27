"""Isolated runtime verification and microbenchmarks; never accesses user storage.

Run inside the existing kernel runtime with current app/ mounted read-only.
Chrome uses a disposable profile, an in-process loopback server and synthetic AAC.
The encoder benchmark measures JS time, not whole-service CPU/RSS savings.
"""
from __future__ import annotations

import asyncio
import base64
from dataclasses import replace
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import statistics
import struct
import subprocess
import tempfile
import threading
import time

from app.browser.context_manager import BrowserContextManager, shutdown_browser_contexts
from app.config import get_settings
from app.db import init_db
from app.profile_manager import create_or_get_profile, get_login_status, verify_profile_owner, update_login_metadata
from app.strategies.base import StrategyContext
from app.strategies import mse_sourcebuffer


def profile_benchmark(settings):
    profile = create_or_get_profile("benchmark", settings)
    update_login_metadata(profile["profile_id"], logged_in=True, bili_uid="123", nickname="synthetic", settings=settings)
    def old():
        entry = create_or_get_profile("benchmark", settings)
        verify_profile_owner(entry["profile_id"], "benchmark", settings)
        return get_login_status(entry["profile_id"], settings)
    def new():
        return create_or_get_profile("benchmark", settings, include_login_status=True)["login"]
    expected = old()
    assert expected == new()
    measurements = {}
    for name, action in [("legacy_three_reads", old), ("combined_one_read", new)]:
        for _ in range(25):
            action()
        samples = []
        cpu = time.process_time()
        for _ in range(300):
            started = time.perf_counter()
            assert action() == expected
            samples.append((time.perf_counter() - started) * 1000)
        measurements[name] = {"median_ms": statistics.median(samples), "p95_ms": sorted(samples)[284],
                              "cpu_ms_300_operations": (time.process_time() - cpu) * 1000}
    return measurements


def fragmented_parts(data):
    starts = []
    cursor = 0
    while cursor < len(data):
        size, kind = struct.unpack_from(">I4s", data, cursor)
        if size == 1:
            size = struct.unpack_from(">Q", data, cursor + 8)[0]
        if size == 0:
            size = len(data) - cursor
        if size < 8 or cursor + size > len(data):
            raise AssertionError("invalid synthetic MP4")
        if kind == b"moof":
            starts.append(cursor)
        cursor += size
    boundaries = [0, *starts, len(data)]
    return [data[left:right] for left, right in zip(boundaries, boundaries[1:]) if right > left]


ENCODER_BENCHMARK = """() => {
  const results = [];
  const legacy = input => {
    const copy = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    const bytes = new Uint8Array(copy);
    let binary = '';
    for(let i=0;i<bytes.length;i+=0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i,i+0x8000));
    return btoa(binary);
  };
  if(typeof Uint8Array.prototype.toBase64 !== 'function') throw new Error('Native encoder unavailable in this runtime');
  for(const size of [1024*1024, 8*1024*1024]) {
    const input = new Uint8Array(size);
    for(let i=0;i<input.length;i++) input[i]=(i*31)%256;
    const expected=legacy(input);
    if(input.toBase64()!==expected) throw new Error('Encoded bytes changed');
    const timings={legacy:[],native:[]};
    // Alternate order and exclude warmups to avoid always favoring the second implementation.
    for(let round=0;round<16;round++) {
      for(const name of round%2 ? ['native','legacy'] : ['legacy','native']) {
        const start=performance.now();
        const encoded=name==='legacy'?legacy(input):input.toBase64();
        const elapsed=performance.now()-start;
        if(encoded!==expected) throw new Error('Encoded output mismatch');
        if(round>=4) timings[name].push(elapsed);
      }
    }
    for(const name of Object.keys(timings)) timings[name].sort((a,b)=>a-b);
    results.push({bytes:size,legacy_median_ms:(timings.legacy[5]+timings.legacy[6])/2,
      native_median_ms:(timings.native[5]+timings.native[6])/2, identical:true});
  }
  return results;
}"""


async def browser_checks(settings, root):
    sample = root / "sample.m4a"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
                    "-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
                    "-frag_duration", "1000000", "-y", str(sample)], check=True, timeout=20)
    data = sample.read_bytes()
    parts = [base64.b64encode(part).decode() for part in fragmented_parts(data)]
    base_html = """<!doctype html><video muted autoplay></video><script>
      const video=document.querySelector('video');
      const media=new MediaSource(); video.src=URL.createObjectURL(media);
      media.addEventListener('sourceopen', async()=>{
        try {
          const source=media.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
          for(const part of PARTS) {
            const bytes=Uint8Array.from(atob(part),c=>c.charCodeAt(0));
            await new Promise((resolve,reject)=>{source.addEventListener('updateend',resolve,{once:true});
              source.addEventListener('error',reject,{once:true});source.appendBuffer(bytes);});
          }
          media.endOfStream(); video.play().catch(()=>{});
        } catch(error) { document.body.dataset.failure=String(error); }
      },{once:true});
    </script>""".replace("PARTS", json.dumps(parts))

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            html = base_html
            if self.path.startswith("/fallback"):
                html = "<script>Uint8Array.prototype.toBase64=undefined;</script>" + html
            body = html.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        report = {"mse": []}
        for mode in ("native", "fallback"):
            profile = create_or_get_profile("browser-" + mode, settings)
            job_dir = root / ("job-" + mode)
            job_dir.mkdir()
            context = StrategyContext(job_id="job-" + mode, external_owner_id="browser-" + mode,
                                      profile_id=profile["profile_id"], url="BV1GJ411x7h7", outputs=["raw"],
                                      job_dir=job_dir, settings=settings, logged_in=False)
            original = mse_sourcebuffer.normalize_video_url
            mse_sourcebuffer.normalize_video_url = lambda _url: f"http://127.0.0.1:{server.server_port}/{mode}"
            try:
                result = await mse_sourcebuffer.MseSourceBufferStrategy().run(context)
            finally:
                mse_sourcebuffer.normalize_video_url = original
            assert result.status == "succeeded", result
            assert (job_dir / "raw.m4s").read_bytes() == data, "MSE audio bytes differ"
            assert result.selected_media["segment_count"] == len(parts)
            assert not (job_dir / "mse_segments").exists(), "segment files leaked"
            manifest = json.loads((job_dir / "mse_segments_manifest.json").read_text())
            assert sum(item["size"] for item in manifest["segments"]) == len(data)
            report["mse"].append({"mode": mode, "segments": len(parts), "bytes": len(data),
                                  "sha256": hashlib.sha256(data).hexdigest(), "identical": True})
        profile = create_or_get_profile("encoder", settings)
        managed = await BrowserContextManager(settings).open_context(profile["profile_id"])
        try:
            page = await managed.new_page()
            session = await managed.context.new_cdp_session(page)
            try:
                version = await session.send("Browser.getVersion")
                report["browser"] = {"product": version["product"], "jsVersion": version["jsVersion"]}
            finally:
                await session.detach()
            report["encoder"] = await page.evaluate(ENCODER_BENCHMARK)
        finally:
            await managed.close()
        await shutdown_browser_contexts()
        return report
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="b-music-runtime-") as temporary:
        root = Path(temporary)
        settings = replace(get_settings(), data_dir=root, db_path=root / "kernel.sqlite3",
                           profiles_dir=root / "profiles", artifacts_dir=root / "artifacts", mse_capture_ms=1000)
        init_db(settings)
        result = {"scope": "isolated microbenchmarks and real-browser synthetic AAC/MSE, not VPS measurements",
                  "profile": profile_benchmark(settings), "browser_checks": asyncio.run(browser_checks(settings, root))}
        print(json.dumps(result, indent=2))
