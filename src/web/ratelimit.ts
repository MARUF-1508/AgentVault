/**
 * Sliding-window rate limiter for the web API. Keys are `<user>:<bucket>`, so
 * one account flooding the chat (each message costs an LLM call and may move
 * money) cannot starve another. In-memory: the server is a single local process.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limits: Record<string, { max: number; windowMs: number }>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns the seconds to wait, or 0 when allowed. */
  take(user: string, bucket: string): number {
    const limit = this.limits[bucket];
    if (!limit) return 0;
    const key = `${user}:${bucket}`;
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - limit.windowMs);
    if (recent.length >= limit.max) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0]! + limit.windowMs - t) / 1000));
    }
    recent.push(t);
    this.hits.set(key, recent);
    return 0;
  }
}
