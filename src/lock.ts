import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type LockHolder = {
  pid: number;
  host: string;
  token: string;
  acquiredAt: number;
};

export type LockOptions = {
  timeoutMs?: number;
  pollMs?: number;
  staleMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 25;
const DEFAULT_STALE_MS = 30_000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    return code === "EPERM";
  }
}

function readLockHolder(path: string): LockHolder | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as Partial<LockHolder>;
    if (
      typeof data.pid === "number" &&
      typeof data.host === "string" &&
      typeof data.token === "string"
    ) {
      return {
        pid: data.pid,
        host: data.host,
        token: data.token,
        acquiredAt: typeof data.acquiredAt === "number" ? data.acquiredAt : 0,
      };
    }
  } catch {
    // If unreadable or corrupted, stat may still be checked
  }
  return undefined;
}

function settleAbandonedLock(path: string, staleMs: number): boolean {
  try {
    const holder = readLockHolder(path);
    const now = Date.now();
    if (holder) {
      if (holder.host === hostname() && !isPidAlive(holder.pid)) {
        unlinkSync(path);
        return true;
      }
      if (holder.acquiredAt > 0 && now - holder.acquiredAt > staleMs) {
        unlinkSync(path);
        return true;
      }
    }
    const stat = statSync(path);
    if (now - stat.mtimeMs > staleMs) {
      unlinkSync(path);
      return true;
    }
  } catch {
    // File may have been removed concurrently
  }
  return false;
}

function tryAcquire(path: string, token: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, "wx", 0o600);
    try {
      const holder: LockHolder = {
        pid: process.pid,
        host: hostname(),
        token,
        acquiredAt: Date.now(),
      };
      writeSync(fd, JSON.stringify(holder));
      return true;
    } finally {
      closeSync(fd);
    }
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

function release(path: string, token: string): void {
  try {
    const holder = readLockHolder(path);
    if (holder && holder.token === token) {
      unlinkSync(path);
    }
  } catch {
    // Already released or removed
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = performance.now() + timeoutMs;
  const token = randomUUID();

  while (performance.now() < deadline) {
    if (tryAcquire(lockPath, token)) {
      try {
        return await fn();
      } finally {
        release(lockPath, token);
      }
    }

    settleAbandonedLock(lockPath, staleMs);
    await sleep(pollMs);
  }

  // Final try
  if (tryAcquire(lockPath, token)) {
    try {
      return await fn();
    } finally {
      release(lockPath, token);
    }
  }

  throw new Error(`Failed to acquire lock at ${lockPath} after ${timeoutMs}ms`);
}
