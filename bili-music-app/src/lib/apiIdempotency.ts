import { createHash } from "node:crypto";
import { ApiError } from "./api";
import { getDatabase } from "./db";

// These helpers run INSIDE the mutation's SQLite transaction, so a crash cannot
// commit the object while losing its receipt. Only library metadata is eligible.
function validate(key: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 必须为 8–128 位字母、数字或 ._:-");
}
function hash(input: unknown) { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
export function replayMutation<T>(ownerId: string, operation: string, key: string | undefined, input: unknown): T | undefined {
  if (!key) return undefined;
  validate(key);
  const db = getDatabase();
  db.prepare("DELETE FROM api_mutation_receipts WHERE expires_at<=?").run(new Date().toISOString());
  const row = db.prepare("SELECT * FROM api_mutation_receipts WHERE owner_id=? AND operation=? AND idempotency_key=?").get(ownerId, operation, key);
  if (row) {
    if (row.request_hash !== hash(input)) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "同一个 Idempotency-Key 不能用于不同请求");
    return JSON.parse(String(row.response_json)) as T;
  }
  const count = Number(db.prepare("SELECT COUNT(*) AS count FROM api_mutation_receipts").get()?.count);
  if (count >= 10000) throw new ApiError(429, "IDEMPOTENCY_CAPACITY", "重试记录暂时已满，请稍后再试", true);
  return undefined;
}
export function recordMutation(ownerId: string, operation: string, key: string | undefined, input: unknown, response: unknown): void {
  if (!key) return;
  getDatabase().prepare("INSERT INTO api_mutation_receipts (owner_id,operation,idempotency_key,request_hash,response_json,expires_at) VALUES (?,?,?,?,?,?)")
    .run(ownerId, operation, key, hash(input), JSON.stringify(response), new Date(Date.now() + 24 * 60 * 60_000).toISOString());
}
