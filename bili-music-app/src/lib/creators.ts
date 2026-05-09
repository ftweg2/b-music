import {
  createPreferredCreator,
  deletePreferredCreator,
  listPreferredCreators,
  updatePreferredCreator
} from "./db";
import type { CreatePreferredCreatorInput, PreferredCreator } from "./models";
import { clampNumber, sanitizeMid, sanitizeNullableText, sanitizeText, sanitizeUrl } from "./sanitize";

type CreatorProfile = {
  name: string;
  homepageUrl: string;
};

export async function listCreators(ownerId = "local"): Promise<PreferredCreator[]> {
  const creators = listPreferredCreators(ownerId);
  const resolved: PreferredCreator[] = [];
  for (const creator of creators) {
    if (!usesPlaceholderName(creator)) {
      resolved.push(creator);
      continue;
    }
    const profile = await resolveBilibiliCreatorProfile(creator.biliMid);
    if (!profile) {
      resolved.push(creator);
      continue;
    }
    resolved.push(
      updatePreferredCreator(
        creator.id,
        {
          name: profile.name,
          homepageUrl: profile.homepageUrl
        },
        ownerId
      ) ?? creator
    );
  }
  return resolved;
}

export async function addCreator(input: CreatePreferredCreatorInput, ownerId = "local"): Promise<PreferredCreator> {
  const biliMid = sanitizeMid(input.biliMid) ?? extractMidFromText(input.homepageUrl) ?? extractMidFromText(input.name);
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
    homepageUrl: input.homepageUrl ? sanitizeUrl(input.homepageUrl) : profile?.homepageUrl ?? `https://space.bilibili.com/${biliMid}`,
    priorityWeight: clampNumber(input.priorityWeight, 0, 100, 50),
    notes: sanitizeNullableText(input.notes, 500)
  });
}

export function editCreator(id: number, input: Partial<CreatePreferredCreatorInput>, ownerId = "local"): PreferredCreator | null {
  return updatePreferredCreator(
    id,
    {
      name: input.name ? sanitizeText(input.name, 200) : undefined,
      homepageUrl: input.homepageUrl ? sanitizeUrl(input.homepageUrl) : undefined,
      priorityWeight:
        input.priorityWeight === undefined ? undefined : clampNumber(input.priorityWeight, 0, 100, 50),
      notes: input.notes === undefined ? undefined : sanitizeNullableText(input.notes, 500)
    },
    ownerId
  );
}

export function removeCreator(id: number, ownerId = "local"): boolean {
  return deletePreferredCreator(id, ownerId);
}

function extractMidFromText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const match = text.match(/(?:space\.bilibili\.com\/)?(\d{1,24})/);
  return match ? sanitizeMid(match[1]) : null;
}

function usesPlaceholderName(creator: PreferredCreator): boolean {
  return creator.name === `UP ${creator.biliMid}` || creator.name === creator.biliMid;
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
