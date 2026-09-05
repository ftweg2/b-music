import {
  createPreferredCreator,
  deletePreferredCreator,
  listPreferredCreators,
  updatePreferredCreator
} from "./db";
import type { CreatePreferredCreatorInput, PreferredCreator } from "./models";
import { sanitizeMid, sanitizeNullableText, sanitizeText } from "./sanitize";

type CreatorProfile = {
  name: string;
  homepageUrl: string;
};

export async function listCreators(ownerId = "local"): Promise<PreferredCreator[]> {
  return listPreferredCreators(ownerId);
}

export async function addCreator(input: CreatePreferredCreatorInput, ownerId = "local"): Promise<PreferredCreator> {
  const biliMid = sanitizeMid(input.biliMid) ?? extractMidFromText(input.homepageUrl);
  if (!biliMid) {
    throw new Error("请粘贴 UP 主页链接，或输入 UP 主 mid");
  }
  const explicitName = sanitizeText(input.name, 200);
  const profile = explicitName ? null : await resolveBilibiliCreatorProfile(biliMid);
  const name = explicitName || profile?.name || `UP ${biliMid}`;
  return createPreferredCreator({
    externalOwnerId: ownerId,
    biliMid,
    name,
    homepageUrl: `https://space.bilibili.com/${biliMid}`,
    notes: sanitizeNullableText(input.notes, 500)
  });
}

export function editCreator(id: number, input: Partial<CreatePreferredCreatorInput>, ownerId = "local"): PreferredCreator | null {
  const current = listPreferredCreators(ownerId).find((creator) => creator.id === id);
  if (!current) return null;
  if (input.homepageUrl !== undefined && extractMidFromText(input.homepageUrl) !== current.biliMid) {
    throw new Error("主页必须属于当前 UP；关注其他 UP 请新增关注");
  }
  return updatePreferredCreator(
    id,
    {
      name: input.name ? sanitizeText(input.name, 200) : undefined,
      homepageUrl: input.homepageUrl === undefined ? undefined : `https://space.bilibili.com/${current.biliMid}`,
      notes: input.notes === undefined ? undefined : sanitizeNullableText(input.notes, 500)
    },
    ownerId
  );
}

export function removeCreator(id: number, ownerId = "local"): boolean {
  return deletePreferredCreator(id, ownerId);
}

function extractMidFromText(value: unknown): string | null {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.hostname !== "space.bilibili.com" || url.username || url.password || url.port) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length === 1 ? sanitizeMid(segments[0]) : null;
  } catch { return null; }
}

async function resolveBilibiliCreatorProfile(biliMid: string): Promise<CreatorProfile | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = new URL("https://api.bilibili.com/x/web-interface/card");
    url.searchParams.set("mid", biliMid);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "bili-music-app public profile lookup",
        "accept": "application/json"
      },
      cache: "no-store"
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { data?: { card?: { name?: unknown } } };
    const name = sanitizeText(payload.data?.card?.name, 200);
    return name ? { name, homepageUrl: `https://space.bilibili.com/${biliMid}` } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
