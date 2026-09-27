import { accountFetch } from "./accountClient";

export async function requestLoginAction<T>(url: "/api/kernel/login/start" | "/api/kernel/login/logout", body: object): Promise<T> {
  let response: Response;
  try {
    response = await accountFetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(url.endsWith("/start") ? 90000 : 25000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("登录请求超时，请稍后重试；已有待扫码会话会被复用，无需连续点击。");
    }
    throw new Error("无法连接登录服务，请检查网络后重试。");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : response.status >= 500 ?
      "登录服务暂时不可用，请稍后重试。" : "登录操作未完成，请刷新账号状态后重试。");
  }
  if (!data || typeof data !== "object") throw new Error("登录服务返回了无效响应，请稍后重试。");
  return data as T;
}
