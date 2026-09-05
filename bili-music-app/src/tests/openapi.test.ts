import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { API_ROUTES } from "../lib/apiRoutes";
import { openApiDocument } from "../lib/openapi";

test("OpenAPI covers every implemented application API operation", () => {
  const directory = path.join(process.cwd(), "src/app/api");
  const actual: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === "route.ts") {
        const route = "/api" + path.relative(directory, path.dirname(file)).replaceAll("\\", "/").replace(/^(.+)$/, "/$1").replace(/\[([^\]]+)\]/g, "{$1}");
        if (route === "/api/openapi.json") continue;
        const code = fs.readFileSync(file, "utf8");
        for (const match of code.matchAll(/export const (GET|POST|PATCH|PUT|DELETE|HEAD) = apiEndpoint/g)) actual.push(match[1] + " " + route);
      }
    }
  }
  walk(directory);
  const expected = API_ROUTES.flatMap((route) => route.methods.map((method) => method + " " + route.path));
  assert.deepEqual(actual.sort(), [...expected].sort());
  const document = openApiDocument();
  for (const route of API_ROUTES) for (const method of route.methods) assert.ok(document.paths[route.path][method.toLowerCase()]);
});
test("OpenAPI references resolve and operation IDs are unique", () => {
  const document = openApiDocument();
  const ids: string[] = [];
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string") {
      const name = record.$ref.replace("#/components/schemas/", "");
      assert.ok(document.components.schemas[name], "missing schema: " + name);
    }
    if (typeof record.operationId === "string") ids.push(record.operationId);
    Object.values(record).forEach(visit);
  }
  visit(document);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(document.openapi, "3.1.0");
});
