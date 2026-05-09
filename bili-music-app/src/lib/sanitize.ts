const SENSITIVE_QUERY_KEYS = ["token", "sign", "w_rid", "csrf", "sessdata", "cookie", "access_key"];

export function sanitizeText(value: unknown, maxLength = 2000): string {
  return String(value ?? "")
    .replace(/(cookie|authorization|sessdata|bili_jct|csrf|token)\s*[:=]\s*[^,\s;]+/gi, "$1=<redacted>")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrl(url))
    .slice(0, maxLength)
    .trim();
}

export function sanitizeUrl(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.some((sensitive) => key.toLowerCase().includes(sensitive))) {
        url.searchParams.set(key, "<redacted>");
      }
    }
    if (url.searchParams.toString()) {
      return `${url.origin}${url.pathname}?<redacted>`;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value).slice(0, 1000);
  }
}

export function sanitizeNullableText(value: unknown, maxLength = 2000): string | null {
  const text = sanitizeText(value, maxLength);
  return text ? text : null;
}

export function sanitizeBvid(value: unknown): string {
  const text = String(value ?? "").trim();
  const match = text.match(/BV[0-9A-Za-z]{10}/);
  return match ? match[0] : "";
}

export function sanitizeMid(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return /^\d{1,24}$/.test(text) ? text : null;
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, num));
}
