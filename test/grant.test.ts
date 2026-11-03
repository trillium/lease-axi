import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLeaseStore } from "../src/store.js";
import type { GrantResult } from "../src/types.js";

describe("Pool grant and capacity enforcement", () => {
  let tempDir: string;
  let storePath: string;
  let store: FileLeaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lease-axi-test-grant-"));
    storePath = join(tempDir, "leases.json");
    store = new FileLeaseStore(storePath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("grants a lease slot when pool is empty", async () => {
    const result = await store.grant({
      pool: "agy/default/gemini",
      cap: 1,
      ttl: "30s",
      holder: "agent-1",
    });

    expect(result.granted).toBe(true);
    if (result.granted) {
      expect(result.lease.pool).toBe("agy/default/gemini");
      expect(result.lease.holder).toBe("agent-1");
      expect(result.lease.cap).toBe(1);
      expect(result.lease.ttlSeconds).toBe(30);
      expect(result.lease.id).toMatch(/^lease_/);
      expect(Date.parse(result.lease.expiresAt)).toBeGreaterThan(
        Date.parse(result.lease.acquiredAt),
      );
    }
  });

  it("defers a second grant when pool cap is 1", async () => {
    const first = await store.grant({
      pool: "agy/default/gemini",
      cap: 1,
      ttl: "60s",
      holder: "agent-1",
    });
    expect(first.granted).toBe(true);

    const second = await store.grant({
      pool: "agy/default/gemini",
      cap: 1,
      ttl: "60s",
      holder: "agent-2",
    });

    expect(second.granted).toBe(false);
    if (!second.granted) {
      expect(second.deferred).toBe(true);
      expect(second.pool).toBe("agy/default/gemini");
      expect(second.cap).toBe(1);
      expect(second.active).toBe(1);
      expect(second.holders).toHaveLength(1);
      expect(second.holders[0].holder).toBe("agent-1");
      expect(second.reason).toContain("pool capacity reached");
    }
  });

  it("admits up to cap N and defers at N+1", async () => {
    const pool = "shared-pool";
    const cap = 3;

    const r1 = await store.grant({ pool, cap, ttl: 60, holder: "h1" });
    const r2 = await store.grant({ pool, cap, ttl: 60, holder: "h2" });
    const r3 = await store.grant({ pool, cap, ttl: 60, holder: "h3" });
    const r4 = await store.grant({ pool, cap, ttl: 60, holder: "h4" });

    expect(r1.granted).toBe(true);
    expect(r2.granted).toBe(true);
    expect(r3.granted).toBe(true);
    expect(r4.granted).toBe(false);
    if (!r4.granted) {
      expect(r4.deferred).toBe(true);
      expect(r4.active).toBe(3);
    }
  });

  it("different pools have independent capacities", async () => {
    const r1 = await store.grant({
      pool: "pool-a",
      cap: 1,
      ttl: 60,
      holder: "h1",
    });
    const r2 = await store.grant({
      pool: "pool-b",
      cap: 1,
      ttl: 60,
      holder: "h2",
    });

    expect(r1.granted).toBe(true);
    expect(r2.granted).toBe(true);
  });

  it("enforces cap under concurrent grant requests (race safety)", async () => {
    const pool = "race-pool";
    const cap = 1;
    const concurrent = 10;

    const promises: Promise<GrantResult>[] = [];
    for (let i = 0; i < concurrent; i++) {
      promises.push(
        store.grant({
          pool,
          cap,
          ttl: 60,
          holder: `worker-${i}`,
        }),
      );
    }

    const results = await Promise.all(promises);
    const granted = results.filter((r) => r.granted);
    const deferred = results.filter((r) => !r.granted);

    expect(granted).toHaveLength(1);
    expect(deferred).toHaveLength(concurrent - 1);
  });

  it("enforces cap under concurrent grants for cap 4", async () => {
    const pool = "race-pool-4";
    const cap = 4;
    const concurrent = 12;

    const promises: Promise<GrantResult>[] = [];
    for (let i = 0; i < concurrent; i++) {
      promises.push(
        store.grant({
          pool,
          cap,
          ttl: 60,
          holder: `worker-${i}`,
        }),
      );
    }

    const results = await Promise.all(promises);
    const granted = results.filter((r) => r.granted);
    const deferred = results.filter((r) => !r.granted);

    expect(granted).toHaveLength(4);
    expect(deferred).toHaveLength(8);
  });

  it("waits with --wait until the holder releases", async () => {
    const pool = "wait-pool";
    const cap = 1;

    const first = await store.grant({ pool, cap, ttl: 60, holder: "h1" });
    expect(first.granted).toBe(true);

    // Launch a background release after 150ms
    setTimeout(async () => {
      if (first.granted) {
        await store.release({ id: first.lease.id });
      }
    }, 150);

    // Second caller waits up to 2 seconds
    const start = Date.now();
    const second = await store.grant({
      pool,
      cap,
      ttl: 60,
      holder: "h2",
      wait: "2s",
      retryInterval: "50ms",
    });

    const elapsed = Date.now() - start;
    expect(second.granted).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(100);
    if (second.granted) {
      expect(second.lease.holder).toBe("h2");
    }
  });

  it("defers with --wait if wait timeout expires before slot is freed", async () => {
    const pool = "timeout-pool";
    const cap = 1;

    const first = await store.grant({ pool, cap, ttl: 60, holder: "h1" });
    expect(first.granted).toBe(true);

    const start = Date.now();
    const second = await store.grant({
      pool,
      cap,
      ttl: 60,
      holder: "h2",
      wait: "150ms",
      retryInterval: "30ms",
    });

    const elapsed = Date.now() - start;
    expect(second.granted).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(120);
    if (!second.granted) {
      expect(second.deferred).toBe(true);
    }
  });
});
