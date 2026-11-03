import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLeaseStore } from "../src/store.js";

describe("Lease renew (heartbeat)", () => {
  let tempDir: string;
  let storePath: string;
  let store: FileLeaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lease-axi-test-renew-"));
    storePath = join(tempDir, "leases.json");
    store = new FileLeaseStore(storePath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("extends expiration time on active lease", async () => {
    const baseTime = Date.now();
    const grant = await store.grant(
      { pool: "renew-pool", cap: 1, ttl: "30s", holder: "worker-1" },
      baseTime,
    );
    expect(grant.granted).toBe(true);
    if (!grant.granted) return;

    const initialExpiresAt = grant.lease.expiresAt;

    // Renew 10 seconds later
    const renewTime = baseTime + 10_000;
    const renew = await store.renew({ id: grant.lease.id }, renewTime);

    expect(renew.renewed).toBe(true);
    expect(renew.lease.id).toBe(grant.lease.id);
    expect(Date.parse(renew.lease.expiresAt)).toBe(renewTime + 30_000);
    expect(Date.parse(renew.lease.expiresAt)).toBeGreaterThan(
      Date.parse(initialExpiresAt),
    );
  });

  it("extends expiration with custom TTL", async () => {
    const baseTime = Date.now();
    const grant = await store.grant(
      { pool: "renew-custom-ttl", cap: 1, ttl: "30s", holder: "worker-1" },
      baseTime,
    );
    expect(grant.granted).toBe(true);
    if (!grant.granted) return;

    const renewTime = baseTime + 5_000;
    const renew = await store.renew(
      { id: grant.lease.id, ttl: "120s" },
      renewTime,
    );

    expect(renew.renewed).toBe(true);
    expect(renew.lease.ttlSeconds).toBe(120);
    expect(Date.parse(renew.lease.expiresAt)).toBe(renewTime + 120_000);
  });

  it("fails to renew when lease has expired", async () => {
    const baseTime = Date.now();
    const grant = await store.grant(
      { pool: "renew-expired", cap: 1, ttl: "10s", holder: "worker-1" },
      baseTime,
    );
    expect(grant.granted).toBe(true);
    if (!grant.granted) return;

    // Attempt renew past expiry
    await expect(
      store.renew({ id: grant.lease.id }, baseTime + 15_000),
    ).rejects.toThrow(/not found or expired/i);
  });

  it("fails to renew nonexistent lease id", async () => {
    await expect(store.renew({ id: "lease_nonexistent" })).rejects.toThrow(
      /not found or expired/i,
    );
  });
});
