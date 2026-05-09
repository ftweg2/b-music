import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

import { sanitizeText } from "./sanitize";

export const APP_OWNER_COOKIE = "bili_music_owner_id";
export const APP_OWNER_NAME_COOKIE = "bili_music_owner_name";

const LOCAL_OWNER_ID = "local";

export async function currentAppOwnerId(): Promise<string> {
  try {
    const store = await cookies();
    return normalizeAppOwnerId(store.get(APP_OWNER_COOKIE)?.value);
  } catch {
    return LOCAL_OWNER_ID;
  }
}

export function appOwnerIdFromBiliUid(biliUid: unknown): string {
  const uid = sanitizeText(biliUid, 64).replace(/[^\d]/g, "");
  return uid ? `bili:${uid}` : LOCAL_OWNER_ID;
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
  }
}
