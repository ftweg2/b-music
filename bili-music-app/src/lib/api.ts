import { randomUUID } from "node:crypto";
import { API_VERSION, API_REVISION } from "./apiCapabilities";
import { sanitizeText } from "./sanitize";
import { withAccountRequest, type AccountRequest } from "./accountRequest";

export const MAX_JSON_BYTES = 64 * 1024;
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false, public details?: Record<string, string>) {
    super(message);
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  // Keep legacy text/plain JSON callers working; never interpret form bodies as JSON.
  if (type && type !== "application/json" && type !== "text/plain" && !type.endsWith("+json")) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "请使用 application/json 请求体");
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_JSON_BYTES) throw new ApiError(413, "REQUEST_TOO_LARGE", "请求体过大");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_JSON_BYTES) { await reader.cancel(); throw new ApiError(413, "REQUEST_TOO_LARGE", "请求体过大"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, "INVALID_JSON", "请求体不是有效的 JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "INVALID_BODY", "请求体必须是 JSON 对象");
  return body as Record<string, unknown>;
}

export function positiveId(value: unknown, field = "id"): number {
  const parsed = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ApiError(400, "INVALID_ID", `${field} 必须是正整数`, false, { [field]: "positive integer required" });
  }
  return parsed;
}
export function queryInteger(params: URLSearchParams, field: string, fallback: number, min: number, max: number): number {
  const value = params.get(field);
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new ApiError(400, "INVALID_PARAMETER", `${field} 必须是整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ApiError(400, "INVALID_PARAMETER", `${field} 必须在 ${min}–${max} 之间`);
  return number;
}
export function optionalString(body: Record<string, unknown>, field: string, maximum: number): string | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || value.length > maximum) throw new ApiError(400, "INVALID_PARAMETER", `${field} 必须是最多 ${maximum} 字符的文字`);
  return value;
}

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null; // Native clients do not need browser-origin headers.
  // Next may normalize request.url to localhost although the browser used a
  // loopback IP or LAN hostname. Host is set by the browser, unlike Origin.
  // Do not trust forwarded host/protocol headers from an unconfigured proxy.
  try {
    const incoming = new URL(request.url);
    const expected = request.headers.get("host")
      ? new URL(incoming.protocol + "//" + request.headers.get("host")).origin
      : incoming.origin;
    if (origin === expected) return origin;
  } catch { /* Invalid headers do not grant same-origin access. */ }
  const configured = (process.env.APP_ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (origin !== "null" && configured.includes(origin)) return origin;
  return null;
}
function headersFor(request: Request, headers: Headers, requestId: string): void {
  headers.set("x-request-id", requestId);
  headers.set("x-api-version", API_VERSION);
  headers.set("x-api-revision", API_REVISION);
  headers.set("x-content-type-options", "nosniff");
  headers.set("vary", [headers.get("vary"), "Origin"].filter(Boolean).join(", "));
  const origin = allowedOrigin(request);
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-expose-headers", "Content-Length, Content-Range, Accept-Ranges, ETag, Location, Retry-After, X-Request-Id, X-API-Version, X-API-Revision, X-Content-SHA256, X-File-Size, X-Artifact-Expires-At, X-Account-Id, X-Account-Context");
  }
}
const STATUS_CODES: Record<number, string> = {
  400: "INVALID_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT", 410: "RESOURCE_EXPIRED", 413: "REQUEST_TOO_LARGE", 415: "UNSUPPORTED_MEDIA_TYPE",
  416: "INVALID_RANGE", 422: "VALIDATION_ERROR", 429: "RATE_LIMITED", 502: "UPSTREAM_ERROR", 503: "SERVICE_UNAVAILABLE", 504: "UPSTREAM_TIMEOUT",
};

export function apiEndpoint<Args extends unknown[]>(method: string, handler: (...args: Args) => Response | Promise<Response>): (...args: Args) => Promise<Response> {
  return async (...args: Args): Promise<Response> => {
    const incoming = args[0];
    const request = incoming instanceof Request ? incoming : new Request("http://localhost/api", { method });
    const supplied = request.headers.get("x-request-id") || "";
    const requestId = /^[a-zA-Z0-9_-]{1,64}$/.test(supplied) ? supplied : randomUUID();
    const accountRequest: AccountRequest = { expectedContext: request.headers.get("x-account-context") };
    let response: Response;
    try {
      if (["POST", "PATCH", "PUT", "DELETE"].includes(method) && request.headers.has("origin") && !allowedOrigin(request)) {
        throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "不允许跨站修改数据");
      }
      response = await withAccountRequest(accountRequest, () => handler(...args));
    } catch (error) {
      const known = error instanceof ApiError;
      response = Response.json({
        error: known ? error.message : "服务暂时不可用，请稍后重试",
        code: known ? error.code : "INTERNAL_ERROR",
        retryable: known ? error.retryable : true,
        ...(known && error.details ? { details: error.details } : {}),
      }, { status: known ? error.status : 500 });
      if (!known) console.error("[api]", requestId, sanitizeText(error instanceof Error ? error.message : error));
    }
    const headers = new Headers(response.headers);
    headersFor(request, headers, requestId);
    if (accountRequest.resolved) {
      headers.set("x-account-id", accountRequest.resolved.appOwnerId);
      headers.set("x-account-context", accountRequest.resolved.sessionKey);
    }
    if (response.status >= 400) {
      const payload = response.headers.get("content-type")?.includes("json") ? await response.json().catch(() => ({})) : {};
      if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
      const message = typeof payload.error === "string" ? payload.error : typeof payload.detail === "string" ? payload.detail : "请求失败，请检查参数或稍后重试";
      const errorBody = {
        ...payload, error: message, code: typeof payload.code === "string" ? payload.code : STATUS_CODES[response.status] || "INTERNAL_ERROR",
        retryable: typeof payload.retryable === "boolean" ? payload.retryable : headers.has("retry-after") || response.status === 429 || response.status >= 500,
        requestId,
      };
      headers.delete("content-length"); headers.delete("content-disposition");
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set("cache-control", "private, no-store");
      headers.set("x-error-code", errorBody.code);
      return new Response(method === "HEAD" ? null : JSON.stringify(errorBody), { status: response.status, headers });
    }
    if (headers.get("content-type")?.includes("json")) headers.set("cache-control", "private, no-store");
    return new Response(method === "HEAD" ? null : response.body, { status: response.status, headers });
  };
}

export function apiOptions(methods: string[]) {
  const allowed = [...new Set([...methods, ...(methods.includes("GET") ? ["HEAD"] : []), "OPTIONS"])];
  return apiEndpoint("OPTIONS", (request: Request) => {
    if (request.headers.has("origin") && !allowedOrigin(request)) throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "不允许此来源访问");
    return new Response(null, { status: 204, headers: {
      allow: allowed.join(", "), "access-control-allow-methods": allowed.join(", "),
      "access-control-allow-headers": "Content-Type, Authorization, Idempotency-Key, Range, If-Range, If-None-Match, If-Modified-Since, X-Request-Id, X-Account-Context",
      "access-control-max-age": "600",
    } });
  });
}
