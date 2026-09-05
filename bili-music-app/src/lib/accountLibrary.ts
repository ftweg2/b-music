import { getDatabase, nowIso } from "./db";

/** One-time metadata migration. Kernel owners and audio artifact references never change. */
export function migrateLegacyLibrary(sourceOwner: string, accountOwner: string): void {
  if (!/^bili:\d{1,24}$/.test(accountOwner)) throw new Error("Verified Bilibili owner required");
  const db = getDatabase();
  const key = "account-library-v1:" + sourceOwner;
  if(db.prepare("SELECT migration_key FROM library_migrations WHERE migration_key=?").get(key))return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT migration_key FROM library_migrations WHERE migration_key=?").get(key)) {
      if (sourceOwner !== accountOwner) {
        // Existing account entries win collisions. The original colliding rows
        // remain under the now-inactive legacy owner, never assigned to another account.
        for (const [table, uniqueKey] of [["favorite_videos", "bvid"], ["preferred_creators", "bili_mid"], ["tracks", "candidate_id"]]) {
          db.prepare(`UPDATE ${table} SET external_owner_id=? WHERE external_owner_id=?
            AND ${uniqueKey} NOT IN (SELECT ${uniqueKey} FROM ${table} WHERE external_owner_id=?)`)
            .run(accountOwner, sourceOwner, accountOwner);
        }
        for (const table of ["playlists", "candidate_interactions"]) {
          db.prepare(`UPDATE ${table} SET external_owner_id=? WHERE external_owner_id=?`).run(accountOwner, sourceOwner);
        }
        db.prepare(`UPDATE playback_ranges SET owner_id=? WHERE owner_id=?
          AND bvid NOT IN (SELECT bvid FROM playback_ranges WHERE owner_id=?)`).run(accountOwner, sourceOwner, accountOwner);
      }
      db.prepare("INSERT INTO library_migrations(migration_key,target_owner_id,created_at) VALUES(?,?,?)").run(key, accountOwner, nowIso());
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
