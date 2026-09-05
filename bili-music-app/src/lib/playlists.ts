import { replayMutation, recordMutation } from "./apiIdempotency";
import { getDatabase, getCandidateById, getCandidateByBvid, upsertCandidateVideo, favoriteBvids, listPreferredCreators, nowIso } from "./db";
import type { CandidateVideo, Playlist, PlaylistDetail } from "./models";
import { sanitizeText } from "./sanitize";
import { normalizeRawSearchResult, toCandidateItem } from "./search/cache";

export const MAX_PLAYLISTS = 100;
export const MAX_PLAYLIST_ITEMS = 200;

export class PlaylistError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type Row = Record<string, unknown>;
const summarySQL = `SELECT p.*,
  (SELECT COUNT(*) FROM playlist_items WHERE playlist_id=p.id) AS track_count,
  (SELECT cover_url FROM playlist_items WHERE playlist_id=p.id AND cover_url IS NOT NULL ORDER BY position,id LIMIT 1) AS cover_url
  FROM playlists p`;

export function positiveId(value: unknown): number {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new PlaylistError("无效的记录 ID");
  return id;
}

function transaction<T>(action: () => T): T {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function textField(value: unknown, max: number, required = false): string {
  if (typeof value !== "string") throw new PlaylistError(required ? "请填写歌单名称" : "歌单简介必须是文字");
  const text = value.trim();
  if (required && !text) throw new PlaylistError("歌单名称不能为空");
  if (text.length > max) throw new PlaylistError(`文字不能超过 ${max} 个字符`);
  return sanitizeText(text, max);
}

function mapPlaylist(row: Row): Playlist {
  return {
    id: Number(row.id), name: String(row.name), description: String(row.description),
    trackCount: Number(row.track_count), coverUrl: row.cover_url ? String(row.cover_url) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function getPlaylist(id: number, ownerId: string): Playlist {
  const row = getDatabase().prepare(summarySQL + " WHERE p.id=? AND p.external_owner_id=?").get(positiveId(id), ownerId);
  if (!row) throw new PlaylistError("歌单不存在或无权访问", 404);
  return mapPlaylist(row);
}

export function listPlaylists(ownerId: string): Playlist[] {
  return getDatabase().prepare(summarySQL + " WHERE p.external_owner_id=? ORDER BY p.updated_at DESC,p.id DESC LIMIT ?")
    .all(ownerId, MAX_PLAYLISTS).map(mapPlaylist);
}

function snapshot(candidate: CandidateVideo): string {
  // Whitelist metadata. Never accept an arbitrary client snapshot or media URL.
  return JSON.stringify({
    bvid: candidate.bvid, aid: candidate.aid, title: candidate.title, description: candidate.description,
    creatorMid: candidate.creatorMid, creatorName: candidate.creatorName, coverUrl: candidate.coverUrl,
    durationSeconds: candidate.durationSeconds, pubTime: candidate.pubTime,
    category: candidate.category, tags: toCandidateItem(candidate).tags,
  });
}

function insertItem(playlistId: number, candidateId: number): boolean {
  const db = getDatabase();
  const candidate = getCandidateById(positiveId(candidateId));
  if (!candidate) throw new PlaylistError("曲目不存在，请重新搜索后添加", 404);
  if (db.prepare("SELECT id FROM playlist_items WHERE playlist_id=? AND bvid=?").get(playlistId, candidate.bvid)) return false;
  const count = Number(db.prepare("SELECT COUNT(*) AS count FROM playlist_items WHERE playlist_id=?").get(playlistId)?.count);
  if (count >= MAX_PLAYLIST_ITEMS) throw new PlaylistError(`每个歌单最多保存 ${MAX_PLAYLIST_ITEMS} 首音乐`, 409);
  const position = Number(db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS next FROM playlist_items WHERE playlist_id=?").get(playlistId)?.next);
  db.prepare("INSERT INTO playlist_items (playlist_id,candidate_id,bvid,snapshot_json,cover_url,position,added_at) VALUES (?,?,?,?,?,?,?)")
    .run(playlistId, candidate.id, candidate.bvid, snapshot(candidate), candidate.coverUrl, position, nowIso());
  return true;
}

export function createPlaylist(ownerId: string, input: { name: unknown; description?: unknown; candidateId?: unknown }, idempotencyKey?: string): Playlist {
  const name = textField(input.name, 80, true);
  const description = textField(input.description ?? "", 500);
  return transaction(() => {
    const db = getDatabase();
    const receiptInput = { name, description, candidateId: input.candidateId === undefined ? undefined : positiveId(input.candidateId) };
    const replay = replayMutation<Playlist>(ownerId, "playlist.create", idempotencyKey, receiptInput);
    if (replay) return replay;
    const count = Number(db.prepare("SELECT COUNT(*) AS count FROM playlists WHERE external_owner_id=?").get(ownerId)?.count);
    if (count >= MAX_PLAYLISTS) throw new PlaylistError(`最多创建 ${MAX_PLAYLISTS} 个歌单`, 409);
    const now = nowIso();
    const result = db.prepare("INSERT INTO playlists (external_owner_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run(ownerId, name, description, now, now);
    const id = Number(result.lastInsertRowid);
    if (input.candidateId !== undefined) insertItem(id, positiveId(input.candidateId));
    const playlist = getPlaylist(id, ownerId);
    recordMutation(ownerId, "playlist.create", idempotencyKey, receiptInput, playlist);
    return playlist;
  });
}

export function editPlaylist(id: number, ownerId: string, input: { name?: unknown; description?: unknown }): Playlist {
  return transaction(() => {
    const current = getPlaylist(id, ownerId);
    const name = input.name === undefined ? current.name : textField(input.name, 80, true);
    const description = input.description === undefined ? current.description : textField(input.description, 500);
    getDatabase().prepare("UPDATE playlists SET name=?,description=?,updated_at=? WHERE id=? AND external_owner_id=?")
      .run(name, description, nowIso(), id, ownerId);
    return getPlaylist(id, ownerId);
  });
}

export function deletePlaylist(id: number, ownerId: string): void {
  transaction(() => {
    getPlaylist(id, ownerId);
    getDatabase().prepare("DELETE FROM playlists WHERE id=? AND external_owner_id=?").run(id, ownerId);
  });
}

export function addPlaylistItem(id: number, ownerId: string, candidateId: unknown): { added: boolean; playlist: Playlist } {
  return transaction(() => {
    getPlaylist(id, ownerId);
    const added = insertItem(id, positiveId(candidateId));
    if (added) getDatabase().prepare("UPDATE playlists SET updated_at=? WHERE id=?").run(nowIso(), id);
    return { added, playlist: getPlaylist(id, ownerId) };
  });
}

export function removePlaylistItem(id: number, ownerId: string, itemId: number): void {
  transaction(() => {
    getPlaylist(id, ownerId);
    const deleted = getDatabase().prepare("DELETE FROM playlist_items WHERE playlist_id=? AND id=?").run(id, positiveId(itemId));
    if (!deleted.changes) throw new PlaylistError("歌单中没有这首曲目", 404);
    getDatabase().prepare("UPDATE playlists SET updated_at=? WHERE id=?").run(nowIso(), id);
  });
}

export function reorderPlaylist(id: number, ownerId: string, itemIds: unknown): void {
  if (!Array.isArray(itemIds) || itemIds.length > MAX_PLAYLIST_ITEMS) throw new PlaylistError("无效的曲目顺序");
  const ids = itemIds.map(positiveId);
  if (new Set(ids).size !== ids.length) throw new PlaylistError("曲目顺序不能包含重复记录");
  transaction(() => {
    getPlaylist(id, ownerId);
    const rows = getDatabase().prepare("SELECT id FROM playlist_items WHERE playlist_id=?").all(id);
    const current = new Set(rows.map((row) => Number(row.id)));
    if (ids.length !== current.size || ids.some((item) => !current.has(item))) {
      throw new PlaylistError("歌单内容已变化，请刷新后再调整顺序", 409);
    }
    const update = getDatabase().prepare("UPDATE playlist_items SET position=? WHERE playlist_id=? AND id=?");
    ids.forEach((itemId, position) => update.run(position, id, itemId));
    getDatabase().prepare("UPDATE playlists SET updated_at=? WHERE id=?").run(nowIso(), id);
  });
}

export function getPlaylistDetail(id: number, ownerId: string): PlaylistDetail {
  return transaction(() => {
    const playlist = getPlaylist(id, ownerId);
    const rows = getDatabase().prepare("SELECT * FROM playlist_items WHERE playlist_id=? ORDER BY position,id LIMIT ?").all(id, MAX_PLAYLIST_ITEMS);
    const records = rows.map((row) => {
      let candidate = getCandidateByBvid(String(row.bvid));
      if (!candidate) {
        try {
          const stored = JSON.parse(String(row.snapshot_json));
          const normalized = normalizeRawSearchResult({ ...stored, bvid: String(row.bvid) }, null, "playlist_snapshot");
          candidate = upsertCandidateVideo({ ...normalized, tagsJson: JSON.stringify(normalized.tags) });
        } catch { throw new PlaylistError("部分曲目记录损坏，暂时无法打开歌单", 409); }
      }
      if (row.candidate_id !== candidate.id) getDatabase().prepare("UPDATE playlist_items SET candidate_id=? WHERE id=?").run(candidate.id, Number(row.id));
      return { row, candidate };
    });
    const favorites = favoriteBvids(records.map(({ candidate }) => candidate.bvid), ownerId);
    const followed = new Set(listPreferredCreators(ownerId).map((creator) => creator.biliMid));
    return {
      ...playlist,
      items: records.map(({ row, candidate }) => ({
        id: Number(row.id), position: Number(row.position), addedAt: String(row.added_at),
        candidate: toCandidateItem(candidate, followed.has(candidate.creatorMid || ""), favorites.has(candidate.bvid)),
      })),
    };
  });
}
