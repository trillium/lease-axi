import { encode } from "@toon-format/toon";
import type { MachinesResult } from "./machines.js";
import {
  type GrantDeferred,
  type GrantResult,
  type GrantSuccess,
  type PoolsResult,
  type QuotaResult,
  type ReleaseResult,
  type RenewResult,
  type StatusResult,
  formatDurationSeconds,
} from "./types.js";

export function renderGrant(result: GrantResult, json: boolean): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }
  if (result.granted) {
    const success = result as GrantSuccess;
    return encode({
      lease: {
        id: success.lease.id,
        pool: success.lease.pool,
        holder: success.lease.holder,
        cap: success.lease.cap,
        acquiredAt: success.lease.acquiredAt,
        expiresAt: success.lease.expiresAt,
        ttl: formatDurationSeconds(success.lease.ttlSeconds),
        ...(success.lease.expected?.task
          ? { task: success.lease.expected.task }
          : {}),
        ...(success.lease.expected?.durationSeconds
          ? {
              expectedDuration: formatDurationSeconds(
                success.lease.expected.durationSeconds,
              ),
            }
          : {}),
        ...(success.lease.expected?.size
          ? { expectedSize: success.lease.expected.size }
          : {}),
      },
    });
  }

  const deferred = result as GrantDeferred;
  const blocks: string[] = [
    encode({
      deferred: {
        pool: deferred.pool,
        cap: deferred.cap,
        active: deferred.active,
        reason: deferred.reason,
      },
    }),
  ];
  if (deferred.holders.length > 0) {
    blocks.push(encode({ holders: deferred.holders }));
  }
  return blocks.filter(Boolean).join("\n");
}

export function renderRenew(result: RenewResult, json: boolean): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }
  return encode({
    renewed: {
      id: result.lease.id,
      pool: result.lease.pool,
      holder: result.lease.holder,
      expiresAt: result.lease.expiresAt,
      ttl: formatDurationSeconds(result.lease.ttlSeconds),
    },
  });
}

export function renderRelease(result: ReleaseResult, json: boolean): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }
  return encode({
    released: {
      id: result.id,
      pool: result.pool ?? "unknown",
      holder: result.holder ?? "unknown",
    },
  });
}

export function renderStatus(result: StatusResult, json: boolean): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }
  const blocks = [
    encode({ pools: result.pools }),
    encode({ leases: result.leases }),
  ];
  return blocks.filter(Boolean).join("\n");
}

export function renderPools(result: PoolsResult, json: boolean): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }
  const blocks: string[] = [
    encode({
      quota: {
        source: result.quota.source,
        available: result.quota.available,
        ...(result.quota.error ? { error: result.quota.error } : {}),
      },
    }),
    encode({
      pools: result.pools.map((p) => ({
        pool: p.pool,
        active: p.active,
        cap: p.cap ?? "-",
        remainingPercent: p.quota?.percentRemaining ?? "-",
        windowStarted: p.quota ? p.quota.windowStarted : "-",
        resetsIn:
          p.quota?.resetsInSeconds !== undefined
            ? formatDurationSeconds(p.quota.resetsInSeconds)
            : "-",
        resetsAt: p.quota?.resetsAt ?? "-",
        idle: p.idle ?? "no",
      })),
    }),
  ];
  const held = result.pools.flatMap((p) =>
    p.holders.map((h) => ({
      pool: p.pool,
      id: h.id,
      holder: h.holder,
      task: h.task ?? "-",
      expected:
        h.expectedSeconds !== undefined
          ? formatDurationSeconds(h.expectedSeconds)
          : "-",
      size: h.size ?? "-",
      remainingSeconds: h.remainingSeconds,
    })),
  );
  if (held.length > 0) blocks.push(encode({ leases: held }));
  if (result.idle.length > 0) {
    blocks.push(
      encode({
        warning: `idle pools with no lease: ${result.idle.join(", ")}`,
      }),
    );
  }
  return blocks.filter(Boolean).join("\n");
}

export function renderQuota(result: QuotaResult, json: boolean): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }
  const nowMs = Date.now();
  const blocks: string[] = [
    encode({
      snapshot: {
        source: result.source,
        available: result.available,
        fetchedAt: result.fetchedAt ?? "-",
        age:
          result.ageSeconds !== null
            ? formatDurationSeconds(result.ageSeconds)
            : "-",
        stale: result.stale,
        refreshEvery: formatDurationSeconds(result.intervalSeconds),
        staleAfter: formatDurationSeconds(result.staleAfterSeconds),
        ...(result.error ? { error: result.error } : {}),
      },
    }),
    encode({
      pools: result.pools.map((p) => {
        const remaining = p.windows
          .map((w) => w.percentRemaining)
          .filter((v): v is number => v !== undefined);
        const resets = p.windows
          .map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN))
          .filter((v) => Number.isFinite(v));
        return {
          pool: p.pool,
          remainingPercent: remaining.length > 0 ? Math.min(...remaining) : "-",
          resetsIn:
            resets.length > 0
              ? formatDurationSeconds(
                  Math.max(0, Math.round((Math.min(...resets) - nowMs) / 1000)),
                )
              : "-",
        };
      }),
    }),
  ];
  if (result.stale) {
    blocks.push(
      encode({
        warning:
          result.ageSeconds === null
            ? "no quota snapshot yet; the server has not read quota-axi successfully"
            : `quota snapshot is stale (${formatDurationSeconds(result.ageSeconds)} old, limit ${formatDurationSeconds(result.staleAfterSeconds)}); treat remaining percentages as unreliable`,
      }),
    );
  }
  return blocks.filter(Boolean).join("\n");
}

export function renderMachines(result: MachinesResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);
  const limitText = (m: MachinesResult["eligible"][number]) =>
    [
      m.limit.maxLoad !== undefined ? `load<=${m.limit.maxLoad}` : "",
      m.limit.maxLoadPerCore !== undefined
        ? `perCore<=${m.limit.maxLoadPerCore}`
        : "",
    ]
      .filter(Boolean)
      .join(" ") || "-";
  const row = (m: MachinesResult["eligible"][number]) => ({
    machine: m.machine,
    load1: m.load1 ?? "-",
    cores: m.cores ?? "-",
    loadPerCore: m.loadPerCore ?? "-",
    limit: limitText(m),
  });
  const blocks = [
    encode({
      machines: {
        source: result.source,
        policy: result.policy,
        best: result.eligible[0]?.machine ?? "none",
      },
    }),
    encode({ eligible: result.eligible.map(row) }),
  ];
  if (result.refused.length > 0) {
    blocks.push(
      encode({
        refused: result.refused.map((m) => ({ ...row(m), reason: m.reason })),
      }),
    );
  }
  if (result.eligible.length === 0) {
    blocks.push(encode({ warning: "no machine is under its load limit" }));
  }
  return blocks.join("\n");
}
