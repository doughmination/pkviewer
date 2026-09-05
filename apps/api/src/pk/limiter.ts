/**
 * Token-bucket rate limiter.
 *
 * Sized below PluralKit's documented limits (10/s reads, 3/s writes) to leave
 * headroom for burst and clock imprecision.
 *
 * IMPORTANT: PluralKit's limits are per-IP and this limiter is per-process.
 * That is correct while pkviewer runs as a single API process, which is the
 * deployment the SQLite design already implies. If a second instance is ever
 * placed behind the same egress IP, this must become a shared limiter or the
 * two processes will silently exceed the limit between them.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly queue: Array<() => void> = [];
  private draining = false;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number = Math.max(1, Math.ceil(ratePerSecond)),
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = this.burst;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.lastRefill);
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.ratePerSecond);
      this.lastRefill = t;
    }
  }

  /** Resolves once a token is available. FIFO, so callers cannot starve. */
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1 && this.queue.length === 0) {
      this.tokens -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          this.queue.shift()?.();
          continue;
        }
        const deficit = 1 - this.tokens;
        await this.sleep(Math.max(1, Math.ceil((deficit / this.ratePerSecond) * 1000)));
      }
    } finally {
      this.draining = false;
    }
  }

  /** Tokens currently available. Test/observability aid. */
  get available(): number {
    this.refill();
    return this.tokens;
  }
}
