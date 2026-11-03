import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { withFileLock } from "./lock.js";
import {
  type GrantRequest,
  type GrantResult,
  type ILeaseStore,
  type Lease,
  type LeaseHolderInfo,
  type LeaseStoreState,
  type PoolStatus,
  type ReleaseRequest,
  type ReleaseResult,
  type RenewRequest,
  type RenewResult,
  type StatusResult,
  parseDurationMs,
  parseDurationSeconds,
} from "./types.js";

export function getDefaultStorePath(): string {
  if (process.env.LEASE_AXI_STORE) {
    return process.env.LEASE_AXI_STORE;
  }
  const base = process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, "lease-axi")
    : join(homedir(), ".local", "state", "lease-axi");
  return join(base, "leases.json");
}

function defaultHolderId(): string {
  const shortId = randomUUID().slice(0, 8);
  return `${hostname()}:${process.pid}:${shortId}`;
}

export function generateLeaseId(): string {
  return `lease_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export class FileLeaseStore implements ILeaseStore {
  readonly storePath: string;
  readonly lockPath: string;

  constructor(storePath?: string) {
    this.storePath = storePath ?? getDefaultStorePath();
    this.lockPath = `${this.storePath}.lock`;
  }

  private loadState(): LeaseStoreState {
    try {
      if (!existsSync(this.storePath)) {
        return {
          version: 1,
          updatedAt: new Date().toISOString(),
          leases: [],
        };
      }
      const raw = readFileSync(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LeaseStoreState>;
      if (Array.isArray(parsed.leases)) {
        return {
          version: 1,
          updatedAt: parsed.updatedAt ?? new Date().toISOString(),
          leases: parsed.leases,
        };
      }
    } catch {
      // Corrupt or empty file resets cleanly
    }
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      leases: [],
    };
  }

  private saveState(state: LeaseStoreState): void {
    const dir = dirname(this.storePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.storePath}.tmp.${randomUUID()}`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmpPath, this.storePath);
  }

  private reclaimExpired(state: LeaseStoreState, nowMs: number): boolean {
    const originalCount = state.leases.length;
    state.leases = state.leases.filter((lease) => {
      const expiresMs = Date.parse(lease.expiresAt);
      return Number.isFinite(expiresMs) && expiresMs > nowMs;
    });
    return state.leases.length !== originalCount;
  }

  async grant(req: GrantRequest, explicitNow?: number): Promise<GrantResult> {
    const cap = req.cap !== undefined && req.cap > 0 ? req.cap : 1;
    const ttlSeconds = req.ttl ? parseDurationSeconds(req.ttl) : 60;
    const holder =
      req.holder && req.holder.trim() ? req.holder.trim() : defaultHolderId();
    const waitMs = req.wait ? parseDurationMs(req.wait) : 0;
    const retryIntervalMs = req.retryInterval
      ? parseDurationMs(req.retryInterval)
      : 100;

    const startPerf = performance.now();
    const waitDeadline = startPerf + waitMs;

    for (;;) {
      const result = await withFileLock(this.lockPath, async () => {
        const nowMs = explicitNow ?? Date.now();
        const state = this.loadState();
        const pruned = this.reclaimExpired(state, nowMs);

        const poolLeases = state.leases.filter((l) => l.pool === req.pool);
        if (poolLeases.length < cap) {
          const lease: Lease = {
            id: generateLeaseId(),
            pool: req.pool,
            holder,
            cap,
            acquiredAt: new Date(nowMs).toISOString(),
            expiresAt: new Date(nowMs + ttlSeconds * 1000).toISOString(),
            ttlSeconds,
          };
          state.leases.push(lease);
          state.updatedAt = new Date(nowMs).toISOString();
          this.saveState(state);
          return {
            granted: true as const,
            deferred: false as const,
            lease,
          };
        }

        if (pruned) {
          state.updatedAt = new Date(nowMs).toISOString();
          this.saveState(state);
        }

        const holders: LeaseHolderInfo[] = poolLeases.map((l) => {
          const expMs = Date.parse(l.expiresAt);
          const remainingSeconds = Math.max(
            0,
            Math.round((expMs - nowMs) / 1000),
          );
          return {
            id: l.id,
            holder: l.holder,
            expiresAt: l.expiresAt,
            remainingSeconds,
          };
        });

        return {
          granted: false as const,
          deferred: true as const,
          pool: req.pool,
          cap,
          active: poolLeases.length,
          holders,
          reason: `pool capacity reached (${poolLeases.length}/${cap})`,
        };
      });

      if (result.granted) {
        return result;
      }

      // Check if we can wait further
      if (waitMs > 0 && performance.now() < waitDeadline) {
        const remainingWait = waitDeadline - performance.now();
        await sleep(Math.min(retryIntervalMs, remainingWait));
        continue;
      }

      return result;
    }
  }

  async renew(req: RenewRequest, explicitNow?: number): Promise<RenewResult> {
    return await withFileLock(this.lockPath, async () => {
      const nowMs = explicitNow ?? Date.now();
      const state = this.loadState();
      this.reclaimExpired(state, nowMs);

      const lease = state.leases.find((l) => l.id === req.id);
      if (!lease) {
        throw new Error(`Lease "${req.id}" not found or expired`);
      }

      const ttlSeconds = req.ttl
        ? parseDurationSeconds(req.ttl)
        : lease.ttlSeconds;
      lease.expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();
      lease.ttlSeconds = ttlSeconds;
      state.updatedAt = new Date(nowMs).toISOString();
      this.saveState(state);

      return {
        renewed: true as const,
        lease,
      };
    });
  }

  async release(
    req: ReleaseRequest,
    explicitNow?: number,
  ): Promise<ReleaseResult> {
    return await withFileLock(this.lockPath, async () => {
      const nowMs = explicitNow ?? Date.now();
      const state = this.loadState();
      this.reclaimExpired(state, nowMs);

      const index = state.leases.findIndex((l) => l.id === req.id);
      if (index >= 0) {
        const [removed] = state.leases.splice(index, 1);
        state.updatedAt = new Date(nowMs).toISOString();
        this.saveState(state);
        return {
          released: true as const,
          id: req.id,
          pool: removed.pool,
          holder: removed.holder,
        };
      }

      return {
        released: true as const,
        id: req.id,
        alreadyReleased: true,
      };
    });
  }

  async status(
    filterPool?: string,
    explicitNow?: number,
  ): Promise<StatusResult> {
    return await withFileLock(this.lockPath, async () => {
      const nowMs = explicitNow ?? Date.now();
      const state = this.loadState();
      const pruned = this.reclaimExpired(state, nowMs);
      if (pruned) {
        state.updatedAt = new Date(nowMs).toISOString();
        this.saveState(state);
      }

      const matchingLeases = filterPool
        ? state.leases.filter((l) => l.pool === filterPool)
        : state.leases;

      // Group by pool to compute active count and last recorded cap
      const poolMap = new Map<string, { active: number; cap: number }>();
      for (const lease of state.leases) {
        const existing = poolMap.get(lease.pool);
        if (existing) {
          existing.active += 1;
          existing.cap = Math.max(existing.cap, lease.cap);
        } else {
          poolMap.set(lease.pool, { active: 1, cap: lease.cap });
        }
      }

      const pools: PoolStatus[] = [];
      if (filterPool) {
        const found = poolMap.get(filterPool);
        pools.push({
          pool: filterPool,
          active: found ? found.active : 0,
          cap: found ? found.cap : 1,
        });
      } else {
        for (const [pool, info] of poolMap.entries()) {
          pools.push({
            pool,
            active: info.active,
            cap: info.cap,
          });
        }
      }

      const leasesWithRemaining = matchingLeases.map((l) => {
        const expMs = Date.parse(l.expiresAt);
        const remainingSeconds = Math.max(
          0,
          Math.round((expMs - nowMs) / 1000),
        );
        return {
          ...l,
          remainingSeconds,
        };
      });

      return {
        pools,
        leases: leasesWithRemaining,
      };
    });
  }
}
