import { NextResponse } from "next/server";

import { getDatabase, markExpiredReadyTracks } from "@/lib/db";

export const runtime = "nodejs";

export function GET() {
  const expiredTracksMarked = markExpiredReadyTracks();
  const db = getDatabase();
  const counts = {
    candidates: scalar("SELECT COUNT(*) FROM candidate_videos"),
    favorites: scalar("SELECT COUNT(*) FROM favorite_videos"),
    tracks: scalar("SELECT COUNT(*) FROM tracks"),
    interactions: scalar("SELECT COUNT(*) FROM candidate_interactions")
  };
  return NextResponse.json({
    status: "ok",
    expiredTracksMarked,
    counts,
    dataHealth: {
      favoriteCacheMisses: scalar(
        `SELECT COUNT(*) FROM favorite_videos f
         LEFT JOIN candidate_videos c ON c.bvid = f.bvid
         WHERE c.id IS NULL`
      ),
      favoritesMissingStableBvid: scalar("SELECT COUNT(*) FROM favorite_videos WHERE bvid IS NULL OR bvid=''"),
      weakCandidates: scalar(
        `SELECT COUNT(*) FROM candidate_videos
         WHERE bvid IS NULL OR bvid='' OR title IS NULL OR title='' OR source_url IS NULL OR source_url=''`
      ),
      expiredReadyTracks: scalar(
        `SELECT COUNT(*) FROM tracks
         WHERE status='ready' AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')`
      ),
      failedTracks: scalar("SELECT COUNT(*) FROM tracks WHERE status='failed'")
    }
  });

  function scalar(sql: string): number {
    const row = db.prepare(sql).get() as Record<string, number> | undefined;
    return Number(row?.["COUNT(*)"] ?? 0);
  }
}
