import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpLeaseClient } from "../src/client.js";
import { main } from "../src/cli.js";
import { BUILTIN_CONFIG } from "../src/config.js";
import { fileQuotaSource, type QuotaSource } from "../src/quota.js";
import { QuotaCache } from "../src/quota-cache.js";
import { type RunningServer, startServer } from "../src/server.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "quota-agy.json");

/** Counts probes so tests can prove readers never trigger one. */
function countingSource(inner: QuotaSource) {
  const state = { reads: 0, fail: false };
  const source: QuotaSource = {
    describe: inner.describe,
    async read() {
      state.reads++;
      if (state.fail) throw new Error("probe boom");
      return inner.read();
    },
  };
  return { source, state };
}

describe("QuotaCache", () => {
  it("reports age and flips to stale beyond the threshold", async () => {
    let now = 1_000_000;
    const { source } = countingSource(fileQuotaSource(FIXTURE));
    const cache = new QuotaCache(source, {
      intervalSeconds: 60,
      staleAfterSeconds: 120,
      now: () => now,
    });
    const fresh = await cache.get();
    expect(fresh.available).toBe(true);
    expect(fresh.ageSeconds).toBe(0);
    expect(fresh.stale).toBe(false);
    expect(fresh.pools.length).toBeGreaterThan(0);

    now += 119_000;
    expect((await cache.get()).stale).toBe(false);
    now += 2_000;
    const old = await cache.get();
    expect(old.ageSeconds).toBe(121);
    expect(old.stale).toBe(true);
  });

  it("serves get() from cache without probing again", async () => {
    const { source, state } = countingSource(fileQuotaSource(FIXTURE));
    const cache = new QuotaCache(source);
    await cache.get();
    await cache.get();
    await cache.get("agy/default/argon");
    expect(state.reads).toBe(1);
  });

  it("filters by pool", async () => {
    const cache = new QuotaCache(fileQuotaSource(FIXTURE));
    const r = await cache.get("agy/default/argon");
    expect(r.pools.map((p) => p.pool)).toEqual(["agy/default/argon"]);
  });

  it("keeps the last good snapshot when a refresh fails", async () => {
    const { source, state } = countingSource(fileQuotaSource(FIXTURE));
    const cache = new QuotaCache(source);
    await cache.get();
    state.fail = true;
    await cache.refresh();
    const r = await cache.get();
    expect(r.available).toBe(true);
    expect(r.error).toBe("probe boom");
    expect(r.pools.length).toBeGreaterThan(0);
  });

  it("is unavailable and stale when no probe has ever succeeded", async () => {
    const { source, state } = countingSource(fileQuotaSource(FIXTURE));
    state.fail = true;
    const r = await new QuotaCache(source).get();
    expect(r.available).toBe(false);
    expect(r.stale).toBe(true);
    expect(r.ageSeconds).toBeNull();
    expect(r.error).toBe("probe boom");
  });

  it("refreshes on its interval once started", async () => {
    const { source, state } = countingSource(fileQuotaSource(FIXTURE));
    const cache = new QuotaCache(source, { intervalSeconds: 0.05 });
    cache.start();
    await new Promise((r) => setTimeout(r, 220));
    cache.stop();
    expect(state.reads).toBeGreaterThanOrEqual(3);
  });
});

describe("serve quota endpoint and quota command", () => {
  let dir: string;
  let server: RunningServer;
  afterEach(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
    server = undefined;
    dir = "";
    process.exitCode = undefined;
  });

  async function boot(source: QuotaSource, extra = {}) {
    dir = mkdtempSync(join(tmpdir(), "lease-axi-test-quota-cache-"));
    server = await startServer({
      bind: "127.0.0.1",
      port: 0,
      storePath: join(dir, "leases.json"),
      config: BUILTIN_CONFIG,
      quota: source,
      ...extra,
    });
  }

  it("serves one snapshot to many readers with a single probe", async () => {
    const { source, state } = countingSource(fileQuotaSource(FIXTURE));
    await boot(source, { quotaIntervalSeconds: 3600 });
    const client = new HttpLeaseClient(server!.url);
    for (let i = 0; i < 5; i++) await client.quota();
    await client.pools();
    await fetch(`${server!.url}/pools`);
    expect(state.reads).toBe(1);
    const r = await client.quota();
    expect(r.available).toBe(true);
    expect(r.stale).toBe(false);
    expect(r.intervalSeconds).toBe(3600);
    expect(r.staleAfterSeconds).toBe(10800);
    expect(typeof r.fetchedAt).toBe("string");
  });

  it("adds snapshot age to the pools view", async () => {
    await boot(fileQuotaSource(FIXTURE));
    const view = await new HttpLeaseClient(server!.url).pools();
    expect(view.quota.available).toBe(true);
    expect(view.quota.stale).toBe(false);
    expect(view.quota.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it("filters GET /quota by pool", async () => {
    await boot(fileQuotaSource(FIXTURE));
    const r = await new HttpLeaseClient(server!.url).quota("agy/default/argon");
    expect(r.pools).toHaveLength(1);
  });

  it("re-probes on the configured interval", async () => {
    const { source, state } = countingSource(fileQuotaSource(FIXTURE));
    await boot(source, { quotaIntervalSeconds: 0.05 });
    await new Promise((r) => setTimeout(r, 250));
    expect(state.reads).toBeGreaterThanOrEqual(3);
  });

  it("flags stale when the probe fails and the snapshot ages out", async () => {
    const { source, state } = countingSource(fileQuotaSource(FIXTURE));
    await boot(source, {
      quotaIntervalSeconds: 0.05,
      quotaStaleAfterSeconds: 1,
    });
    await new HttpLeaseClient(server!.url).quota();
    state.fail = true;
    await new Promise((r) => setTimeout(r, 1600));
    const r = await new HttpLeaseClient(server!.url).quota();
    expect(r.error).toBe("probe boom");
    expect(r.stale).toBe(true);
    expect(r.available).toBe(true);
  });

  it("CLI quota prints TOON by default, JSON with --json, and never probes", async () => {
    const { source, state } = countingSource(fileQuotaSource(FIXTURE));
    await boot(source, { quotaIntervalSeconds: 3600 });
    let toon = "";
    await main({
      argv: ["quota", "--server", server!.url],
      stdout: { write: (c) => (toon += c) },
    });
    expect(toon).toContain("snapshot:");
    expect(toon).toContain("agy/default/argon");
    expect(toon).not.toContain("warning");
    let json = "";
    await main({
      argv: ["quota", "--server", server!.url, "--json"],
      stdout: { write: (c) => (json += c) },
    });
    expect(JSON.parse(json).pools.length).toBeGreaterThan(0);
    expect(state.reads).toBe(1);
  });

  it("CLI quota warns when the snapshot is stale", async () => {
    const { source, state } = countingSource(fileQuotaSource(FIXTURE));
    state.fail = true;
    await boot(source);
    let out = "";
    await main({
      argv: ["quota", "--server", server!.url],
      stdout: { write: (c) => (out += c) },
    });
    expect(out).toContain("warning");
    expect(out).toContain("no quota snapshot yet");
  });

  it("CLI quota refuses to run without a server (exit 2, no local probe)", async () => {
    const saved = process.env.LEASE_AXI_SERVER;
    delete process.env.LEASE_AXI_SERVER;
    let out = "";
    try {
      await main({
        argv: ["quota"],
        stdout: { write: (c) => (out += c) },
      });
    } finally {
      if (saved !== undefined) process.env.LEASE_AXI_SERVER = saved;
    }
    expect(out).toContain("VALIDATION_ERROR");
    expect(process.exitCode).toBe(2);
    dir = mkdtempSync(join(tmpdir(), "lease-axi-test-quota-cache-"));
  });
});
