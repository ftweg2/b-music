import { getDefaultKernelLoginStatus } from "../kernelSession";
import { providerMode } from "./provider";

export class SearchSessionError extends Error {}

type LoginStatus = Awaited<ReturnType<typeof getDefaultKernelLoginStatus>>;
export async function resolveSearchSelection(
  choice: string | undefined,
  useRemote: boolean,
  page: number,
  sessionKey?: string,
  readStatus: () => Promise<LoginStatus> = getDefaultKernelLoginStatus,
): Promise<{ provider: string; profileId?: string; externalOwnerId?: string; sessionKey?: string; selectionNote?: string }> {
  if (!useRemote) return { provider: "bilibili" };
  const requested = choice || (providerMode() === "mock" ? "mock" : "auto");
  if (requested === "bilibili" || requested === "mock") return { provider: requested };
  if (requested === "auto" && page > 1) throw new SearchSessionError("请从第一页开始搜索，确定来源后再翻页");
  let status: LoginStatus;
  try { status = await readStatus(); }
  catch (error) {
    if (requested !== "auto") throw error;
    return { provider: "bilibili", selectionNote: "暂时无法读取内核登录状态，本次新搜索使用普通接口" };
  }
  if (requested === "auto" && !status.loggedIn) return { provider: "bilibili", selectionNote: "尚未登录，本次新搜索使用普通接口" };
  if (!status.loggedIn) throw new SearchSessionError("登录状态已失效，请重新登录，或从第一页改用普通搜索");
  if ((page > 1 && !sessionKey) || (sessionKey && sessionKey !== status.sessionKey)) {
    throw new SearchSessionError("账号或登录状态已变化，请从第一页重新搜索");
  }
  return { provider: "kernel", profileId: status.profileId, externalOwnerId: status.externalOwnerId, sessionKey: status.sessionKey };
}
