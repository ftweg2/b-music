import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CandidateInteraction,
  CandidateVideo,
  CreatePreferredCreatorInput,
  FavoriteVideo,
  InteractionAction,
  PreferredCreator,
  SearchQueryLog,
  Track,
  TrackStatus
} from "./models";

type SqlValue = string | number | null;
export type CandidateInteractionSummary = Record<InteractionAction, number> & { favorite?: number };

let database: DatabaseSync | null = null;

export function getDatabase(): DatabaseSync {
  if (database) {
    return database;
  }
  const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "bili-music-app.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database);
  return database;
}

export function closeDatabaseForTests(): void {
  if (database) {
    database.close();
    database = null;
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS preferred_creators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_owner_id TEXT NOT NULL DEFAULT 'local',
      bili_mid TEXT NOT NULL,
      name TEXT NOT NULL,
      homepage_url TEXT,
      priority_weight INTEGER NOT NULL DEFAULT 50,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(external_owner_id, bili_mid)
    );

    CREATE TABLE IF NOT EXISTS candidate_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bvid TEXT NOT NULL UNIQUE,
      aid TEXT,
      title TEXT NOT NULL,
      description TEXT,
      creator_mid TEXT,
      creator_name TEXT,
      cover_url TEXT,
      duration_seconds INTEGER,
      pub_time TEXT,
      source_url TEXT NOT NULL,
      category TEXT,
      tags_json TEXT,
      search_keyword TEXT,
      source_provider TEXT NOT NULL,
      music_likelihood_score REAL NOT NULL DEFAULT 0,
      preferred_creator_boost REAL NOT NULL DEFAULT 0,
      final_score REAL NOT NULL DEFAULT 0,
      score_breakdown_json TEXT NOT NULL DEFAULT '{}',
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS search_query_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      remote_used INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS candidate_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_owner_id TEXT NOT NULL DEFAULT 'local',
      candidate_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES candidate_videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS favorite_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_owner_id TEXT NOT NULL DEFAULT 'local',
      candidate_id INTEGER,
      bvid TEXT NOT NULL,
      note TEXT,
      mood TEXT,
      title_snapshot TEXT NOT NULL,
      source_url_snapshot TEXT NOT NULL,
      creator_mid_snapshot TEXT,
      creator_name_snapshot TEXT,
      cover_url_snapshot TEXT,
      duration_seconds_snapshot INTEGER,
      pub_time_snapshot TEXT,
      category_snapshot TEXT,
      tags_json_snapshot TEXT,
      snapshot_quality TEXT NOT NULL DEFAULT 'minimal',
      last_hydrated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(external_owner_id, bvid),
      FOREIGN KEY(candidate_id) REFERENCES candidate_videos(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL UNIQUE,
      bvid TEXT NOT NULL,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      kernel_job_id TEXT,
      artifact_name TEXT,
      artifact_sha256 TEXT,
      artifact_size_bytes INTEGER,
      artifact_mime_type TEXT,
      duration_seconds INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      failure_reason TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES candidate_videos(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_candidate_title ON candidate_videos(title);
    CREATE INDEX IF NOT EXISTS idx_candidate_creator_mid ON candidate_videos(creator_mid);
    CREATE INDEX IF NOT EXISTS idx_candidate_final_score ON candidate_videos(final_score);
    CREATE INDEX IF NOT EXISTS idx_interactions_candidate ON candidate_interactions(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_favorite_owner ON favorite_videos(external_owner_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_favorite_candidate ON favorite_videos(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_candidate ON tracks(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_status ON tracks(status);
  `);
  ensureColumn(db, "candidate_interactions", "external_owner_id", "TEXT NOT NULL DEFAULT 'local'");
  migrateFavoriteVideosToStableBvid(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_interactions_owner_candidate ON candidate_interactions(external_owner_id, candidate_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_favorite_owner_bvid ON favorite_videos(external_owner_id, bvid);");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function listPreferredCreators(externalOwnerId = "local"): PreferredCreator[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM preferred_creators
       WHERE external_owner_id = ?
       ORDER BY priority_weight DESC, name ASC`
    )
    .all(externalOwnerId);
  return rows.map(mapPreferredCreator);
}

export function createPreferredCreator(input: CreatePreferredCreatorInput): PreferredCreator {
  const now = nowIso();
  const externalOwnerId = input.externalOwnerId || "local";
  const priorityWeight = input.priorityWeight ?? 50;
  getDatabase()
    .prepare(
      `INSERT INTO preferred_creators (
        external_owner_id, bili_mid, name, homepage_url, priority_weight, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_owner_id, bili_mid) DO UPDATE SET
        name=excluded.name,
        homepage_url=excluded.homepage_url,
        priority_weight=excluded.priority_weight,
        notes=excluded.notes,
        updated_at=excluded.updated_at`
    )
    .run(
      externalOwnerId,
      input.biliMid,
      input.name,
      input.homepageUrl ?? null,
      priorityWeight,
      input.notes ?? null,
      now,
      now
    );
  const creator = getDatabase()
    .prepare("SELECT * FROM preferred_creators WHERE external_owner_id=? AND bili_mid=?")
    .get(externalOwnerId, input.biliMid);
  return mapPreferredCreator(creator);
}

export function deletePreferredCreator(id: number, externalOwnerId = "local"): boolean {
  const result = getDatabase()
    .prepare("DELETE FROM preferred_creators WHERE id=? AND external_owner_id=?")
    .run(id, externalOwnerId);
  return result.changes > 0;
}

export function updatePreferredCreator(
  id: number,
  values: Partial<Pick<CreatePreferredCreatorInput, "name" | "homepageUrl" | "priorityWeight" | "notes">>,
  externalOwnerId = "local"
): PreferredCreator | null {
  const existing = getDatabase()
    .prepare("SELECT * FROM preferred_creators WHERE id=? AND external_owner_id=?")
    .get(id, externalOwnerId);
  if (!existing) {
    return null;
  }
  const current = mapPreferredCreator(existing);
  const next = {
    name: values.name ?? current.name,
    homepageUrl: values.homepageUrl ?? current.homepageUrl,
    priorityWeight: values.priorityWeight ?? current.priorityWeight,
    notes: values.notes ?? current.notes
  };
  getDatabase()
    .prepare(
      `UPDATE preferred_creators
       SET name=?, homepage_url=?, priority_weight=?, notes=?, updated_at=?
       WHERE id=? AND external_owner_id=?`
    )
    .run(next.name, next.homepageUrl, next.priorityWeight, next.notes, nowIso(), id, externalOwnerId);
  const updated = getDatabase()
    .prepare("SELECT * FROM preferred_creators WHERE id=? AND external_owner_id=?")
    .get(id, externalOwnerId);
  return updated ? mapPreferredCreator(updated) : null;
}

export type CandidateUpsertInput = Omit<
  CandidateVideo,
  "id" | "createdAt" | "updatedAt" | "lastSeenAt"
> & {
  lastSeenAt?: string;
};

export function upsertCandidateVideo(input: CandidateUpsertInput): CandidateVideo {
  const now = nowIso();
  const lastSeenAt = input.lastSeenAt || now;
  getDatabase()
    .prepare(
      `INSERT INTO candidate_videos (
        bvid, aid, title, description, creator_mid, creator_name, cover_url,
        duration_seconds, pub_time, source_url, category, tags_json, search_keyword,
        source_provider, music_likelihood_score, preferred_creator_boost, final_score,
        score_breakdown_json, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bvid) DO UPDATE SET
        aid=excluded.aid,
        title=excluded.title,
        description=excluded.description,
        creator_mid=excluded.creator_mid,
        creator_name=excluded.creator_name,
        cover_url=excluded.cover_url,
        duration_seconds=excluded.duration_seconds,
        pub_time=excluded.pub_time,
        source_url=excluded.source_url,
        category=excluded.category,
        tags_json=excluded.tags_json,
        search_keyword=excluded.search_keyword,
        source_provider=excluded.source_provider,
        music_likelihood_score=excluded.music_likelihood_score,
        preferred_creator_boost=excluded.preferred_creator_boost,
        final_score=excluded.final_score,
        score_breakdown_json=excluded.score_breakdown_json,
        last_seen_at=excluded.last_seen_at,
        updated_at=excluded.updated_at`
    )
    .run(
      input.bvid,
      input.aid,
      input.title,
      input.description,
      input.creatorMid,
      input.creatorName,
      input.coverUrl,
      input.durationSeconds,
      input.pubTime,
      input.sourceUrl,
      input.category,
      input.tagsJson,
      input.searchKeyword,
      input.sourceProvider,
      input.musicLikelihoodScore,
      input.preferredCreatorBoost,
      input.finalScore,
      input.scoreBreakdownJson,
      lastSeenAt,
      now,
      now
    );
  const row = getDatabase().prepare("SELECT * FROM candidate_videos WHERE bvid=?").get(input.bvid);
  return mapCandidateVideo(row);
}

export function updateCandidateScore(
  id: number,
  values: Pick<CandidateVideo, "musicLikelihoodScore" | "preferredCreatorBoost" | "finalScore" | "scoreBreakdownJson">
): void {
  getDatabase()
    .prepare(
      `UPDATE candidate_videos
       SET music_likelihood_score=?, preferred_creator_boost=?, final_score=?,
           score_breakdown_json=?, updated_at=?
       WHERE id=?`
    )
    .run(
      values.musicLikelihoodScore,
      values.preferredCreatorBoost,
      values.finalScore,
      values.scoreBreakdownJson,
      nowIso(),
      id
    );
}

export function searchLocalCandidates(keyword: string, limit: number): CandidateVideo[] {
  const like = `%${keyword.trim()}%`;
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM candidate_videos
       WHERE source_provider <> 'mock'
         AND (title LIKE ? OR description LIKE ? OR tags_json LIKE ? OR creator_name LIKE ?)
       ORDER BY final_score DESC, last_seen_at DESC
       LIMIT ?`
    )
    .all(like, like, like, like, limit);
  return rows.map(mapCandidateVideo);
}

export function searchFollowedCreatorCandidates(keyword: string, creators: PreferredCreator[], limit: number): CandidateVideo[] {
  const mids = creators.map((creator) => creator.biliMid).filter(Boolean).slice(0, 30);
  if (!mids.length) {
    return [];
  }
  const like = `%${keyword.trim()}%`;
  const placeholders = mids.map(() => "?").join(",");
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM candidate_videos
       WHERE source_provider <> 'mock'
         AND creator_mid IN (${placeholders})
         AND (? = '%%' OR title LIKE ? OR description LIKE ? OR tags_json LIKE ?)
       ORDER BY final_score DESC, last_seen_at DESC
       LIMIT ?`
    )
    .all(...mids, like, like, like, like, limit);
  return rows.map(mapCandidateVideo);
}

export function searchFavoriteCandidates(keyword: string, limit: number, externalOwnerId = "local"): CandidateVideo[] {
  const like = `%${keyword.trim()}%`;
  const rows = getDatabase()
    .prepare(
      `SELECT candidate_videos.* FROM candidate_videos
       INNER JOIN favorite_videos ON favorite_videos.bvid = candidate_videos.bvid
       WHERE favorite_videos.external_owner_id = ?
         AND candidate_videos.source_provider <> 'mock'
         AND (? = '%%' OR candidate_videos.title LIKE ? OR candidate_videos.description LIKE ? OR candidate_videos.tags_json LIKE ?)
       ORDER BY favorite_videos.created_at DESC
       LIMIT ?`
    )
    .all(externalOwnerId, like, like, like, like, limit);
  return rows.map(mapCandidateVideo);
}

export function listRecommendationCandidates(limit: number): CandidateVideo[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM candidate_videos
       WHERE source_provider <> 'mock'
       ORDER BY final_score DESC, last_seen_at DESC
       LIMIT ?`
    )
    .all(limit);
  return rows.map(mapCandidateVideo);
}

export function getCandidateById(id: number): CandidateVideo | null {
  const row = getDatabase().prepare("SELECT * FROM candidate_videos WHERE id=?").get(id);
  return row ? mapCandidateVideo(row) : null;
}

export function getCandidateByBvid(bvid: string): CandidateVideo | null {
  const row = getDatabase().prepare("SELECT * FROM candidate_videos WHERE bvid=?").get(bvid);
  return row ? mapCandidateVideo(row) : null;
}

export function getOrHydrateFavoriteCandidateByBvid(bvid: string, externalOwnerId = "local"): CandidateVideo | null {
  const existing = getCandidateByBvid(bvid);
  if (existing) {
    return existing;
  }
  const row = getDatabase()
    .prepare("SELECT * FROM favorite_videos WHERE external_owner_id=? AND bvid=?")
    .get(externalOwnerId, bvid);
  if (!row) {
    return null;
  }
  const favorite = mapFavoriteVideo(row);
  const candidate = hydrateCandidateFromFavorite(favorite);
  getDatabase()
    .prepare("UPDATE favorite_videos SET candidate_id=?, last_hydrated_at=?, updated_at=? WHERE id=?")
    .run(candidate.id, nowIso(), nowIso(), favorite.id);
  return candidate;
}

export function listCandidates(limit: number): CandidateVideo[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM candidate_videos WHERE source_provider <> 'mock' ORDER BY updated_at DESC LIMIT ?")
    .all(limit);
  return rows.map(mapCandidateVideo);
}

export function createFavoriteVideo(
  candidateId: number,
  input: { externalOwnerId?: string; note?: string | null; mood?: string | null } = {}
): FavoriteVideo {
  const candidate = getCandidateById(candidateId);
  if (!candidate) {
    throw new Error("candidate not found");
  }
  const now = nowIso();
  const externalOwnerId = input.externalOwnerId || "local";
  getDatabase()
    .prepare(
      `INSERT INTO favorite_videos (
        external_owner_id, candidate_id, bvid, note, mood,
        title_snapshot, source_url_snapshot, creator_mid_snapshot, creator_name_snapshot,
        cover_url_snapshot, duration_seconds_snapshot, pub_time_snapshot, category_snapshot,
        tags_json_snapshot, snapshot_quality, last_hydrated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_owner_id, bvid) DO UPDATE SET
        candidate_id=excluded.candidate_id,
        note=excluded.note,
        mood=excluded.mood,
        title_snapshot=excluded.title_snapshot,
        source_url_snapshot=excluded.source_url_snapshot,
        creator_mid_snapshot=COALESCE(excluded.creator_mid_snapshot, favorite_videos.creator_mid_snapshot),
        creator_name_snapshot=COALESCE(excluded.creator_name_snapshot, favorite_videos.creator_name_snapshot),
        cover_url_snapshot=COALESCE(excluded.cover_url_snapshot, favorite_videos.cover_url_snapshot),
        duration_seconds_snapshot=COALESCE(excluded.duration_seconds_snapshot, favorite_videos.duration_seconds_snapshot),
        pub_time_snapshot=COALESCE(excluded.pub_time_snapshot, favorite_videos.pub_time_snapshot),
        category_snapshot=COALESCE(excluded.category_snapshot, favorite_videos.category_snapshot),
        tags_json_snapshot=COALESCE(excluded.tags_json_snapshot, favorite_videos.tags_json_snapshot),
        snapshot_quality=excluded.snapshot_quality,
        last_hydrated_at=excluded.last_hydrated_at,
        updated_at=excluded.updated_at`
    )
    .run(
      externalOwnerId,
      candidate.id,
      candidate.bvid,
      input.note ?? null,
      input.mood ?? null,
      candidate.title,
      candidate.sourceUrl,
      candidate.creatorMid,
      candidate.creatorName,
      candidate.coverUrl,
      candidate.durationSeconds,
      candidate.pubTime,
      candidate.category,
      candidate.tagsJson,
      favoriteSnapshotQuality(candidate),
      now,
      now,
      now
    );
  const row = getDatabase()
    .prepare("SELECT * FROM favorite_videos WHERE external_owner_id=? AND bvid=?")
    .get(externalOwnerId, candidate.bvid);
  return mapFavoriteVideo(row);
}

export function deleteFavoriteVideo(candidateId: number, externalOwnerId = "local"): boolean {
  const candidate = Number.isFinite(candidateId) ? getCandidateById(candidateId) : null;
  const result = candidate
    ? getDatabase()
        .prepare("DELETE FROM favorite_videos WHERE external_owner_id=? AND (candidate_id=? OR bvid=?)")
        .run(externalOwnerId, candidateId, candidate.bvid)
    : getDatabase()
        .prepare("DELETE FROM favorite_videos WHERE candidate_id=? AND external_owner_id=?")
        .run(candidateId, externalOwnerId);
  return result.changes > 0;
}

export function listFavoriteVideos(limit: number, externalOwnerId = "local"): Array<{ favorite: FavoriteVideo; candidate: CandidateVideo }> {
  const rows = getDatabase()
    .prepare(
      `SELECT
        favorite_videos.id AS favorite_id,
        favorite_videos.external_owner_id AS favorite_external_owner_id,
        favorite_videos.candidate_id AS favorite_candidate_id,
        favorite_videos.bvid AS favorite_bvid,
        favorite_videos.note AS favorite_note,
        favorite_videos.mood AS favorite_mood,
        favorite_videos.title_snapshot AS favorite_title_snapshot,
        favorite_videos.source_url_snapshot AS favorite_source_url_snapshot,
        favorite_videos.creator_mid_snapshot AS favorite_creator_mid_snapshot,
        favorite_videos.creator_name_snapshot AS favorite_creator_name_snapshot,
        favorite_videos.cover_url_snapshot AS favorite_cover_url_snapshot,
        favorite_videos.duration_seconds_snapshot AS favorite_duration_seconds_snapshot,
        favorite_videos.pub_time_snapshot AS favorite_pub_time_snapshot,
        favorite_videos.category_snapshot AS favorite_category_snapshot,
        favorite_videos.tags_json_snapshot AS favorite_tags_json_snapshot,
        favorite_videos.snapshot_quality AS favorite_snapshot_quality,
        favorite_videos.last_hydrated_at AS favorite_last_hydrated_at,
        favorite_videos.created_at AS favorite_created_at,
        favorite_videos.updated_at AS favorite_updated_at,
        candidate_videos.*
       FROM favorite_videos
       LEFT JOIN candidate_videos ON candidate_videos.bvid = favorite_videos.bvid
       WHERE favorite_videos.external_owner_id = ?
         AND (candidate_videos.id IS NULL OR candidate_videos.source_provider <> 'mock')
       ORDER BY favorite_videos.created_at DESC
       LIMIT ?`
    )
    .all(externalOwnerId, limit);
  return rows.map((row) => ({
    favorite: mapFavoriteVideoFromJoin(row),
    candidate: mapCandidateVideoOrHydrateFavorite(row)
  }));
}

export function favoriteCandidateIds(candidateIds: number[], externalOwnerId = "local"): Set<number> {
  if (!candidateIds.length) {
    return new Set();
  }
  const placeholders = candidateIds.map(() => "?").join(",");
  const rows = getDatabase()
    .prepare(
      `SELECT candidate_id FROM favorite_videos
       WHERE external_owner_id = ? AND candidate_id IN (${placeholders})`
    )
    .all(externalOwnerId, ...candidateIds);
  return new Set(rows.map((row) => Number(read(row, "candidate_id"))));
}

export function favoriteBvids(bvids: string[], externalOwnerId = "local"): Set<string> {
  const values = Array.from(new Set(bvids.filter(Boolean)));
  if (!values.length) {
    return new Set();
  }
  const placeholders = values.map(() => "?").join(",");
  const rows = getDatabase()
    .prepare(
      `SELECT bvid FROM favorite_videos
       WHERE external_owner_id = ? AND bvid IN (${placeholders})`
    )
    .all(externalOwnerId, ...values);
  return new Set(rows.map((row) => String(read(row, "bvid"))));
}

export function logSearchQuery(keyword: string, resultCount: number, remoteUsed: boolean): SearchQueryLog {
  const now = nowIso();
  const result = getDatabase()
    .prepare("INSERT INTO search_query_logs (keyword, result_count, remote_used, created_at) VALUES (?, ?, ?, ?)")
    .run(keyword, resultCount, remoteUsed ? 1 : 0, now);
  return {
    id: Number(result.lastInsertRowid),
    keyword,
    resultCount,
    remoteUsed,
    createdAt: now
  };
}

export function addCandidateInteraction(
  candidateId: number,
  action: InteractionAction,
  externalOwnerId = "local"
): CandidateInteraction {
  const now = nowIso();
  const result = getDatabase()
    .prepare(
      "INSERT INTO candidate_interactions (external_owner_id, candidate_id, action, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(externalOwnerId, candidateId, action, now);
  return {
    id: Number(result.lastInsertRowid),
    externalOwnerId,
    candidateId,
    action,
    createdAt: now
  };
}

export function listCandidateInteractions(candidateId: number, externalOwnerId = "local"): CandidateInteraction[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM candidate_interactions
       WHERE candidate_id=? AND external_owner_id=?
       ORDER BY created_at DESC`
    )
    .all(candidateId, externalOwnerId);
  return rows.map(mapCandidateInteraction);
}

export function createOrReuseTrack(candidate: CandidateVideo): Track {
  const now = nowIso();
  getDatabase()
    .prepare(
      `INSERT INTO tracks (
        candidate_id, bvid, title, source_url, duration_seconds, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET
        bvid=excluded.bvid,
        title=excluded.title,
        source_url=excluded.source_url,
        duration_seconds=COALESCE(tracks.duration_seconds, excluded.duration_seconds),
        updated_at=excluded.updated_at`
    )
    .run(candidate.id, candidate.bvid, candidate.title, candidate.sourceUrl, candidate.durationSeconds, "pending", now, now);
  const track = getTrackByCandidateId(candidate.id);
  if (!track) {
    throw new Error("track upsert failed");
  }
  return track;
}

export function getTrackByCandidateId(candidateId: number): Track | null {
  const row = getDatabase().prepare("SELECT * FROM tracks WHERE candidate_id=?").get(candidateId);
  return row ? mapTrack(row) : null;
}

export function getTrackById(id: number): Track | null {
  const row = getDatabase().prepare("SELECT * FROM tracks WHERE id=?").get(id);
  return row ? mapTrack(row) : null;
}

export function updateTrack(
  id: number,
  values: Partial<
    Pick<
      Track,
      | "kernelJobId"
      | "artifactName"
      | "artifactSha256"
      | "artifactSizeBytes"
      | "artifactMimeType"
      | "durationSeconds"
      | "status"
      | "failureReason"
      | "expiresAt"
    >
  >
): Track {
  const current = getTrackById(id);
  if (!current) {
    throw new Error("track not found");
  }
  const next: Track = {
    ...current,
    ...values,
    updatedAt: nowIso()
  };
  getDatabase()
    .prepare(
      `UPDATE tracks
       SET kernel_job_id=?, artifact_name=?, artifact_sha256=?, artifact_size_bytes=?,
           artifact_mime_type=?, duration_seconds=?, status=?, failure_reason=?,
           expires_at=?, updated_at=?
       WHERE id=?`
    )
    .run(
      next.kernelJobId,
      next.artifactName,
      next.artifactSha256,
      next.artifactSizeBytes,
      next.artifactMimeType,
      next.durationSeconds,
      next.status,
      next.failureReason,
      next.expiresAt,
      next.updatedAt,
      id
    );
  const updated = getTrackById(id);
  if (!updated) {
    throw new Error("track not found after update");
  }
  return updated;
}

export function markExpiredReadyTracks(): number {
  const result = getDatabase()
    .prepare(
      `UPDATE tracks
       SET status='expired', failure_reason='音频缓存已过期', updated_at=?
       WHERE status='ready' AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')`
    )
    .run(nowIso());
  return Number(result.changes);
}

export function interactionCounts(candidateIds: number[], externalOwnerId = "local"): Map<number, CandidateInteractionSummary> {
  const map = new Map<number, CandidateInteractionSummary>();
  if (!candidateIds.length) {
    return map;
  }
  const placeholders = candidateIds.map(() => "?").join(",");
  const rows = getDatabase()
    .prepare(
      `SELECT candidate_id, action, COUNT(*) AS count
       FROM candidate_interactions
       WHERE external_owner_id = ? AND candidate_id IN (${placeholders})
       GROUP BY candidate_id, action`
    )
    .all(externalOwnerId, ...candidateIds);
  for (const row of rows) {
    const candidateId = Number(read(row, "candidate_id"));
    const action = String(read(row, "action")) as InteractionAction;
    const current = map.get(candidateId) ?? emptyInteractionSummary();
    current[action] = Number(read(row, "count"));
    map.set(candidateId, current);
  }
  const favoriteRows = getDatabase()
    .prepare(
      `SELECT candidate_id, COUNT(*) AS count
       FROM favorite_videos
       WHERE external_owner_id = ? AND candidate_id IN (${placeholders})
       GROUP BY candidate_id`
    )
    .all(externalOwnerId, ...candidateIds);
  for (const row of favoriteRows) {
    const candidateId = Number(read(row, "candidate_id"));
    const current = map.get(candidateId) ?? emptyInteractionSummary();
    current.favorite = Number(read(row, "count"));
    map.set(candidateId, current);
  }
  return map;
}

export function resetDatabaseForTests(): void {
  const db = getDatabase();
  db.exec(`
    DELETE FROM candidate_interactions;
    DELETE FROM favorite_videos;
    DELETE FROM tracks;
    DELETE FROM search_query_logs;
    DELETE FROM candidate_videos;
    DELETE FROM preferred_creators;
    DELETE FROM sqlite_sequence WHERE name IN (
      'candidate_interactions',
      'search_query_logs',
      'candidate_videos',
      'preferred_creators',
      'favorite_videos',
      'tracks'
    );
  `);
}

function emptyInteractionSummary(): CandidateInteractionSummary {
  return { viewed: 0, liked: 0, disliked: 0, skipped: 0, queued: 0, extraction_failed: 0, favorite: 0 };
}

function mapPreferredCreator(row: unknown): PreferredCreator {
  return {
    id: Number(read(row, "id")),
    externalOwnerId: String(read(row, "external_owner_id")),
    biliMid: String(read(row, "bili_mid")),
    name: String(read(row, "name")),
    homepageUrl: nullableString(read(row, "homepage_url")),
    priorityWeight: Number(read(row, "priority_weight")),
    notes: nullableString(read(row, "notes")),
    createdAt: String(read(row, "created_at")),
    updatedAt: String(read(row, "updated_at"))
  };
}

function mapCandidateVideo(row: unknown): CandidateVideo {
  return {
    id: Number(read(row, "id")),
    bvid: String(read(row, "bvid")),
    aid: nullableString(read(row, "aid")),
    title: String(read(row, "title")),
    description: nullableString(read(row, "description")),
    creatorMid: nullableString(read(row, "creator_mid")),
    creatorName: nullableString(read(row, "creator_name")),
    coverUrl: nullableString(read(row, "cover_url")),
    durationSeconds: nullableNumber(read(row, "duration_seconds")),
    pubTime: nullableString(read(row, "pub_time")),
    sourceUrl: String(read(row, "source_url")),
    category: nullableString(read(row, "category")),
    tagsJson: nullableString(read(row, "tags_json")),
    searchKeyword: nullableString(read(row, "search_keyword")),
    sourceProvider: String(read(row, "source_provider")),
    musicLikelihoodScore: Number(read(row, "music_likelihood_score")),
    preferredCreatorBoost: Number(read(row, "preferred_creator_boost")),
    finalScore: Number(read(row, "final_score")),
    scoreBreakdownJson: String(read(row, "score_breakdown_json")),
    lastSeenAt: String(read(row, "last_seen_at")),
    createdAt: String(read(row, "created_at")),
    updatedAt: String(read(row, "updated_at"))
  };
}

function mapCandidateVideoOrHydrateFavorite(row: unknown): CandidateVideo {
  if (read(row, "id") !== null) {
    return mapCandidateVideo(row);
  }
  const favorite = mapFavoriteVideoFromJoin(row);
  const candidate = hydrateCandidateFromFavorite(favorite);
  getDatabase()
    .prepare("UPDATE favorite_videos SET candidate_id=?, last_hydrated_at=?, updated_at=? WHERE id=?")
    .run(candidate.id, nowIso(), nowIso(), favorite.id);
  return candidate;
}

function hydrateCandidateFromFavorite(favorite: FavoriteVideo): CandidateVideo {
  return upsertCandidateVideo({
    bvid: favorite.bvid,
    aid: null,
    title: favorite.titleSnapshot || favorite.bvid,
    description: null,
    creatorMid: favorite.creatorMidSnapshot,
    creatorName: favorite.creatorNameSnapshot,
    coverUrl: favorite.coverUrlSnapshot,
    durationSeconds: favorite.durationSecondsSnapshot,
    pubTime: favorite.pubTimeSnapshot,
    sourceUrl: favorite.sourceUrlSnapshot || canonicalBilibiliUrl(favorite.bvid),
    category: favorite.categorySnapshot,
    tagsJson: favorite.tagsJsonSnapshot || "[]",
    searchKeyword: null,
    sourceProvider: "favorite_snapshot",
    musicLikelihoodScore: 0,
    preferredCreatorBoost: 0,
    finalScore: 0,
    scoreBreakdownJson: "{}",
    lastSeenAt: nowIso()
  });
}

function canonicalBilibiliUrl(bvid: string): string {
  return `https://www.bilibili.com/video/${bvid}`;
}

function favoriteSnapshotQuality(candidate: CandidateVideo): FavoriteVideo["snapshotQuality"] {
  if (candidate.creatorMid && candidate.creatorName && candidate.durationSeconds && candidate.sourceUrl) {
    return "complete";
  }
  if (candidate.title && candidate.sourceUrl) {
    return "partial";
  }
  return "minimal";
}

function mapCandidateInteraction(row: unknown): CandidateInteraction {
  return {
    id: Number(read(row, "id")),
    externalOwnerId: String(read(row, "external_owner_id") ?? "local"),
    candidateId: Number(read(row, "candidate_id")),
    action: String(read(row, "action")) as InteractionAction,
    createdAt: String(read(row, "created_at"))
  };
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const hasColumn = columns.some((row) => String(read(row, "name")) === column);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function migrateFavoriteVideosToStableBvid(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(favorite_videos)").all();
  const names = new Set(columns.map((row) => String(read(row, "name"))));
  const candidateIdColumn = columns.find((row) => String(read(row, "name")) === "candidate_id");
  const requiredColumns = [
    "bvid",
    "title_snapshot",
    "source_url_snapshot",
    "creator_mid_snapshot",
    "creator_name_snapshot",
    "cover_url_snapshot",
    "duration_seconds_snapshot",
    "pub_time_snapshot",
    "category_snapshot",
    "tags_json_snapshot",
    "snapshot_quality",
    "last_hydrated_at"
  ];
  const missingRequiredColumn = requiredColumns.some((column) => !names.has(column));
  const candidateIdIsRequired = Number(read(candidateIdColumn, "notnull")) === 1;
  if (!missingRequiredColumn && !candidateIdIsRequired) {
    return;
  }

  const legacyTable = `favorite_videos_legacy_${Date.now()}`;
  db.exec(`
    DROP INDEX IF EXISTS idx_favorite_owner;
    DROP INDEX IF EXISTS idx_favorite_candidate;
    DROP INDEX IF EXISTS idx_favorite_owner_bvid;
    ALTER TABLE favorite_videos RENAME TO ${legacyTable};
  `);
  createFavoriteVideosTable(db);

  const bvidExpr = names.has("bvid") ? `COALESCE(old.bvid, c.bvid)` : "c.bvid";
  const snapshotExpr = (column: string, fallback: string) => (names.has(column) ? `COALESCE(old.${column}, ${fallback})` : fallback);
  const titleExpr = snapshotExpr("title_snapshot", `COALESCE(c.title, ${bvidExpr})`);
  const sourceUrlExpr = snapshotExpr("source_url_snapshot", `COALESCE(c.source_url, 'https://www.bilibili.com/video/' || ${bvidExpr})`);
  const snapshotQualityExpr = names.has("snapshot_quality")
    ? "COALESCE(old.snapshot_quality, CASE WHEN c.creator_name IS NOT NULL AND c.creator_mid IS NOT NULL THEN 'complete' WHEN c.id IS NOT NULL THEN 'partial' ELSE 'minimal' END)"
    : "CASE WHEN c.creator_name IS NOT NULL AND c.creator_mid IS NOT NULL THEN 'complete' WHEN c.id IS NOT NULL THEN 'partial' ELSE 'minimal' END";
  const lastHydratedExpr = names.has("last_hydrated_at")
    ? "COALESCE(old.last_hydrated_at, c.updated_at, old.updated_at)"
    : "COALESCE(c.updated_at, old.updated_at)";

  db.exec(`
    INSERT OR IGNORE INTO favorite_videos (
      external_owner_id, candidate_id, bvid, note, mood,
      title_snapshot, source_url_snapshot, creator_mid_snapshot, creator_name_snapshot,
      cover_url_snapshot, duration_seconds_snapshot, pub_time_snapshot, category_snapshot,
      tags_json_snapshot, snapshot_quality, last_hydrated_at, created_at, updated_at
    )
    SELECT
      COALESCE(old.external_owner_id, 'local'),
      c.id,
      ${bvidExpr},
      old.note,
      old.mood,
      ${titleExpr},
      ${sourceUrlExpr},
      ${snapshotExpr("creator_mid_snapshot", "c.creator_mid")},
      ${snapshotExpr("creator_name_snapshot", "c.creator_name")},
      ${snapshotExpr("cover_url_snapshot", "c.cover_url")},
      ${snapshotExpr("duration_seconds_snapshot", "c.duration_seconds")},
      ${snapshotExpr("pub_time_snapshot", "c.pub_time")},
      ${snapshotExpr("category_snapshot", "c.category")},
      ${snapshotExpr("tags_json_snapshot", "c.tags_json")},
      ${snapshotQualityExpr},
      ${lastHydratedExpr},
      old.created_at,
      old.updated_at
    FROM ${legacyTable} old
    LEFT JOIN candidate_videos c ON c.id = old.candidate_id
    WHERE ${bvidExpr} IS NOT NULL AND ${bvidExpr} <> '';

    DROP TABLE ${legacyTable};
  `);
}

function createFavoriteVideosTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS favorite_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_owner_id TEXT NOT NULL DEFAULT 'local',
      candidate_id INTEGER,
      bvid TEXT NOT NULL,
      note TEXT,
      mood TEXT,
      title_snapshot TEXT NOT NULL,
      source_url_snapshot TEXT NOT NULL,
      creator_mid_snapshot TEXT,
      creator_name_snapshot TEXT,
      cover_url_snapshot TEXT,
      duration_seconds_snapshot INTEGER,
      pub_time_snapshot TEXT,
      category_snapshot TEXT,
      tags_json_snapshot TEXT,
      snapshot_quality TEXT NOT NULL DEFAULT 'minimal',
      last_hydrated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(external_owner_id, bvid),
      FOREIGN KEY(candidate_id) REFERENCES candidate_videos(id) ON DELETE SET NULL
    );
  `);
}

function mapFavoriteVideo(row: unknown): FavoriteVideo {
  return {
    id: Number(read(row, "id")),
    externalOwnerId: String(read(row, "external_owner_id")),
    candidateId: nullableNumber(read(row, "candidate_id")),
    bvid: String(read(row, "bvid")),
    note: nullableString(read(row, "note")),
    mood: nullableString(read(row, "mood")),
    titleSnapshot: String(read(row, "title_snapshot")),
    sourceUrlSnapshot: String(read(row, "source_url_snapshot")),
    creatorMidSnapshot: nullableString(read(row, "creator_mid_snapshot")),
    creatorNameSnapshot: nullableString(read(row, "creator_name_snapshot")),
    coverUrlSnapshot: nullableString(read(row, "cover_url_snapshot")),
    durationSecondsSnapshot: nullableNumber(read(row, "duration_seconds_snapshot")),
    pubTimeSnapshot: nullableString(read(row, "pub_time_snapshot")),
    categorySnapshot: nullableString(read(row, "category_snapshot")),
    tagsJsonSnapshot: nullableString(read(row, "tags_json_snapshot")),
    snapshotQuality: normalizeSnapshotQuality(read(row, "snapshot_quality")),
    lastHydratedAt: nullableString(read(row, "last_hydrated_at")),
    createdAt: String(read(row, "created_at")),
    updatedAt: String(read(row, "updated_at"))
  };
}

function mapFavoriteVideoFromJoin(row: unknown): FavoriteVideo {
  return {
    id: Number(read(row, "favorite_id")),
    externalOwnerId: String(read(row, "favorite_external_owner_id")),
    candidateId: nullableNumber(read(row, "favorite_candidate_id")),
    bvid: String(read(row, "favorite_bvid")),
    note: nullableString(read(row, "favorite_note")),
    mood: nullableString(read(row, "favorite_mood")),
    titleSnapshot: String(read(row, "favorite_title_snapshot")),
    sourceUrlSnapshot: String(read(row, "favorite_source_url_snapshot")),
    creatorMidSnapshot: nullableString(read(row, "favorite_creator_mid_snapshot")),
    creatorNameSnapshot: nullableString(read(row, "favorite_creator_name_snapshot")),
    coverUrlSnapshot: nullableString(read(row, "favorite_cover_url_snapshot")),
    durationSecondsSnapshot: nullableNumber(read(row, "favorite_duration_seconds_snapshot")),
    pubTimeSnapshot: nullableString(read(row, "favorite_pub_time_snapshot")),
    categorySnapshot: nullableString(read(row, "favorite_category_snapshot")),
    tagsJsonSnapshot: nullableString(read(row, "favorite_tags_json_snapshot")),
    snapshotQuality: normalizeSnapshotQuality(read(row, "favorite_snapshot_quality")),
    lastHydratedAt: nullableString(read(row, "favorite_last_hydrated_at")),
    createdAt: String(read(row, "favorite_created_at")),
    updatedAt: String(read(row, "favorite_updated_at"))
  };
}

function mapTrack(row: unknown): Track {
  return {
    id: Number(read(row, "id")),
    candidateId: Number(read(row, "candidate_id")),
    bvid: String(read(row, "bvid")),
    title: String(read(row, "title")),
    sourceUrl: String(read(row, "source_url")),
    kernelJobId: nullableString(read(row, "kernel_job_id")),
    artifactName: nullableString(read(row, "artifact_name")),
    artifactSha256: nullableString(read(row, "artifact_sha256")),
    artifactSizeBytes: nullableNumber(read(row, "artifact_size_bytes")),
    artifactMimeType: nullableString(read(row, "artifact_mime_type")),
    durationSeconds: nullableNumber(read(row, "duration_seconds")),
    status: String(read(row, "status")) as TrackStatus,
    failureReason: nullableString(read(row, "failure_reason")),
    expiresAt: nullableString(read(row, "expires_at")),
    createdAt: String(read(row, "created_at")),
    updatedAt: String(read(row, "updated_at"))
  };
}

function read(row: unknown, key: string): SqlValue {
  if (!row) {
    return null;
  }
  const record = row as Record<string, SqlValue>;
  return record[key] ?? null;
}

function nullableString(value: SqlValue): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

function nullableNumber(value: SqlValue): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeSnapshotQuality(value: SqlValue): FavoriteVideo["snapshotQuality"] {
  return value === "complete" || value === "partial" ? value : "minimal";
}
