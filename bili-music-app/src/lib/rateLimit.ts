const buckets = new Map<string, number[]>();

export function assertRateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const timestamps = (buckets.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
  if (timestamps.length >= limit) {
    throw new Error("搜索太频繁了，稍等一下再试");
  }
  timestamps.push(now);
  buckets.set(key, timestamps);
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}
