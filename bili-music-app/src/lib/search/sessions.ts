import { randomUUID } from "node:crypto";
import { getDatabase } from "../db";
import type { CandidateVideo } from "../models";
import { MAX_SEARCH_PAGES, validTotalPages } from "./pagination";

const SESSION_TTL_MS = 30 * 60_000;
export class SearchSnapshotError extends Error {}
export type SearchContext = { ownerId: string; keyword: string; provider: string; useRemote: boolean; limit: number; sessionKey?: string };
export type SearchSession = { id: string; context: SearchContext; totalPages?: number; localPool?: CandidateVideo[] };
export type FrozenSearchPage = { candidates: CandidateVideo[]; hasNextPage: boolean; duplicatesRemoved: number };

function contextKey(context: SearchContext): string {
  return JSON.stringify([context.keyword, context.provider, context.useRemote, context.limit, context.sessionKey ?? null]);
}
function transaction<T>(action: () => T): T {
  const db = getDatabase(); db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function searchSession(context: SearchContext, id?: string): SearchSession {
  if (id) return readSession(context, id);
  return transaction(() => {
    const db = getDatabase();
    const now = new Date().toISOString();
    // Only derived search snapshots expire, never favorites, playlists or source metadata.
    db.prepare("DELETE FROM search_sessions WHERE expires_at<=?").run(now);
    db.prepare("DELETE FROM search_sessions WHERE id IN (SELECT id FROM search_sessions WHERE owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 19)").run(context.ownerId);
    db.exec("DELETE FROM search_sessions WHERE id IN (SELECT id FROM search_sessions ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 79)");
    const createdId = randomUUID();
    db.prepare("INSERT INTO search_sessions (id,owner_id,context_key,created_at,expires_at) VALUES (?,?,?,?,?)")
      .run(createdId, context.ownerId, contextKey(context), now, new Date(Date.now() + SESSION_TTL_MS).toISOString());
    return { id: createdId, context };
  });
}
export function readSession(context: SearchContext, id: string): SearchSession {
  const row = getDatabase().prepare("SELECT * FROM search_sessions WHERE id=? AND owner_id=? AND expires_at>?")
    .get(id, context.ownerId, new Date().toISOString());
  if (!row || row.context_key !== contextKey(context)) throw new SearchSnapshotError("本次搜索已过期或条件发生变化，请重新搜索");
  return {
    id, context, totalPages: row.total_pages === null ? undefined : Number(row.total_pages),
    localPool: row.local_pool_json ? JSON.parse(String(row.local_pool_json)) : undefined,
  };
}
export function frozenPage(session: SearchSession, page: number): FrozenSearchPage | null {
  readSession(session.context, session.id);
  const row = getDatabase().prepare("SELECT * FROM search_session_pages WHERE search_id=? AND page=?").get(session.id, page);
  return row ? { candidates: JSON.parse(String(row.candidates_json)), hasNextPage: Boolean(row.has_next), duplicatesRemoved: Number(row.duplicates_removed) } : null;
}
export function freezeLocalPool(session: SearchSession, candidates: CandidateVideo[]): SearchSession {
  return transaction(() => {
    const current = readSession(session.context, session.id);
    if (current.localPool) return current;
    const maximum = session.context.limit * MAX_SEARCH_PAGES;
    const pool = candidates.slice(0, maximum);
    const totalPages = Math.ceil(candidates.length / session.context.limit);
    getDatabase().prepare("UPDATE search_sessions SET local_pool_json=?,total_pages=? WHERE id=?")
      .run(JSON.stringify(pool), totalPages, session.id);
    return { ...current, localPool: pool, totalPages };
  });
}
export function commitPage(session: SearchSession, page: number, input: FrozenSearchPage, totalPages?: number): FrozenSearchPage {
  return transaction(() => {
    readSession(session.context, session.id);
    const existing = frozenPage(session, page);
    if (existing) return existing;
    const rows = getDatabase().prepare("SELECT candidates_json FROM search_session_pages WHERE search_id=?").all(session.id);
    const seen = new Set<string>();
    for (const row of rows) for (const item of JSON.parse(String(row.candidates_json)) as CandidateVideo[]) seen.add(item.bvid);
    const candidates: CandidateVideo[] = [];
    let removed = input.duplicatesRemoved;
    for (const candidate of input.candidates) {
      if (seen.has(candidate.bvid)) { removed++; continue; }
      seen.add(candidate.bvid); candidates.push(candidate);
    }
    const result = { ...input, candidates, duplicatesRemoved: removed };
    getDatabase().prepare("INSERT INTO search_session_pages (search_id,page,candidates_json,has_next,duplicates_removed) VALUES (?,?,?,?,?)")
      .run(session.id, page, JSON.stringify(candidates), input.hasNextPage ? 1 : 0, removed);
    const knownTotal = validTotalPages(totalPages, candidates.length);
    if (knownTotal !== undefined) getDatabase().prepare("UPDATE search_sessions SET total_pages=COALESCE(total_pages,?) WHERE id=?").run(knownTotal, session.id);
    return result;
  });
}
