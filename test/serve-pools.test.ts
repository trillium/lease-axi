import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpLeaseClient } from "../src/client.js";
import { main } from "../src/cli.js";
import { BUILTIN_CONFIG, parsePoolConfig } from "../src/config.js";
import { fileQuotaSource } from "../src/quota.js";
import { type RunningServer, startServer } from "../src/server.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "quota-agy.json");

describe("shared authority: one lease table across clients", () => {
  let dir: string;
  let server: RunningServer;
  let a: HttpLeaseClient;
  let b: HttpLeaseClient;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lease-axi-test-serve-pools-"));
    server = await startServer({
      bind: "127.0.0.1",
      port: 0,
      storePath: join(dir, "leases.json"),
      config: parsePoolConfig({
        pools: { "agy/default/gemini": { requireTask: true } },
      }),
      quota: fileQuotaSource(FIXTURE),
    });
    a = new HttpLeaseClient(server.url);
    b = new HttpLeaseClient(server.url);
  });

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("defers client B while client A holds the agy pool", async () => {
    const first = await a.grant({
      pool: "agy/default/argon",
      cap: 9,
      holder: "machine-a",
      task: "index repo",
      expectDuration: "30m",
    });
    expect(first.granted).toBe(true);
    const second = await b.grant({
      pool: "agy/default/argon",
      holder: "machine-b",
    });
    expect(second.granted).toBe(false);
    if (!second.granted) {
      expect(second.cap).toBe(1);
      expect(second.holders[0].holder).toBe("machine-a");
      expect(second.holders[0].task).toBe("index repo");
    }
  });

  it("serves the joined pools view to any client", async () => {
    const view = await b.pools();
    const argon = view.pools.find((p) => p.pool === "agy/default/argon");
    expect(argon?.active).toBe(1);
    expect(argon?.holders[0].holder).toBe("machine-a");
    expect(view.quota.available).toBe(true);
    expect(view.idle).not.toContain("agy/default/argon");
  });

  it("enforces server-side config over HTTP as a 400 validation error", async () => {
    await expect(
      a.grant({ pool: "agy/default/gemini", holder: "x" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const res = await fetch(`${server.url}/grant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pool: "agy/default/gemini" }),
    });
    expect(res.status).toBe(400);
  });

  it("lets the CLI use --server for grant and pools", async () => {
    let out = "";
    await main({
      argv: ["pools", "--server", server.url, "--json"],
      stdout: { write: (c) => (out += c) },
    });
    expect(JSON.parse(out).pools.length).toBeGreaterThan(0);
    process.exitCode = undefined;
  });

  it("uses built-in config when none is given", async () => {
    const plain = await startServer({
      bind: "127.0.0.1",
      port: 0,
      storePath: join(dir, "plain.json"),
      config: BUILTIN_CONFIG,
      quota: fileQuotaSource(FIXTURE),
    });
    try {
      const c = new HttpLeaseClient(plain.url);
      expect(
        (await c.grant({ pool: "agy/default/gemini", cap: 4 })).granted,
      ).toBe(true);
      expect(
        (await c.grant({ pool: "agy/default/gemini", cap: 4 })).granted,
      ).toBe(false);
    } finally {
      await plain.close();
    }
  });
});
