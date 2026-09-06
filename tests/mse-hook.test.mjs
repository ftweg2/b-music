import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const hook = fs.readFileSync(new URL("../kernel/app/browser/mse_hook.js", import.meta.url), "utf8");

function fixture({ native = false, limits, receive } = {}) {
  const captured = [];
  const sandbox = vm.createContext({
    btoa: value => Buffer.from(value, "latin1").toString("base64"),
    encode: bytes => Buffer.from(bytes).toString("base64"),
    receive: receive ?? (value => { captured.push(value); }),
  });
  vm.runInContext(`
    globalThis.window = globalThis;
    globalThis.URL = { createObjectURL: () => "blob:test" };
    globalThis.MediaSource = class { addSourceBuffer() { return { appendBuffer(data) {
      this.originalCalls = (this.originalCalls || 0) + 1;
      if (ArrayBuffer.isView(data)) new Uint8Array(data.buffer, data.byteOffset, data.byteLength).fill(0);
      else new Uint8Array(data).fill(0);
      return 42;
    }}; } };
    Uint8Array.prototype.toBase64 = ${native ? "function () { return encode(this); }" : "undefined"};
    ArrayBuffer.prototype.slice = function () { throw new Error("unnecessary buffer copy"); };
    window.__biliCtfAudioSegment = receive;
  `, sandbox);
  if (limits) sandbox.__BILI_CTF_AUDIO_MSE_LIMITS__ = limits;
  vm.runInContext(hook, sandbox);
  return { sandbox, captured, run: code => vm.runInContext(code, sandbox) };
}

for (const native of [false, true]) {
  test(`MSE encoder preserves bytes, offsets and append semantics (${native ? "native" : "fallback"})`, async () => {
    const f = fixture({ native });
    assert.equal(f.run(`
      globalThis.source = new MediaSource().addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
      const data = new Uint8Array([9, 1, 2, 253, 254, 255, 9]);
      source.appendBuffer(new DataView(data.buffer, 1, 5));
    `), 42);
    f.run(`source.appendBuffer(new Uint8Array([0, 127, 128, 255]).buffer);`);
    await f.run("window.__biliCtfAudioMseFinish()");
    assert.equal(Buffer.from(f.captured[0].dataBase64, "base64").toString("hex"), "0102fdfeff");
    assert.equal(Buffer.from(f.captured[1].dataBase64, "base64").toString("hex"), "007f80ff");
    assert.deepEqual(f.captured.map(item => [item.order, item.size]), [[0, 5], [1, 4]]);
    assert.equal(f.run("source.originalCalls"), 2);
  });
}

test("capture stops at configured bounds before encoding and does not interfere with the original player", async () => {
  const f = fixture({ native: true, limits: { segmentBytes: 3, totalBytes: 10, segments: 5 } });
  f.run(`globalThis.source = new MediaSource().addSourceBuffer("audio/mp4"); source.appendBuffer(new Uint8Array(4));`);
  await f.run("window.__biliCtfAudioMseFinish()");
  assert.equal(f.captured.length, 0);
  assert.equal(f.run("window.__BILI_CTF_AUDIO_MSE_STATS__.captureLimitExceeded"), true);
  assert.equal(f.run("source.originalCalls"), 1);
});

test("finish waits for accepted deliveries and prevents late capture", async () => {
  let release;
  const f = fixture({ receive: () => new Promise(resolve => { release = resolve; }) });
  f.run(`globalThis.source = new MediaSource().addSourceBuffer("audio/mp4"); source.appendBuffer(new Uint8Array([1]));`);
  let done = false;
  const finish = f.run("window.__biliCtfAudioMseFinish()").then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  f.run("source.appendBuffer(new Uint8Array([2]));");
  assert.equal(f.run("window.__BILI_CTF_AUDIO_MSE_STATS__.capturedCount"), 1);
  release(); await finish;
  assert.equal(done, true);
});

test("delivery errors are observed without unhandled rejection or silent success", async () => {
  const f = fixture({ receive: () => Promise.reject(new Error("disk full")) });
  f.run(`new MediaSource().addSourceBuffer("audio/mp4").appendBuffer(new Uint8Array([1]));`);
  await f.run("window.__biliCtfAudioMseFinish()");
  assert.equal(f.run("window.__BILI_CTF_AUDIO_MSE_STATS__.captureFailed"), true);
  assert.equal(f.run("window.__BILI_CTF_AUDIO_MSE_STATS__.errors[0].stage"), "segmentDelivery");
});

test("video buffers remain unmodified by capture and installing twice does not double-wrap", async () => {
  const f = fixture();
  vm.runInContext(hook, f.sandbox);
  f.run(`new MediaSource().addSourceBuffer("video/mp4").appendBuffer(new Uint8Array([1]));`);
  f.run(`new MediaSource().addSourceBuffer("audio/mp4").appendBuffer(new Uint8Array([2]));`);
  await f.run("window.__biliCtfAudioMseFinish()");
  assert.equal(f.captured.length, 1);
});
