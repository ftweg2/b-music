import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { closeDatabaseForTests, createFavoriteVideo, createOrReuseTrack } from "../lib/db";
import { saveCandidateMetadata, normalizeRawSearchResult } from "../lib/search/cache";
import { GET as candidates } from "../app/api/candidates/route";
import { GET as favorites } from "../app/api/favorites/route";
import { GET as tracks } from "../app/api/tracks/route";
import { POST as createPlaylist } from "../app/api/playlists/route";
import { POST as interaction } from "../app/api/candidates/[id]/route";
import { POST as prepare } from "../app/api/tracks/prepare/route";
import { apiEndpoint, apiOptions, ApiError, MAX_JSON_BYTES } from "../lib/api";
import { API_REVISION } from "../lib/apiCapabilities";

function setup() {
  closeDatabaseForTests();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `mobile-basics-${crypto.randomUUID()}.sqlite`);
  process.env.APP_SINGLE_USER_MODE = "1"; process.env.APP_OWNER_ID = "local";
  return Array.from({length:3}, (_, index) => saveCandidateMetadata(normalizeRawSearchResult({
    bvid: "BV1test" + String(index + 1).padStart(5,"0"), title: "mobile " + index,
  }, "mobile", "test")));
}
function request(url: string, body: unknown, key?: string) {
  return new Request("http://localhost" + url, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });
}
test("list defaults return full intended pages rather than just one item", async () => {
  const songs = setup();
  for (const song of songs) { createFavoriteVideo(song.id); createOrReuseTrack(song); }
  const c = await (await candidates(new Request("http://localhost/api/candidates"))).json();
  const f = await (await favorites(new Request("http://localhost/api/favorites"))).json();
  const t = await (await tracks(new Request("http://localhost/api/tracks"))).json();
  assert.equal(c.candidates.length, 3); assert.equal(c.pagination.limit, 100);
  assert.equal(f.candidates.length, 3); assert.equal(f.pagination.limit, 100);
  assert.equal(t.tracks.length, 3); assert.equal(t.pagination.limit, 50);
});
test("invalid query, invalid JSON and oversized bodies yield typed mobile errors", async () => {
  setup();
  for (const value of ["-1","1.5","NaN","true","101"]) {
    const response = await candidates(new Request("http://localhost/api/candidates?limit=" + value));
    const data = await response.json();
    assert.equal(response.status,400); assert.equal(data.code,"INVALID_PARAMETER"); assert.ok(data.requestId);
  }
  const invalid = await createPlaylist(new Request("http://localhost/api/playlists", {method:"POST", body:"{"}));
  assert.equal((await invalid.json()).code, "INVALID_JSON");
  const large = await createPlaylist(request("/api/playlists", {name:"x".repeat(MAX_JSON_BYTES)}));
  assert.equal(large.status,413);
  assert.equal((await large.json()).code,"REQUEST_TOO_LARGE");
});
test("concurrent retries create one playlist and one interaction, and survive DB reopen", async () => {
  const songs = setup();
  const body = { name:"phone playlist", candidateId:songs[0].id };
  const responses = await Promise.all(Array.from({length:20}, () => createPlaylist(request("/api/playlists",body,"playlist-retry-001"))));
  const ids = await Promise.all(responses.map(async (response) => (await response.json()).playlist.id));
  assert.equal(new Set(ids).size,1);
  closeDatabaseForTests();
  assert.equal((await (await createPlaylist(request("/api/playlists",body,"playlist-retry-001"))).json()).playlist.id,ids[0]);
  const conflict = await createPlaylist(request("/api/playlists",{name:"different"},"playlist-retry-001"));
  assert.equal(conflict.status,409); assert.equal((await conflict.json()).code,"IDEMPOTENCY_CONFLICT");
  const interactions = await Promise.all(Array.from({length:20}, () => interaction(request("/api/candidates/"+songs[0].id,{action:"viewed"},"interaction-retry-001"),{params:Promise.resolve({id:String(songs[0].id)})})));
  const events = await Promise.all(interactions.map(async (response) => (await response.json()).interaction.id));
  assert.equal(new Set(events).size,1);
});
test("prepare rejects invalid strategy before contacting kernel", async () => {
  const songs = setup(); const original = globalThis.fetch; let calls=0;
  globalThis.fetch = async () => { calls++; throw new Error("must not contact kernel"); };
  try {
    for (const body of [
      {candidateId:true}, {candidateId:songs[0].id,strategyMode:"typo"},
      {candidateId:songs[0].id,strategyMode:"force"}, {candidateId:songs[0].id,strategyOrder:[]},
    ]) { assert.equal((await prepare(request("/api/tracks/prepare",body))).status,400); }
    assert.equal(calls,0);
  } finally { globalThis.fetch=original; }
});
test("all handled errors expose request tracing and revision without exposing internals", async () => {
  const endpoint = apiEndpoint("GET", () => { throw new ApiError(503,"TEMPORARY","稍后重试",true); });
  const response = await endpoint();
  const data = await response.json();
  assert.equal(response.headers.get("x-api-revision"),API_REVISION);
  assert.equal(response.headers.get("x-request-id"),data.requestId);
  assert.equal(data.retryable,true);
});
test("native clients require no Origin; configured WebViews receive CORS and preflight", async () => {
  const original=process.env.APP_ALLOWED_ORIGINS; process.env.APP_ALLOWED_ORIGINS="capacitor://localhost";
  try {
    const handler = apiOptions(["GET","POST"]);
    const result=await handler(new Request("http://localhost/api", {method:"OPTIONS",headers:{origin:"capacitor://localhost"}}));
    assert.equal(result.status,204); assert.equal(result.headers.get("access-control-allow-origin"),"capacitor://localhost");
    assert.match(result.headers.get("access-control-allow-headers")!,/Idempotency-Key/);
    assert.equal((await handler(new Request("http://localhost/api",{method:"OPTIONS",headers:{origin:"https://evil.example"}}))).status,403);
  } finally { if(original===undefined)delete process.env.APP_ALLOWED_ORIGINS;else process.env.APP_ALLOWED_ORIGINS=original; }
});

test("browser Host, not Next's normalized localhost URL, determines same-origin mutations", async () => {
  const endpoint=apiEndpoint("POST",(request:Request)=>Response.json({ok:true}));
  const local=await endpoint(new Request("http://localhost:3000/api",{
    method:"POST",headers:{host:"127.0.0.1:3000",origin:"http://127.0.0.1:3000"},
  }));
  assert.equal(local.status,200);
  const foreign=await endpoint(new Request("http://localhost:3000/api",{
    method:"POST",headers:{host:"127.0.0.1:3000",origin:"https://evil.example","x-forwarded-host":"evil.example"},
  }));
  assert.equal(foreign.status,403);
});
