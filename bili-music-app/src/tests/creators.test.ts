import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { closeDatabaseForTests, createPreferredCreator } from "../lib/db";
import { addCreator, listCreators } from "../lib/creators";
import { PATCH } from "../app/api/creators/[id]/route";

test("listing followed creators never starts remote lookups or mutates their saved names", async () => {
  closeDatabaseForTests();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `b-music-creators-${crypto.randomUUID()}.sqlite`);
  createPreferredCreator({ biliMid: "123", name: "UP 123" });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("no network"); };
  try {
    assert.equal((await listCreators())[0].name, "UP 123");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test("creator links must identify an actual Bilibili space, not arbitrary digits", async () => {
  await assert.rejects(addCreator({ biliMid: "", name: "2026 music", homepageUrl: "https://evil.example/123" }), /UP 主 mid/);
  await assert.rejects(addCreator({ biliMid: "", name: "2026 music" }), /UP 主 mid/);
  const creator = await addCreator({ biliMid: "", name: "Saved", homepageUrl: "https://space.bilibili.com/123" });
  assert.equal(creator.biliMid, "123");
  assert.equal("priorityWeight" in creator, false);
});

test("editing a creator rejects invalid types and links without corrupting saved metadata", async () => {
  process.env.APP_SINGLE_USER_MODE = "1"; process.env.APP_OWNER_ID = "local";
  const creator = await addCreator({ biliMid: "456", name: "Original" });
  const edit = async (body: unknown) => PATCH(new Request("http://localhost/api/creators/" + creator.id, {
    method: "PATCH", body: JSON.stringify(body), headers: {"content-type":"application/json"},
  }), {params: Promise.resolve({id:String(creator.id)})});
  for (const body of [{name:42},{name:null},{name:" "},{notes:[]},{homepageUrl:"https://evil.example/456"},{homepageUrl:"https://space.bilibili.com/789"},{biliMid:"789"}]) {
    assert.equal((await edit(body)).status,400);
  }
  assert.equal((await listCreators()).find((row) => row.id === creator.id)?.name,"Original");
  const valid = await edit({name:"Updated",notes:null,homepageUrl:"https://space.bilibili.com/456?from=test"});
  assert.equal(valid.status,200);
  assert.equal((await valid.json()).creator.homepageUrl,"https://space.bilibili.com/456");
});
