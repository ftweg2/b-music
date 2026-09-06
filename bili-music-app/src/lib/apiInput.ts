import { ApiError, optionalString, positiveId } from "./api";
import type { CreatePreferredCreatorInput } from "./models";

export function booleanInput(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  throw new ApiError(400, "INVALID_PARAMETER", `${name} 必须是布尔值`);
}
export function integerInput(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > max) throw new ApiError(400, "INVALID_PARAMETER", `${name} 必须是 ${min}–${max} 之间的整数`);
  return number;
}
export function candidateReference(body: Record<string, unknown>): { candidateId?: number; bvid?: string } {
  const candidateId = body.candidateId === undefined || body.candidateId === null ? undefined : positiveId(body.candidateId, "candidateId");
  const value = body.bvid;
  if (value !== undefined && value !== null && (typeof value !== "string" || !/^BV[0-9A-Za-z]{10}$/.test(value))) throw new ApiError(400, "INVALID_BVID", "bvid 必须是有效的 BV 号");
  const bvid = typeof value === "string" ? value : undefined;
  if (!candidateId && !bvid) throw new ApiError(400, "CANDIDATE_REQUIRED", "请提供 candidateId 或 bvid");
  return { candidateId, bvid };
}
export function strategyInput(body: Record<string, unknown>): {
  strategyMode: "auto" | "force";
  strategy?: "api_dash" | "browser_network" | "mse_sourcebuffer";
  strategyOrder?: Array<"api_dash" | "browser_network" | "mse_sourcebuffer">;
} {
  const strategies = ["api_dash", "browser_network", "mse_sourcebuffer"] as const;
  const value = body.strategy;
  if (value !== undefined && (typeof value !== "string" || !(strategies as readonly string[]).includes(value))) throw new ApiError(400, "INVALID_STRATEGY", "不支持的音频处理策略");
  const strategy = value as (typeof strategies)[number] | undefined;
  if (body.strategyMode == null && body.strategy_mode == null && strategy === undefined &&
      body.strategyOrder == null && body.strategy_order == null) {
    return { strategyMode: "force", strategy: "api_dash" };
  }
  const mode = body.strategyMode ?? body.strategy_mode ?? (strategy ? "force" : "auto");
  if (mode !== "auto" && mode !== "force") throw new ApiError(400, "INVALID_STRATEGY_MODE", "strategyMode 必须是 auto 或 force");
  const order = body.strategyOrder ?? body.strategy_order;
  if (order !== undefined && (!Array.isArray(order) || !order.length || order.length > 3 || order.some((item) => !(strategies as readonly unknown[]).includes(item)))) throw new ApiError(400, "INVALID_STRATEGY_ORDER", "strategyOrder 必须包含 1–3 个有效策略");
  if (mode === "force" && !strategy) throw new ApiError(400, "STRATEGY_REQUIRED", "force 模式必须指定 strategy");
  if (mode === "auto" && strategy) throw new ApiError(400, "INVALID_STRATEGY_MODE", "auto 模式请使用 strategyOrder，不要同时指定 strategy");
  if (mode === "force" && order) throw new ApiError(400, "INVALID_STRATEGY_MODE", "force 模式不能指定 strategyOrder");
  return { strategyMode: mode, strategy, strategyOrder: order ? [...new Set(order as Array<(typeof strategies)[number]>)] : undefined };
}
export function creatorInput(body: Record<string, unknown>): CreatePreferredCreatorInput {
  const mid = body.biliMid;
  if (mid !== undefined && typeof mid !== "string" && !(typeof mid === "number" && Number.isSafeInteger(mid) && mid > 0)) throw new ApiError(400, "INVALID_CREATOR_ID", "biliMid 必须是数字字符串");
  return {
    biliMid: mid === undefined ? "" : String(mid), name: optionalString(body, "name", 200) ?? "",
    homepageUrl: optionalString(body, "homepageUrl", 1000), notes: optionalString(body, "notes", 500),
  };
}
export function creatorPatchInput(body: Record<string, unknown>): Partial<CreatePreferredCreatorInput> {
  if (Object.keys(body).some((key) => !["name", "homepageUrl", "notes"].includes(key))) {
    throw new ApiError(400, "INVALID_PARAMETER", "只能编辑 UP 名称、主页和备注");
  }
  const name = optionalString(body, "name", 200);
  const homepageUrl = optionalString(body, "homepageUrl", 1000);
  if (name !== undefined && (name === null || !name.trim())) throw new ApiError(400, "INVALID_PARAMETER", "UP 名称不能为空");
  if (homepageUrl === null) throw new ApiError(400, "INVALID_PARAMETER", "UP 主页必须是有效的主页链接");
  return { name: name ?? undefined, homepageUrl, notes: optionalString(body, "notes", 500) };
}
export function searchInput(body: Record<string, unknown>) {
  if (typeof body.keyword !== "string" || !body.keyword.trim() || body.keyword.length > 200) throw new ApiError(400, "INVALID_KEYWORD", "keyword 必须是 1–200 字符的搜索词");
  const provider = body.provider;
  if (provider !== undefined && provider !== null && (typeof provider !== "string" || !["auto", "bilibili", "kernel", "mock"].includes(provider))) throw new ApiError(400, "INVALID_PROVIDER", "不支持的搜索来源");
  if (provider === "mock" && process.env.SEARCH_PROVIDER !== "mock" && process.env.NODE_ENV !== "test") throw new ApiError(400, "INVALID_PROVIDER", "mock 来源仅用于测试");
  return {
    keyword: body.keyword.trim(), provider: typeof provider === "string" ? provider : undefined,
    useRemote: booleanInput(body.useRemote, false, "useRemote"), limit: integerInput(body.limit, 20, 1, 50, "limit"),
    page: integerInput(body.page, 1, 1, 10, "page"),
    sessionKey: optionalString(body, "sessionKey", 128) ?? undefined, searchId: optionalString(body, "searchId", 64) ?? undefined,
  };
}
