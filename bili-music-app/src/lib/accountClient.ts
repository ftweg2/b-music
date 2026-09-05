import { accountChanged } from "./accountEvents";

export type ClientAccount = {
  appOwnerId: string; sessionKey: string; libraryMode: "local" | "account";
  loggedIn: boolean; biliUid?: string | null; nickname?: string | null;
};
export const ACCOUNT_STATUS_EVENT = "bili-music:account-status";
let current: ClientAccount | null = null;
let pending: Promise<ClientAccount> | null = null;

export function publishClientAccount(value: ClientAccount): void {
  if (!value || typeof value.appOwnerId !== "string" || typeof value.sessionKey !== "string") return;
  const previous = current;
  current = value;
  if(previous&&Object.keys(previous).length===Object.keys(value).length&&Object.entries(value).every(([key,entry])=>Object.is((previous as unknown as Record<string,unknown>)[key],entry)))return;
  window.dispatchEvent(new CustomEvent(ACCOUNT_STATUS_EVENT, {detail:value}));
  if (previous && (previous.appOwnerId !== value.appOwnerId || previous.sessionKey !== value.sessionKey)) accountChanged();
}
export function knownClientAccount(): ClientAccount | null { return current; }
export async function refreshClientAccount(): Promise<ClientAccount> {
  if (!pending) pending = (async () => {
    const response = await fetch("/api/kernel/login/status", {cache:"no-store",signal:AbortSignal.timeout(12000)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法确认当前账号");
    publishClientAccount(data);
    return data as ClientAccount;
  })().finally(() => {pending=null;});
  return pending;
}
export async function ensureClientAccount(): Promise<ClientAccount> { return current ?? refreshClientAccount(); }

/** Account context prevents an old tab from writing into a newly selected account. */
export async function accountFetch(input: string, init?: RequestInit): Promise<Response> {
  const account = await ensureClientAccount();
  init?.signal?.throwIfAborted();
  const headers = new Headers(init?.headers);
  headers.set("x-account-context", account.sessionKey);
  const response = await fetch(input, {...init,headers});
  const loginMutation=init?.method?.toUpperCase()==="POST"&&/^\/api\/kernel\/login\/(start|logout)$/.test(input);
  if(response.ok && current && current.sessionKey!==account.sessionKey && !loginMutation){
    await response.body?.cancel();
    throw new Error("账号已变化，已忽略旧账号的响应");
  }
  if (response.status === 409 && response.headers.get("x-error-code") === "ACCOUNT_CHANGED") {
    void refreshClientAccount().catch(() => undefined);
  }
  return response;
}
