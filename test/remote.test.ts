import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpLeaseClient } from "../src/client.js";
import { type RunningServer, startServer } from "../src/server.js";
import { FileLeaseStore } from "../src/store.js";

describe("Remote HTTP authority mode", () => {
  let tempDir: string;
  let storePath: string;
  let runningServer: RunningServer;
  let client: HttpLeaseClient;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lease-axi-test-remote-"));
    storePath = join(tempDir, "leases.json");
    const store = new FileLeaseStore(storePath);

    // Port 0 picks random available ephemeral port
    runningServer = await startServer({
      bind: "127.0.0.1",
      port: 0,
      store,
    });

    client = new HttpLeaseClient(runningServer.url);
  });

  afterAll(async () => {
    await runningServer.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("checks health endpoint", async () => {
    const res = await fetch(`${runningServer.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.version).toBeDefined();
  });

  it("grants, renews, checks status, and releases over HTTP", async () => {
    const pool = "http-pool-1";

    // 1. Grant
    const grant = await client.grant({
      pool,
      cap: 1,
      ttl: "45s",
      holder: "remote-worker-1",
    });

    expect(grant.granted).toBe(true);
    if (!grant.granted) return;
    expect(grant.lease.pool).toBe(pool);
    expect(grant.lease.holder).toBe("remote-worker-1");

    // 2. Second grant defers over HTTP (HTTP 429)
    const secondGrant = await client.grant({
      pool,
      cap: 1,
      ttl: "45s",
      holder: "remote-worker-2",
    });
    expect(secondGrant.granted).toBe(false);
    if (!secondGrant.granted) {
      expect(secondGrant.deferred).toBe(true);
      expect(secondGrant.holders[0].holder).toBe("remote-worker-1");
    }

    // 3. Status
    const status = await client.status(pool);
    expect(status.pools[0].active).toBe(1);
    expect(status.leases).toHaveLength(1);
    expect(status.leases[0].id).toBe(grant.lease.id);

    // 4. Renew
    const renew = await client.renew({
      id: grant.lease.id,
      ttl: "90s",
    });
    expect(renew.renewed).toBe(true);
    expect(renew.lease.ttlSeconds).toBe(90);

    // 5. Release
    const rel = await client.release({ id: grant.lease.id });
    expect(rel.released).toBe(true);
    expect(rel.id).toBe(grant.lease.id);

    // 6. After release, slot is free for worker-2
    const retryGrant = await client.grant({
      pool,
      cap: 1,
      ttl: "30s",
      holder: "remote-worker-2",
    });
    expect(retryGrant.granted).toBe(true);
    if (retryGrant.granted) {
      expect(retryGrant.lease.holder).toBe("remote-worker-2");
      await client.release({ id: retryGrant.lease.id });
    }
  });

  it("reclaims expired leases over HTTP", async () => {
    const pool = "http-expiry-pool";

    const grant = await client.grant({
      pool,
      cap: 1,
      ttl: "1s",
      holder: "short-lived",
    });
    expect(grant.granted).toBe(true);

    // Wait for TTL to lapse
    await sleep(1100);

    // New grant should succeed immediately, having reclaimed expired slot
    const second = await client.grant({
      pool,
      cap: 1,
      ttl: "10s",
      holder: "replacement",
    });
    expect(second.granted).toBe(true);
    if (second.granted) {
      expect(second.lease.holder).toBe("replacement");
      await client.release({ id: second.lease.id });
    }
  });

  it("handles concurrent grant requests across HTTP clients", async () => {
    const pool = "http-concurrent-pool";
    const cap = 2;
    const concurrent = 8;

    const promises = Array.from({ length: concurrent }, (_, i) =>
      client.grant({
        pool,
        cap,
        ttl: 30,
        holder: `http-agent-${i}`,
      }),
    );

    const results = await Promise.all(promises);
    const granted = results.filter((r) => r.granted);
    const deferred = results.filter((r) => !r.granted);

    expect(granted).toHaveLength(2);
    expect(deferred).toHaveLength(6);

    for (const g of granted) {
      if (g.granted) {
        await client.release({ id: g.lease.id });
      }
    }
  });
});
