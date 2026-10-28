/** Moving-average throughput meter over a short sliding window. */
export class SpeedMeter {
  private samples: Array<{ t: number; bytes: number }> = [];

  constructor(private readonly windowMs = 3000) {}

  record(totalBytes: number, now = Date.now()): number {
    this.samples.push({ t: now, bytes: totalBytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[1].t < cutoff) this.samples.shift();
    return this.speed();
  }

  speed(): number {
    if (this.samples.length < 2) return 0;
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt > 0 ? Math.max(0, (b.bytes - a.bytes) / dt) : 0;
  }
}

export function etaSeconds(total: number, done: number, speed: number): number | null {
  if (speed <= 1 || done >= total) return done >= total ? 0 : null;
  return (total - done) / speed;
}
