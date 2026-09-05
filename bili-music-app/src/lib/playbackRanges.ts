import { ApiError } from "./api";
import { getCandidateByBvid, getDatabase, nowIso } from "./db";
import type { PlaybackRange } from "./playbackRange";

export const MAX_PLAYBACK_SECONDS = 7 * 24 * 60 * 60;
export function playbackBvid(value: unknown): string {
  if (typeof value !== "string" || !/^BV[0-9A-Za-z]{10}$/.test(value)) throw new ApiError(400, "INVALID_BVID", "请提供有效的 BV 号");
  return value;
}

export function readPlaybackRange(bvid: string, accountId: string): PlaybackRange {
  const row = getDatabase().prepare("SELECT * FROM playback_ranges WHERE owner_id=? AND bvid=?").get(accountId, playbackBvid(bvid));
  return rangeFromRow(bvid, accountId, row);
}

export function readPlaybackRanges(bvids: string[], accountId: string): Map<string, PlaybackRange> {
  const unique=[...new Set(bvids.map(playbackBvid))];
  const result=new Map<string,PlaybackRange>();
  // Bounded chunks stay below SQLite parameter limits for non-HTTP callers too.
  for(let offset=0;offset<unique.length;offset+=200){
    const batch=unique.slice(offset,offset+200);
    const rows=getDatabase().prepare(`SELECT * FROM playback_ranges WHERE owner_id=? AND bvid IN (${batch.map(()=>"?").join(",")})`).all(accountId,...batch);
    const saved=new Map(rows.map(row=>[String(row.bvid),row]));
    for(const bvid of batch)result.set(bvid,rangeFromRow(bvid,accountId,saved.get(bvid)));
  }
  return result;
}

function rangeFromRow(bvid: string, accountId: string, row: Record<string, unknown> | undefined): PlaybackRange {
  const startSeconds = row ? Number(row.start_seconds) : 0;
  const endSeconds = row?.end_seconds === null || row === undefined ? null : Number(row.end_seconds);
  return {
    accountId, bvid, startSeconds, endSeconds, revision: row ? Number(row.revision) : 0,
    updatedAt: row ? String(row.updated_at) : null, configured: startSeconds !== 0 || endSeconds !== null,
  };
}

function seconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_PLAYBACK_SECONDS) {
    throw new ApiError(400, "INVALID_PLAYBACK_RANGE", `${field} 必须是 0–${MAX_PLAYBACK_SECONDS} 之间的秒数`);
  }
  return Math.round(value * 1000) / 1000;
}

export function savePlaybackRange(bvid: string, accountId: string, body: Record<string, unknown>): PlaybackRange {
  playbackBvid(bvid);
  if (Object.keys(body).some(key => !["startSeconds", "endSeconds", "expectedRevision", "expectedAccountId"].includes(key))) {
    throw new ApiError(400, "INVALID_PARAMETER", "播放区间包含不支持的字段");
  }
  if (body.expectedAccountId !== accountId) throw new ApiError(409, "ACCOUNT_CHANGED", "账号已变化，请重新读取播放设置");
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) throw new ApiError(400, "INVALID_REVISION", "请携带读取时返回的 revision");
  const start = seconds(body.startSeconds, "startSeconds");
  const end = body.endSeconds === null ? null : seconds(body.endSeconds, "endSeconds");
  if (end !== null && end <= start) throw new ApiError(400, "INVALID_PLAYBACK_RANGE", "结束时间必须晚于开始时间");
  const metadataDuration = getCandidateByBvid(bvid)?.durationSeconds;
  const trackDuration = getDatabase().prepare("SELECT duration_seconds FROM tracks WHERE external_owner_id=? AND bvid=? AND status='ready' ORDER BY updated_at DESC LIMIT 1").get(accountId, bvid)?.duration_seconds;
  const duration = Number(trackDuration ?? metadataDuration ?? 0);
  if (duration > 0 && (start >= duration || (end !== null && end > duration))) throw new ApiError(400, "PLAYBACK_RANGE_OUT_OF_BOUNDS", "播放区间不能超出歌曲时长");
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = readPlaybackRange(bvid, accountId);
    if (body.expectedRevision !== current.revision) {
      // An acknowledgement lost in transit may be retried safely once committed.
      if (body.expectedRevision === current.revision - 1 && current.startSeconds === start && current.endSeconds === end) {
        db.exec("COMMIT"); return current;
      }
      throw new ApiError(409, "PLAYBACK_RANGE_CONFLICT", "其他设备已修改播放区间，请重新读取后再保存");
    }
    if (current.startSeconds !== start || current.endSeconds !== end) {
      db.prepare(`INSERT INTO playback_ranges(owner_id,bvid,start_seconds,end_seconds,revision,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(owner_id,bvid) DO UPDATE SET start_seconds=excluded.start_seconds,end_seconds=excluded.end_seconds,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(accountId, bvid, start, end, current.revision + 1, nowIso());
    }
    const result = readPlaybackRange(bvid, accountId);
    db.exec("COMMIT"); return result;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
