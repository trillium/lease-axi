export const DEFERRAL_EXIT_CODE = 75;

export type Lease = {
  id: string;
  pool: string;
  holder: string;
  cap: number;
  acquiredAt: string;
  expiresAt: string;
  ttlSeconds: number;
};

export type LeaseStoreState = {
  version: 1;
  updatedAt: string;
  leases: Lease[];
};

export type LeaseHolderInfo = {
  id: string;
  holder: string;
  expiresAt: string;
  remainingSeconds: number;
};

export type GrantRequest = {
  pool: string;
  cap?: number;
  ttl?: string | number;
  holder?: string;
  wait?: string | number;
  retryInterval?: string | number;
};

export type GrantSuccess = {
  granted: true;
  deferred: false;
  lease: Lease;
};

export type GrantDeferred = {
  granted: false;
  deferred: true;
  pool: string;
  cap: number;
  active: number;
  holders: LeaseHolderInfo[];
  reason: string;
};

export type GrantResult = GrantSuccess | GrantDeferred;

export type RenewRequest = {
  id: string;
  ttl?: string | number;
};

export type RenewResult = {
  renewed: true;
  lease: Lease;
};

export type ReleaseRequest = {
  id: string;
};

export type ReleaseResult = {
  released: true;
  id: string;
  pool?: string;
  holder?: string;
  alreadyReleased?: boolean;
};

export type PoolStatus = {
  pool: string;
  active: number;
  cap: number;
};

export type StatusResult = {
  pools: PoolStatus[];
  leases: Array<Lease & { remainingSeconds: number }>;
};

export interface ILeaseStore {
  grant(req: GrantRequest, now?: number): Promise<GrantResult>;
  renew(req: RenewRequest, now?: number): Promise<RenewResult>;
  release(req: ReleaseRequest, now?: number): Promise<ReleaseResult>;
  status(pool?: string, now?: number): Promise<StatusResult>;
}

const DURATION_REGEX = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i;

export function parseDurationMs(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid duration: ${value}`);
    }
    return Math.round(value * 1000);
  }
  const match = value.trim().match(DURATION_REGEX);
  if (!match) {
    throw new Error(`Invalid duration format: "${value}"`);
  }
  const num = Number.parseFloat(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  switch (unit) {
    case "ms":
      return Math.round(num);
    case "s":
      return Math.round(num * 1000);
    case "m":
      return Math.round(num * 60 * 1000);
    case "h":
      return Math.round(num * 3600 * 1000);
    case "d":
      return Math.round(num * 86400 * 1000);
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

export function parseDurationSeconds(value: string | number): number {
  return Math.max(1, Math.round(parseDurationMs(value) / 1000));
}

export function formatDurationSeconds(seconds: number): string {
  if (seconds <= 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const rem = Math.round(seconds % 60);
    return rem > 0 ? `${mins}m${rem}s` : `${mins}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const remMins = Math.round((seconds % 3600) / 60);
  return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
}
