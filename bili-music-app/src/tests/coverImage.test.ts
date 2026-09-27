import assert from "node:assert/strict";
import test from "node:test";
import { coverThumbnail } from "../lib/coverImage";

const ORIGINAL = "https://i0.hdslb.com/bfs/archive/b72e06e408b1636bb9ca8df55a171e44d6ba1702.jpg";

test("Bilibili covers are requested at the size each view shows", () => {
  assert.equal(coverThumbnail(ORIGINAL, "card"), ORIGINAL + "@440w_400h_1c.webp");
  assert.equal(coverThumbnail(ORIGINAL, "player"), ORIGINAL + "@120w_120h_1c.webp");
  assert.equal(coverThumbnail("//i2.hdslb.com/bfs/archive/x.png", "detail"), "https://i2.hdslb.com/bfs/archive/x.png@600w_600h_1c.webp");
  assert.equal(coverThumbnail("http://i1.hdslb.com/bfs/face/a.jpg", "playlist"), "http://i1.hdslb.com/bfs/face/a.jpg@400w_400h_1c.webp");
});

test("other covers and already-sized URLs are left alone", () => {
  assert.equal(coverThumbnail("/api/covers/DY7684625501147732905", "card"), "/api/covers/DY7684625501147732905");
  assert.equal(coverThumbnail(ORIGINAL + "@672w_378h_1c.webp", "card"), ORIGINAL + "@672w_378h_1c.webp");
  assert.equal(coverThumbnail(ORIGINAL + "?x=1", "card"), ORIGINAL + "?x=1");
  assert.equal(coverThumbnail("https://example.com/bfs/a.jpg", "card"), "https://example.com/bfs/a.jpg");
  assert.equal(coverThumbnail("https://i0.hdslb.com/other/a.jpg", "card"), "https://i0.hdslb.com/other/a.jpg");
  assert.equal(coverThumbnail(null, "card"), null);
  assert.equal(coverThumbnail("", "card"), null);
});
