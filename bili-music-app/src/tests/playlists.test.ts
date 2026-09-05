import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { closeDatabaseForTests, getDatabase, createFavoriteVideo, listFavoriteVideos, createPreferredCreator } from "../lib/db";
import { saveCandidateMetadata, normalizeRawSearchResult, runSearch } from "../lib/search/cache";
import { followedFirst } from "../lib/search/order";
import { createPlaylist, listPlaylists, getPlaylist, getPlaylistDetail, editPlaylist, addPlaylistItem, removePlaylistItem, deletePlaylist, reorderPlaylist, PlaylistError, MAX_PLAYLISTS, MAX_PLAYLIST_ITEMS, positiveId } from "../lib/playlists";
import { buildPlaylistQueue } from "../lib/clientPlayback";
import { POST as createRoute } from "../app/api/playlists/route";
import { GET as detailRoute, PATCH as editRoute } from "../app/api/playlists/[id]/route";

function setup() {
  closeDatabaseForTests();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `b-music-playlists-${crypto.randomUUID()}.sqlite`);
  process.env.APP_SINGLE_USER_MODE = "1"; process.env.APP_OWNER_ID = "local";
}
function candidate(suffix = "1", creatorMid = "111") {
  return saveCandidateMetadata(normalizeRawSearchResult({
    bvid: "BV1test" + suffix.padStart(5, "0"), title: "piano " + suffix,
    creatorMid, creatorName: "Creator " + creatorMid, durationSeconds: 240,
    coverUrl: "https://i0.hdslb.com/bfs/archive/example.jpg",
  }, "piano", "test"));
}
const denied = (error: unknown) => error instanceof PlaylistError && error.status === 404;

test("playlists persist independently from favorites and across database reopen", () => {
  setup(); const song = candidate();
  const playlist = createPlaylist("local", { name: "夜晚", description: "一首歌的时间", candidateId: song.id });
  closeDatabaseForTests();
  assert.equal(getPlaylistDetail(playlist.id, "local").items[0].candidate.bvid, song.bvid);
  assert.equal(listFavoriteVideos(10).length, 0);
  assert.equal(listPlaylists("local")[0].trackCount, 1);
});
test("every playlist read and mutation is owner-scoped", () => {
  setup(); const song = candidate(); const playlist = createPlaylist("one", { name: "private", candidateId: song.id });
  const item = getPlaylistDetail(playlist.id, "one").items[0];
  assert.deepEqual(listPlaylists("two"), []);
  for (const action of [
    () => getPlaylistDetail(playlist.id, "two"), () => editPlaylist(playlist.id, "two", { name: "changed" }),
    () => addPlaylistItem(playlist.id, "two", song.id), () => deletePlaylist(playlist.id, "two"),
    () => removePlaylistItem(playlist.id, "two", item.id), () => reorderPlaylist(playlist.id, "two", [item.id]),
  ]) assert.throws(action, denied);
  assert.equal(getPlaylist(playlist.id, "one").name, "private");
});
test("duplicate additions are idempotent by BV and songs can belong to multiple playlists", () => {
  setup(); const song = candidate(); const first = createPlaylist("local", { name: "first" }); const second = createPlaylist("local", { name: "second" });
  assert.equal(addPlaylistItem(first.id, "local", song.id).added, true);
  assert.equal(addPlaylistItem(first.id, "local", song.id).added, false);
  assert.equal(addPlaylistItem(second.id, "local", song.id).added, true);
  assert.equal(getPlaylist(first.id, "local").trackCount, 1);
});
test("creating a playlist with an invalid initial song rolls the entire change back", () => {
  setup();
  assert.throws(() => createPlaylist("local", { name: "should not exist", candidateId: 999 }), denied);
  assert.equal(listPlaylists("local").length, 0);
});
test("playlist metadata snapshots survive deletion of the candidate cache", () => {
  setup(); const song = candidate(); const playlist = createPlaylist("local", { name: "durable", candidateId: song.id });
  const itemId = getPlaylistDetail(playlist.id, "local").items[0].id;
  getDatabase().prepare("DELETE FROM candidate_videos WHERE id=?").run(song.id);
  const restored = getPlaylistDetail(playlist.id, "local").items[0];
  assert.equal(restored.id, itemId); assert.equal(restored.candidate.title, song.title);
  assert.equal(restored.candidate.bvid, song.bvid); assert.equal(restored.candidate.durationSeconds, 240);
  assert.notEqual(restored.candidate.id, song.id);
  assert.equal(addPlaylistItem(playlist.id, "local", restored.candidate.id).added, false);
  const raw = JSON.parse(String(getDatabase().prepare("SELECT snapshot_json FROM playlist_items WHERE id=?").get(itemId)?.snapshot_json));
  assert.equal("media" in raw, false); assert.equal("scoreBreakdown" in raw, false);
});
test("reordering persists and rejects stale membership, duplicates and foreign item IDs", () => {
  setup(); const one = candidate("1"), two = candidate("2"), three = candidate("3");
  const playlist = createPlaylist("local", { name: "order", candidateId: one.id });
  addPlaylistItem(playlist.id, "local", two.id); addPlaylistItem(playlist.id, "local", three.id);
  const ids = getPlaylistDetail(playlist.id, "local").items.map((item) => item.id);
  reorderPlaylist(playlist.id, "local", [...ids].reverse());
  assert.deepEqual(getPlaylistDetail(playlist.id, "local").items.map((item) => item.id), [...ids].reverse());
  assert.throws(() => reorderPlaylist(playlist.id, "local", [ids[0], ids[0], ids[1]]));
  assert.throws(() => reorderPlaylist(playlist.id, "local", [ids[0]]), (error) => error instanceof PlaylistError && error.status === 409);
  assert.throws(() => reorderPlaylist(playlist.id, "local", [ids[0], ids[1], 999]));
});
test("removing a track or playlist leaves favorites and other playlists untouched", () => {
  setup(); const song = candidate(); createFavoriteVideo(song.id);
  const first = createPlaylist("local", { name: "first", candidateId: song.id });
  const second = createPlaylist("local", { name: "second", candidateId: song.id });
  removePlaylistItem(first.id, "local", getPlaylistDetail(first.id, "local").items[0].id);
  assert.equal(getPlaylist(first.id, "local").trackCount, 0);
  deletePlaylist(first.id, "local");
  assert.equal(getPlaylist(second.id, "local").trackCount, 1);
  assert.equal(listFavoriteVideos(10).length, 1);
  deletePlaylist(second.id, "local");
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM playlist_items").get()?.n, 0);
  assert.equal(listFavoriteVideos(10).length, 1);
});
test("playlist names, descriptions and IDs are validated without erasing valid data", () => {
  setup(); const playlist = createPlaylist("local", { name: "  Calm  ", description: " old " });
  assert.equal(playlist.name, "Calm");
  assert.throws(() => editPlaylist(playlist.id, "local", { name: " " }));
  assert.throws(() => createPlaylist("local", { name: "x".repeat(81) }));
  assert.throws(() => editPlaylist(playlist.id, "local", { description: "x".repeat(501) }));
  for (const value of [0, -1, 1.5, true, null, [], "1abc", Infinity]) assert.throws(() => positiveId(value));
  assert.equal(editPlaylist(playlist.id, "local", { description: "" }).description, "");
  assert.equal(getPlaylist(playlist.id, "local").name, "Calm");
});
test("playlist and item caps are enforced transactionally", () => {
  setup(); const song = candidate(); const playlist = createPlaylist("local", { name: "full" });
  const db = getDatabase();
  const insert = db.prepare("INSERT INTO playlist_items (playlist_id,bvid,snapshot_json,position,added_at) VALUES (?,?,?,?,?)");
  for (let index = 0; index < MAX_PLAYLIST_ITEMS; index++) insert.run(playlist.id, "BV-cap-" + index, "{}", index, "now");
  assert.throws(() => addPlaylistItem(playlist.id, "local", song.id), (error) => error instanceof PlaylistError && error.status === 409);
  const addList = db.prepare("INSERT INTO playlists (external_owner_id,name,description,created_at,updated_at) VALUES ('local',?,'','now','now')");
  for (let index = 1; index < MAX_PLAYLISTS; index++) addList.run("List " + index);
  assert.throws(() => createPlaylist("local", { name: "overflow" }), (error) => error instanceof PlaylistError && error.status === 409);
});
test("playlist queue building preserves order, deduplicates BV IDs and performs no extraction", () => {
  setup(); const one = candidate("1"), two = candidate("2");
  const playlist = createPlaylist("local", { name: "queue", candidateId: one.id }); addPlaylistItem(playlist.id, "local", two.id);
  const items = getPlaylistDetail(playlist.id, "local").items.map((item) => item.candidate);
  assert.deepEqual(buildPlaylistQueue([items[1], items[0], items[1]]).map((item) => item.bvid), [two.bvid, one.bvid]);
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM tracks").get()?.n, 0);
});
test("local followed priority is applied before pagination and is owner specific", async () => {
  setup(); const followed = candidate("1", "222"); candidate("2"); candidate("3");
  createPreferredCreator({ biliMid: "222", name: "Followed", externalOwnerId: "one" });
  const request = { keyword: "piano", useRemote: false, limit: 1, appOwnerId: "one" };
  assert.equal((await runSearch(request)).candidates[0].bvid, followed.bvid);
  assert.notEqual((await runSearch({ ...request, appOwnerId: "two" })).candidates[0].bvid, followed.bvid);
});
test("followed partition preserves order inside both groups without mutation", () => {
  const original = [{ n: 1, followed: false }, { n: 2, followed: true }, { n: 3, followed: false }, { n: 4, followed: true }];
  assert.deepEqual(followedFirst(original, (item) => item.followed).map((item) => item.n), [2, 4, 1, 3]);
  assert.deepEqual(original.map((item) => item.n), [1, 2, 3, 4]);
});
test("playlist routes expose durable CRUD and reject malformed requests", async () => {
  setup();
  const response = await createRoute(new Request("http://localhost/api/playlists", { method: "POST", body: JSON.stringify({ name: "Route test" }) }));
  assert.equal(response.status, 201);
  const { playlist } = await response.json();
  const context = { params: Promise.resolve({ id: String(playlist.id) }) };
  assert.equal((await detailRoute(new Request("http://localhost"), context)).status, 200);
  const edited = await editRoute(new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }), context);
  assert.equal((await edited.json()).playlist.name, "Renamed");
  assert.equal((await createRoute(new Request("http://localhost", { method: "POST", body: "null" }))).status, 400);
  assert.equal((await createRoute(new Request("http://localhost", { method: "POST", body: "{" }))).status, 400);
});
