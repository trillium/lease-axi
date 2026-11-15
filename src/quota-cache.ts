import type { QuotaPool, QuotaSnapshot, QuotaSource } from "./quota.js";
import type { QuotaResult } from "./types.js";

export const DEFAULT_QUOTA_INTERVAL_SECONDS = 300;
export const STALE_INTERVALS = 3;

export type QuotaCacheOptions = {
  intervalSeconds?: number;
  /** Snapshot older than this is reported stale. Defaults to 3 intervals. */
  staleAfterSeconds?: number;
  now?: () => number;
};

/**
 * Holds the latest quota snapshot read from one QuotaSource. The server is the
 * only place that probes; every reader gets this cached copy plus its age.
 * A failed refresh keeps the last good snapshot and records the error.
 */
export class QuotaCache {
  readonly intervalSeconds: number;
  readonly staleAfterSeconds: number;
  private readonly source: QuotaSource;
  private readonly now: () => number;
  private snapshot: QuotaSnapshot | null = null;
  private fetchedAtMs: number | null = null;
  private error: string | undefined;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempted = false;

  constructor(source: QuotaSource, options: QuotaCacheOptions = {}) {
    this.source = source;
    this.intervalSeconds =
      options.intervalSeconds ?? DEFAULT_QUOTA_INTERVAL_SECONDS;
    this.staleAfterSeconds =
      options.staleAfterSeconds ?? this.intervalSeconds * STALE_INTERVALS;
    this.now = options.now ?? Date.now;
  }

  /** Probe the source now. Concurrent callers share one probe. Never rejects. */
  refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          this.snapshot = await this.source.read();
          this.fetchedAtMs = this.now();
          this.error = undefined;
        } catch (err) {
          this.error = (err as Error).message;
        } finally {
          this.attempted = true;
          this.inflight = null;
        }
      })();
    }
    return this.inflight;
  }

  /** Begin the interval refresh loop and kick off the first probe. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.intervalSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Cached snapshot with age. Waits for the first probe only if none has finished. */
  async get(pool?: string): Promise<QuotaResult> {
    if (!this.attempted) await this.refresh();
    const nowMs = this.now();
    const ageSeconds =
      this.fetchedAtMs === null
        ? null
        : Math.max(0, Math.round((nowMs - this.fetchedAtMs) / 1000));
    const pools: QuotaPool[] = (this.snapshot?.pools ?? []).filter(
      (p) => !pool || p.pool === pool,
    );
    return {
      source: this.source.describe,
      available: this.snapshot !== null,
      fetchedAt:
        this.fetchedAtMs === null
          ? null
          : new Date(this.fetchedAtMs).toISOString(),
      ageSeconds,
      stale: ageSeconds === null || ageSeconds > this.staleAfterSeconds,
      intervalSeconds: this.intervalSeconds,
      staleAfterSeconds: this.staleAfterSeconds,
      ...(this.error ? { error: this.error } : {}),
      pools,
    };
  }

  /** Adapter so the pools view reads the cache instead of probing. */
  asSource(): QuotaSource {
    return {
      describe: `cache:${this.source.describe}`,
      read: async () => {
        const r = await this.get();
        if (!r.available) {
          throw new Error(r.error ?? "no quota snapshot yet");
        }
        return { pools: r.pools };
      },
    };
  }
}
