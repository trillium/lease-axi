import { encode } from "@toon-format/toon";
import {
  type GrantDeferred,
  type GrantResult,
  type GrantSuccess,
  type PoolsResult,
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
