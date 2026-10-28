/** Fixed-window counter keyed by string. Cheap and good enough for LAN-scale abuse limiting. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private timer: NodeJS.Timeout;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    this.timer = setInterval(() => this.sweep(), Math.max(windowMs, 10_000));
    this.timer.unref();
  }

  /** Returns true if the action is allowed. */
  take(key: string, now = Date.now()): boolean {
    const e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    e.count++;
    return e.count <= this.limit;
  }

  private sweep(now = Date.now()) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }

  dispose() {
    clearInterval(this.timer);
  }
}
