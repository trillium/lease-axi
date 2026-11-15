import { type PoolConfig, resolvePoolRule } from "./config.js";
import { type QuotaPool, type QuotaSource } from "./quota.js";
import {
  type PoolIdleReason,
  type PoolQuota,
  type PoolView,
  type PoolsResult,
  type StatusResult,
} from "./types.js";

function summarizeQuota(pool: QuotaPool, nowMs: number): PoolQuota {
  const windows = pool.windows;
  const sessions = windows.filter((w) => w.kind === "session");
  // The window that burns clock is the session window when there is one.
  const focus = sessions.length > 0 ? sessions : windows;

  const remaining = windows
    .map((w) => w.percentRemaining)
    .filter((v): v is number => v !== undefined);
  // Next reset among windows that still hold unused quota: that is the
  // quota about to be lost.
  const live = windows.filter(
    (w) => w.percentRemaining === undefined || w.percentRemaining > 0,
  );
  const resets = (live.length > 0 ? live : windows)
    .map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN))
    .filter((v) => Number.isFinite(v));
  const earliest = resets.length > 0 ? Math.min(...resets) : undefined;

  return {
    percentRemaining: remaining.length > 0 ? Math.min(...remaining) : undefined,
    windowStarted: focus.some((w) => w.started),
    resetsAt:
      earliest !== undefined ? new Date(earliest).toISOString() : undefined,
    resetsInSeconds:
      earliest !== undefined
        ? Math.max(0, Math.round((earliest - nowMs) / 1000))
        : undefined,
    windows,
  };
}

export function idleReason(
  quota: PoolQuota,
  nearExpiryMinutes: number,
): PoolIdleReason | null {
  if (quota.percentRemaining !== undefined && quota.percentRemaining <= 0) {
    return null; // exhausted: nothing left to waste
  }
  if (!quota.windowStarted) return "unstarted";
  if (
    quota.resetsInSeconds !== undefined &&
    quota.resetsInSeconds <= nearExpiryMinutes * 60
  ) {
    return "near-expiry";
  }
  return null;
}

/**
 * Join quota state, pool config and live leases. Pools appear when quota-axi
 * reports them, when config names them, or when a lease holds them.
 */
export function joinPools(
  quotaPools: QuotaPool[] | null,
  status: StatusResult,
  config: PoolConfig,
  nowMs: number,
): PoolView[] {
  const names = new Set<string>();
  const quotaByName = new Map<string, QuotaPool>();
  for (const q of quotaPools ?? []) {
    quotaByName.set(q.pool, q);
    names.add(q.pool);
  }
  for (const name of Object.keys(config.pools)) names.add(name);
  for (const l of status.leases) names.add(l.pool);

  const views: PoolView[] = [];
  for (const name of [...names].sort()) {
    const leases = status.leases.filter((l) => l.pool === name);
    const rule = resolvePoolRule(config, name);
    const q = quotaByName.get(name);
    const [provider, account, ...rest] = name.split("/");
    const quota = q ? summarizeQuota(q, nowMs) : null;

    const leaseCap = leases.reduce((m, l) => Math.max(m, l.cap), 0);
    const cap = rule.cap ?? (leaseCap > 0 ? leaseCap : null);
    const managed = rule.cap !== undefined;

    views.push({
      pool: name,
      provider: q?.provider ?? provider,
      account: q?.account ?? account,
      scope: q?.scope ?? (rest.length > 0 ? rest.join("/") : undefined),
      cap,
      capSource: managed ? "config" : leaseCap > 0 ? "lease" : "none",
      active: leases.length,
      quota,
      idle:
        managed && leases.length === 0 && quota
          ? idleReason(quota, config.idle.nearExpiryMinutes)
          : null,
      holders: leases.map((l) => ({
        id: l.id,
        holder: l.holder,
        task: l.expected?.task,
        expectedSeconds: l.expected?.durationSeconds,
        size: l.expected?.size,
        remainingSeconds: l.remainingSeconds,
      })),
    });
  }
  return views;
}

export async function buildPoolsView(
  status: StatusResult,
  source: QuotaSource,
  config: PoolConfig,
  nowMs: number = Date.now(),
): Promise<PoolsResult> {
  let quotaPools: QuotaPool[] | null = null;
  let error: string | undefined;
  try {
    quotaPools = (await source.read()).pools;
  } catch (err) {
    error = (err as Error).message;
  }
  const pools = joinPools(quotaPools, status, config, nowMs);
  return {
    quota: {
      source: source.describe,
      available: quotaPools !== null,
      ...(error ? { error } : {}),
    },
    pools,
    idle: pools.filter((p) => p.idle).map((p) => p.pool),
  };
}
