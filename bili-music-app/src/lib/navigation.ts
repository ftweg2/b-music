const INTERNAL_FALLBACK = "/search";

export function safeInternalReturnTo(value: unknown, fallback = INTERNAL_FALLBACK): string {
  const text = String(value ?? "").trim();
  if (!text || !text.startsWith("/") || text.startsWith("//") || /[\r\n]/.test(text)) {
    return fallback;
  }

  try {
    const url = new URL(text, "https://bili-music.local");
    if (url.origin !== "https://bili-music.local") {
      return fallback;
    }
    if (url.pathname.startsWith("/api") || url.pathname.startsWith("/_next")) {
      return fallback;
    }
    return `${url.pathname}${url.search}${url.hash}` || fallback;
  } catch {
    return fallback;
  }
}

export function makeReturnTo(pathname: string | null, search: string | null): string {
  const path = pathname || "/";
  const query = search ? (search.startsWith("?") ? search : `?${search}`) : "";
  return safeInternalReturnTo(`${path}${query}`, "/");
}
