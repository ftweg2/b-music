// Test-only custom Next server. No test controls are included in the application.
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

if (process.env.B_MUSIC_HTTP_FIXTURE !== "isolated-only") throw new Error("Fixture disabled");
const database = path.resolve(process.env.DATABASE_PATH || "");
if (!database.startsWith(path.join(os.tmpdir(), "b-music-http-")) || !database.endsWith(".sqlite")) throw new Error("Isolated database required");
const kernel = new URL(process.env.KERNEL_BASE_URL);
if (kernel.hostname !== "127.0.0.1" || kernel.port !== "8100") throw new Error("Isolated kernel required");
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  let target = url;
  if (url.hostname === "api.bilibili.com") target = new URL("/__fixture/upstream" + url.pathname + url.search, kernel);
  else if (/^i[012]\.hdslb\.com$/.test(url.hostname)) target = new URL("/__fixture/image/" + url.pathname.split("/").at(-1), kernel);
  else if (url.origin !== kernel.origin) throw new Error("Fixture refuses external network access: " + url.hostname);
  return originalFetch(input instanceof Request ? new Request(target, input) : target, init);
};
const appDir = path.resolve(import.meta.dirname, "../../bili-music-app");
const require = createRequire(path.join(appDir, "package.json"));
const next = require("next");
const app = next({ dev:false, dir:appDir });
await app.prepare();
const server = http.createServer(app.getRequestHandler());
server.listen(3100,"127.0.0.1",() => console.log("Isolated acceptance app http://127.0.0.1:3100"));
for (const signal of ["SIGINT","SIGTERM"]) process.on(signal, () => {
  server.close(async () => { await app.close(); process.exit(0); });
});
