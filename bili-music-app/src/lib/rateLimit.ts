const buckets = new Map<string, number[]>();

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("搜索太频繁了，稍等一下再试");
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function assertRateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const timestamps = (buckets.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
  if (timestamps.length >= limit) {
    const retryAfterMs = Math.max(1_000, windowMs - (now - timestamps[0]));
    throw new RateLimitError(Math.ceil(retryAfterMs / 1_000));
  }
  timestamps.push(now);
  buckets.set(key, timestamps);
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}
