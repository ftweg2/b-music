import { AsyncLocalStorage } from "node:async_hooks";

export type AccountRequest = {
  expectedContext: string | null;
  identity?: Promise<unknown>;
  resolved?: { appOwnerId: string; sessionKey: string };
};
const requests = new AsyncLocalStorage<AccountRequest>();
export function withAccountRequest<T>(state: AccountRequest, action: () => T): T {
  return requests.run(state, action);
}
export function activeAccountRequest(): AccountRequest | undefined { return requests.getStore(); }
export async function readAccountOnce<T extends {appOwnerId: string; sessionKey: string}>(read: () => Promise<T>): Promise<T> {
  const state = requests.getStore();
  if (!state) return read();
  state.identity ??= read().then(value => { state.resolved = value; return value; });
  return state.identity as Promise<T>;
}
