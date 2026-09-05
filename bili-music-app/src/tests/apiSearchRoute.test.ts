import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeDatabaseForTests, createPreferredCreator, resetDatabaseForTests } from "../lib/db";
import { POST } from "../app/api/search/route";

test("API search route returns unscored mock candidates", async () => {
  process.env.SEARCH_PROVIDER = "mock";
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `bili-music-app-api-${Date.now()}-${Math.random()}.sqlite`);
  closeDatabaseForTests();
  resetDatabaseForTests();
  createPreferredCreator({
    biliMid: "111111",
    name: "Star Sea Music",
  });
  const request = new Request("http://localhost/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keyword: "night", useRemote: true, limit: 20 })
  });
  const response = await POST(request);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.candidates.length > 0, true);
  assert.equal(payload.candidates[0].creatorMid, "111111");
  closeDatabaseForTests();
});

test("API search route treats the string false as false", async () => {
  process.env.SEARCH_PROVIDER = "mock";
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `bili-music-app-api-false-${Date.now()}-${Math.random()}.sqlite`);
  closeDatabaseForTests();
  resetDatabaseForTests();
  const response = await POST(
    new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "night", useRemote: "false", limit: 20 })
    })
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.remoteUsed, false);
  closeDatabaseForTests();
});
