// Pure helpers for Douyin links pasted by the user. The App never contacts Douyin:
// it only recognises the link and hands it to the kernel.

const DOUYIN_HOSTS = new Set([
  "douyin.com",
  "www.douyin.com",
  "m.douyin.com",
  "v.douyin.com",
  "iesdouyin.com",
  "www.iesdouyin.com",
]);
const URL_IN_TEXT = /https?:\/\/[^\s<>"'，。！？、；：（）【】「」]+/gi;
const PATH_ID = /^\/(?:share\/)?(?:video|note|slides)\/(\d{15,20})\/?$/;
const AWEME_ID = /^\d{15,20}$/;

/**
 * The first Douyin link in a pasted share text such as
 * "7.94 复制打开抖音，看看【…的作品】… https://v.douyin.com/abc123/ abc:/ …".
 */
export function findDouyinLink(text: string): string | null {
  for (const match of String(text ?? "").matchAll(URL_IN_TEXT)) {
    const candidate = match[0].replace(/[.,;:!?)\]}]+$/, "");
    try {
      const url = new URL(candidate);
      if (DOUYIN_HOSTS.has(url.hostname.toLowerCase())) return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

/** The item id when the link carries one; share links (v.douyin.com) do not. */
export function douyinIdFromLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (!DOUYIN_HOSTS.has(url.hostname.toLowerCase()) || url.hostname.toLowerCase() === "v.douyin.com") return null;
  const fromPath = PATH_ID.exec(url.pathname)?.[1];
  if (fromPath) return fromPath;
  for (const key of ["modal_id", "aweme_id"]) {
    const value = url.searchParams.get(key);
    if (value && AWEME_ID.test(value)) return value;
  }
  return null;
}
