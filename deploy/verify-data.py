"""Read-only verification of the isolated VPS metadata and audio cache."""
import hashlib
import json
import sqlite3
from pathlib import Path

root=Path("/opt/bmusic/data")
app=sqlite3.connect(f"file:{root / 'app/bili-music-app.sqlite'}?mode=ro",uri=True)
kernel=sqlite3.connect(f"file:{root / 'kernel/kernel.sqlite3'}?mode=ro",uri=True)
counts={table:app.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in ("favorite_videos","playlists","tracks","playback_ranges")}
checked=0
failures=[]
for job,name,size,sha in kernel.execute("SELECT job_id,name,size_bytes,sha256 FROM artifacts"):
    target=(root/"kernel/artifacts"/job/name).resolve()
    if not target.is_relative_to((root/"kernel/artifacts").resolve()):
        failures.append("unsafe artifact path");continue
    if not target.is_file():
        failures.append("missing artifact");continue
    digest=hashlib.sha256()
    with target.open("rb") as handle:
        while block:=handle.read(1024*1024):digest.update(block)
    if target.stat().st_size!=size or digest.hexdigest()!=sha:failures.append("artifact checksum mismatch")
    checked+=1
print(json.dumps({"counts":counts,"artifactsChecked":checked,"failures":failures,"loggedInProfiles":kernel.execute("SELECT COUNT(*) FROM profiles WHERE login_status='logged_in'").fetchone()[0]}))
if failures:raise SystemExit(1)
