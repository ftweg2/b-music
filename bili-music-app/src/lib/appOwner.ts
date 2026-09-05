import type { NextResponse } from "next/server";

import { sanitizeText } from "./sanitize";
import { accountLibraryEnabled, appOwnerIdFromBiliUid, localAppOwnerId } from "./ownerIdentity";
import { getDefaultKernelLoginStatus } from "./kernelSession";
import { migrateLegacyLibrary } from "./accountLibrary";
import { activeAccountRequest } from "./accountRequest";
import { ApiError } from "./api";
export { appOwnerIdFromBiliUid } from "./ownerIdentity";

export const APP_OWNER_COOKIE = "bili_music_owner_id";
export const APP_OWNER_NAME_COOKIE = "bili_music_owner_name";

const LOCAL_OWNER_ID = "local";

export async function assertAccountContext(): Promise<void> {
  const expected=activeAccountRequest()?.expectedContext;
  if(!expected)return;
  const status=await getDefaultKernelLoginStatus();
  if(expected!==status.sessionKey)throw new ApiError(409,"ACCOUNT_CHANGED","账号已变化，请刷新后重试");
}

export async function currentAppOwnerId(): Promise<string> {
  if (!accountLibraryEnabled()) return localAppOwnerId();
  try {
    const status = await getDefaultKernelLoginStatus();
    const expected = activeAccountRequest()?.expectedContext;
    if (expected && expected !== status.sessionKey) throw new ApiError(409, "ACCOUNT_CHANGED", "账号已变化，请刷新后重试");
    if (status.loggedIn) migrateLegacyLibrary(localAppOwnerId(), status.appOwnerId);
    return status.appOwnerId;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Never reinterpret an unavailable identity service as another account or guest.
    throw new ApiError(503, "ACCOUNT_UNAVAILABLE", "暂时无法确认 Bilibili 账号，请稍后重试", true);
  }
}

export function normalizeAppOwnerId(value: unknown): string {
  const text = sanitizeText(value, 128);
  if (/^bili:\d{1,24}$/.test(text)) {
    return text;
  }
  return LOCAL_OWNER_ID;
}

export function setAppOwnerCookies(
  response: NextResponse,
  identity: { biliUid?: string | null; nickname?: string | null }
): void {
  const ownerId = appOwnerIdFromBiliUid(identity.biliUid);
  if (ownerId === LOCAL_OWNER_ID) {
    clearAppOwnerCookies(response);
    return;
  }
  response.cookies.set(APP_OWNER_COOKIE, ownerId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 180
  });
  const nickname = sanitizeText(identity.nickname, 120);
  if (nickname) {
    response.cookies.set(APP_OWNER_NAME_COOKIE, nickname, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 180
    });
  } else {
    expireCookie(response, APP_OWNER_NAME_COOKIE);
  }
}

export function clearAppOwnerCookies(response: NextResponse): void {
  expireCookie(response, APP_OWNER_COOKIE);
  expireCookie(response, APP_OWNER_NAME_COOKIE);
}

function expireCookie(response: NextResponse, name: string): void {
  response.cookies.set(name, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
}
