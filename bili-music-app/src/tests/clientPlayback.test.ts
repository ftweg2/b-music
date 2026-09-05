import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlayerState, waitForPreparedTrack, delayWithSignal } from "../lib/clientPlayback";
import type { TrackApiResource } from "../lib/trackApi";

const item = { candidateId: 1, bvid: "BV1test00001", title: "piano", creatorName: null };
function track(status: TrackApiResource["status"]): TrackApiResource {
  return { id: 1, status, failureReason: status === "failed" ? "kernel failed" : null } as TrackApiResource;
}
test("saved player state is bounded, deduplicated and validated", () => {
  const restored = normalizePlayerState({ queue: [null, item, item, { ...item, candidateId: -1 }], currentIndex: 2, volume: 3, playbackMode: "invalid", history: "invalid" })!;
  assert.equal(restored.queue.length, 1);
  assert.equal(restored.currentIndex, 0);
  assert.equal(restored.volume, 1);
  assert.equal(restored.playbackMode, "sequence");
  assert.deepEqual(restored.history, []);
});
test("saved empty queue and invalid volumes are safe", () => {
  assert.equal(normalizePlayerState(null), null);
  assert.equal(normalizePlayerState({ queue: [], currentIndex: 8, volume: NaN })?.currentIndex, -1);
  assert.equal(normalizePlayerState({ volume: NaN })?.volume, .82);
});
test("polling is sequential and stops as soon as audio is ready", async () => {
  let calls = 0; const updates: string[] = [];
  const result = await waitForPreparedTrack({
    signal: new AbortController().signal, prepare: async () => track("preparing"),
    read: async () => { calls++; return track("ready"); },
    delay: async () => {}, onUpdate: (value) => updates.push(value.status),
  });
  assert.equal(result.status, "ready"); assert.equal(calls, 1);
  assert.deepEqual(updates, ["preparing", "ready"]);
});
test("terminal failure never schedules another poll", async () => {
  let reads = 0;
  await assert.rejects(waitForPreparedTrack({
    signal: new AbortController().signal, prepare: async () => track("failed"),
    read: async () => { reads++; return track("ready"); }, onUpdate: () => {},
  }), /kernel failed/);
  assert.equal(reads, 0);
});
test("switching tracks cancels old results before they can update the player", async () => {
  const controller = new AbortController(); let updates = 0;
  await assert.rejects(waitForPreparedTrack({
    signal: controller.signal, prepare: async () => { controller.abort(); return track("ready"); },
    read: async () => track("ready"), onUpdate: () => updates++,
  }));
  assert.equal(updates, 0);
});
test("cancellation during delay never performs another status request", async () => {
  const controller = new AbortController(); let reads = 0;
  await assert.rejects(waitForPreparedTrack({
    signal: controller.signal, prepare: async () => track("preparing"), onUpdate: () => {},
    delay: async () => { controller.abort(); },
    read: async () => { reads++; return track("ready"); },
  }));
  assert.equal(reads, 0);
});
test("poll timeout is terminal and bounded", async () => {
  await assert.rejects(waitForPreparedTrack({
    signal: new AbortController().signal, timeoutMs: 15,
    prepare: async () => track("preparing"), read: async () => track("preparing"),
    onUpdate: () => {},
  }), (error: Error) => error.name === "TimeoutError");
});
test("an already cancelled delay rejects without leaving a timer", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(delayWithSignal(5000, controller.signal));
});
