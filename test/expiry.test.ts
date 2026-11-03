import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLeaseStore } from "../src/store.js";

describe("Lease expiry and admission-time reclaim", () => {
  let tempDir: string;
  let storePath: string;
  let store: FileLeaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lease-axi-test-expiry-"));
    storePath = join(tempDir, "leases.json");
    store = new FileLeaseStore(storePath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reclaims expired lease at admission time", async () => {
    const pool = "expiry-pool";
    const baseTime = Date.now();

    // First grant with 1s TTL at baseTime
    const first = await store.grant(
      { pool, cap: 1, ttl: "1s", holder: "first-agent" },
      baseTime,
    );
    expect(first.granted).toBe(true);

    // Immediate second grant at baseTime (still active) should defer
    const secondImmediate = await store.grant(
      { pool, cap: 1, ttl: "1s", holder: "second-agent" },
      baseTime + 500, // +0.5s
    );
    expect(secondImmediate.granted).toBe(false);

    // Third grant after TTL (+1.5s): expired lease is reclaimed, second agent admitted!
    const thirdAfterExpiry = await store.grant(
      { pool, cap: 1, ttl: "5s", holder: "second-agent" },
      baseTime + 1500, // +1.5s
    );
    expect(thirdAfterExpiry.granted).toBe(true);
    if (thirdAfterExpiry.granted) {
      expect(thirdAfterExpiry.lease.holder).toBe("second-agent");
    }

    // Status now only lists the active lease
    const status = await store.status(pool, baseTime + 1500);
    expect(status.leases).toHaveLength(1);
    expect(status.leases[0].holder).toBe("second-agent");
    expect(status.pools[0].active).toBe(1);
  });

  it("status reclaims expired leases automatically", async () => {
    const pool = "status-reclaim-pool";
    const baseTime = Date.now();

    await store.grant({ pool, cap: 1, ttl: "2s", holder: "agent-a" }, baseTime);

    const activeStatus = await store.status(pool, baseTime + 1000);
    expect(activeStatus.leases).toHaveLength(1);
    expect(activeStatus.pools[0].active).toBe(1);

    const expiredStatus = await store.status(pool, baseTime + 2500);
    expect(expiredStatus.leases).toHaveLength(0);
    expect(expiredStatus.pools[0].active).toBe(0);
  });

  it("reclaims expired leases in wall-clock time", async () => {
    const pool = "wall-clock-expiry";

    const first = await store.grant({
      pool,
      cap: 1,
      ttl: "1s",
      holder: "short-lived",
    });
    expect(first.granted).toBe(true);

    // Wait 1.1s for lease to expire
    await sleep(1100);

    const second = await store.grant({
      pool,
      cap: 1,
      ttl: "5s",
      holder: "replacement",
    });
    expect(second.granted).toBe(true);
    if (second.granted) {
      expect(second.lease.holder).toBe("replacement");
    }
  });
});
