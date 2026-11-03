import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLeaseStore } from "../src/store.js";

describe("Lease release", () => {
  let tempDir: string;
  let storePath: string;
  let store: FileLeaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lease-axi-test-release-"));
    storePath = join(tempDir, "leases.json");
    store = new FileLeaseStore(storePath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("releases an active lease and frees the slot immediately", async () => {
    const pool = "release-pool";
    const first = await store.grant({ pool, cap: 1, ttl: 60, holder: "h1" });
    expect(first.granted).toBe(true);
    if (!first.granted) return;

    // Second grant defers
    const secondBefore = await store.grant({
      pool,
      cap: 1,
      ttl: 60,
      holder: "h2",
    });
    expect(secondBefore.granted).toBe(false);

    // First releases
    const rel = await store.release({ id: first.lease.id });
    expect(rel.released).toBe(true);
    expect(rel.id).toBe(first.lease.id);
    expect(rel.pool).toBe(pool);
    expect(rel.holder).toBe("h1");

    // Second grant now succeeds immediately
    const secondAfter = await store.grant({
      pool,
      cap: 1,
      ttl: 60,
      holder: "h2",
    });
    expect(secondAfter.granted).toBe(true);
    if (secondAfter.granted) {
      expect(secondAfter.lease.holder).toBe("h2");
    }
  });

  it("is idempotent when releasing already released lease", async () => {
    const pool = "idempotent-release";
    const grant = await store.grant({ pool, cap: 1, ttl: 60, holder: "h1" });
    expect(grant.granted).toBe(true);
    if (!grant.granted) return;

    const rel1 = await store.release({ id: grant.lease.id });
    expect(rel1.released).toBe(true);
    expect(rel1.alreadyReleased).toBeFalsy();

    const rel2 = await store.release({ id: grant.lease.id });
    expect(rel2.released).toBe(true);
    expect(rel2.alreadyReleased).toBe(true);
  });
});
