import { encode } from "@toon-format/toon";
import {
  type GrantDeferred,
  type GrantResult,
  type GrantSuccess,
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
