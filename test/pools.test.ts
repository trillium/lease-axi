import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import {
  BUILTIN_CONFIG,
  loadPoolConfig,
  parsePoolConfig,
  resolvePoolRule,
} from "../src/config.js";
import { buildPoolsView, idleReason } from "../src/pools.js";
import {
  commandQuotaSource,
  fileQuotaSource,
  parseQuotaDocument,
  scopeFromWindowId,
} from "../src/quota.js";
import { FileLeaseStore } from "../src/store.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "quota-agy.json");
// argon unstarted, claude_gpt 5h resets in 20m, gemini healthy.
const NOW = Date.parse("2026-11-15T01:10:00.000Z");

describe("quota discovery", () => {
  it("names pools provider/account/scope from quota-axi JSON", async () => {
    const snap = await fileQuotaSource(FIXTURE).read();
    const names = snap.pools.map((p) => p.pool);
    expect(names).toEqual([
      "agy/default/gemini",
      "agy/default/claude_gpt",
      "agy/default/argon",
      "codex/default/all",
      "opencode-go/default/all",
      "grok/default/all",
    ]);
  });

  it("skips providers that report no windows", () => {
    const snap = parseQuotaDocument({
      providers: [{ provider: "cursor", accountKey: "default", windows: [] }],
    });
    expect(snap.pools).toEqual([]);
  });

  it("falls back to window-id scopes when semantics are absent", () => {
    expect(scopeFromWindowId("gemini_5h")).toBe("gemini");
    expect(scopeFromWindowId("claude_gpt_weekly")).toBe("claude_gpt");
    expect(scopeFromWindowId("model:fable")).toBe("model:fable");
    expect(scopeFromWindowId("seven_day")).toBe("all");
    const snap = parseQuotaDocument({
      providers: [
        {
          provider: "agy",
          accountKey: "default",
          windows: [
            { id: "gemini_5h", kind: "session", percentRemaining: 90 },
            { id: "gemini_weekly", kind: "weekly", percentRemaining: 95 },
            { id: "argon_weekly", kind: "weekly", percentRemaining: 100 },
          ],
        },
      ],
    });
    expect(snap.pools.map((p) => p.pool)).toEqual([
      "agy/default/gemini",
      "agy/default/argon",
    ]);
  });

  it("reports a missing quota-axi binary as an error, not a crash", async () => {
    await expect(
      commandQuotaSource("/nonexistent/quota-axi-missing").read(),
    ).rejects.toThrow(/not found/);
  });
});

describe("pool config", () => {
  it("caps agy, codex and opencode-go at 1 by default and leaves others uncapped", () => {
    expect(resolvePoolRule(BUILTIN_CONFIG, "agy/default/argon").cap).toBe(1);
    expect(resolvePoolRule(BUILTIN_CONFIG, "codex/default/all").cap).toBe(1);
    expect(resolvePoolRule(BUILTIN_CONFIG, "opencode-go/default/all").cap).toBe(
      1,
    );
    expect(resolvePoolRule(BUILTIN_CONFIG, "grok/default/all").cap).toBe(
      undefined,
    );
  });

  it("lets an exact pool rule beat the provider rule", () => {
    const cfg = parsePoolConfig({
      providers: { agy: { cap: 1 } },
      pools: { "agy/default/gemini": { cap: 2, requireTask: true } },
    });
    expect(resolvePoolRule(cfg, "agy/default/gemini")).toEqual({
      cap: 2,
      requireTask: true,
    });
    expect(resolvePoolRule(cfg, "agy/default/argon").cap).toBe(1);
  });

  it("rejects malformed config", () => {
    expect(() => parsePoolConfig({ pools: { x: { cap: 0 } } })).toThrow(/cap/);
    expect(() => parsePoolConfig([])).toThrow(/object/);
    expect(() => parsePoolConfig({ idle: { nearExpiryMinutes: -1 } })).toThrow(
      /nearExpiryMinutes/,
    );
  });

  it("loads from a file and errors on a missing explicit path", () => {
    const dir = mkdtempSync(join(tmpdir(), "lease-axi-test-config-"));
    try {
      const path = join(dir, "pools.json");
      writeFileSync(path, JSON.stringify({ idle: { nearExpiryMinutes: 15 } }));
      expect(loadPoolConfig(path).idle.nearExpiryMinutes).toBe(15);
      expect(() => loadPoolConfig(join(dir, "nope.json"))).toThrow(/not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cap and expected-usage enforcement", () => {
  let dir: string;
  let store: FileLeaseStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-axi-test-enforce-"));
    store = new FileLeaseStore(join(dir, "leases.json"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("holds an agy pool to one task even when the caller asks for more", async () => {
    const first = await store.grant({
      pool: "agy/default/argon",
      cap: 5,
      holder: "a",
    });
    expect(first.granted).toBe(true);
    if (first.granted) expect(first.lease.cap).toBe(1);
    const second = await store.grant({
      pool: "agy/default/argon",
      cap: 5,
      holder: "b",
    });
    expect(second.granted).toBe(false);
  });

  it("keeps the three agy scopes independent", async () => {
    for (const scope of ["argon", "gemini", "claude_gpt"]) {
      const r = await store.grant({
        pool: `agy/default/${scope}`,
        holder: scope,
      });
      expect(r.granted).toBe(true);
    }
  });

  it("records the declared task, duration and size on the lease", async () => {
    const r = await store.grant({
      pool: "agy/default/gemini",
      holder: "w1",
      task: " refactor parser ",
      expectDuration: "20m",
      expectSize: "medium",
    });
    expect(r.granted && r.lease.expected).toEqual({
      task: "refactor parser",
      durationSeconds: 1200,
      size: "medium",
    });
    const blocked = await store.grant({
      pool: "agy/default/gemini",
      holder: "w2",
    });
    expect(!blocked.granted && blocked.holders[0].task).toBe("refactor parser");
  });

  it("refuses a grant without --task when the pool requires one", async () => {
    const strict = new FileLeaseStore(
      join(dir, "strict.json"),
      parsePoolConfig({
        pools: { "agy/default/argon": { requireTask: true } },
      }),
    );
    await expect(
      strict.grant({ pool: "agy/default/argon", holder: "w" }),
    ).rejects.toThrow(/requires a declared task/);
    const ok = await strict.grant({
      pool: "agy/default/argon",
      holder: "w",
      task: "t",
    });
    expect(ok.granted).toBe(true);
  });

  it("rejects an unparseable expected duration", async () => {
    await expect(
      store.grant({ pool: "p", expectDuration: "soon" }),
    ).rejects.toThrow(/Invalid duration/);
  });
});

describe("pools view", () => {
  let dir: string;
  let store: FileLeaseStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-axi-test-poolsview-"));
    store = new FileLeaseStore(join(dir, "leases.json"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("flags unstarted and near-expiry pools that have no lease", async () => {
    const view = await buildPoolsView(
      await store.status(),
      fileQuotaSource(FIXTURE),
      BUILTIN_CONFIG,
      NOW,
    );
    const byName = Object.fromEntries(view.pools.map((p) => [p.pool, p]));
    expect(byName["agy/default/argon"].idle).toBe("unstarted");
    expect(byName["agy/default/claude_gpt"].idle).toBe("near-expiry");
    expect(byName["agy/default/gemini"].idle).toBeNull();
    // codex is not config-managed, so it is never flagged even when unstarted
    expect(byName["grok/default/all"].idle).toBeNull();
    // codex five_hour sits at 100% unstarted: flagged under the same one-at-a-time rule
    expect(byName["codex/default/all"].idle).toBe("unstarted");
    expect(byName["codex/default/all"].cap).toBe(1);
    // opencode-go weekly resets in 30m with 60% unused
    expect(byName["opencode-go/default/all"].idle).toBe("near-expiry");
    expect(view.idle).toEqual([
      "agy/default/argon",
      "agy/default/claude_gpt",
      "codex/default/all",
      "opencode-go/default/all",
    ]);
    expect(byName["agy/default/gemini"].quota?.percentRemaining).toBe(98);
    expect(byName["agy/default/claude_gpt"].quota?.resetsInSeconds).toBe(1200);
  });

  it("clears the flag once a lease holds the pool", async () => {
    await store.grant({
      pool: "agy/default/argon",
      holder: "w1",
      task: "index repo",
      expectDuration: "1h",
    });
    const view = await buildPoolsView(
      await store.status(),
      fileQuotaSource(FIXTURE),
      BUILTIN_CONFIG,
      NOW,
    );
    const argon = view.pools.find((p) => p.pool === "agy/default/argon");
    expect(argon?.idle).toBeNull();
    expect(argon?.active).toBe(1);
    expect(argon?.cap).toBe(1);
    expect(argon?.holders[0]).toMatchObject({
      holder: "w1",
      task: "index repo",
      expectedSeconds: 3600,
    });
    expect(view.idle).not.toContain("agy/default/argon");
  });

  it("does not flag an exhausted pool", () => {
    expect(
      idleReason(
        { percentRemaining: 0, windowStarted: false, windows: [] },
        60,
      ),
    ).toBeNull();
  });

  it("works without quota-axi: leases and configured pools still show", async () => {
    await store.grant({ pool: "agy/default/gemini", holder: "w1" });
    const view = await buildPoolsView(
      await store.status(),
      commandQuotaSource("/nonexistent/quota-axi-missing"),
      parsePoolConfig({ pools: { "agy/default/argon": { cap: 1 } } }),
      NOW,
    );
    expect(view.quota.available).toBe(false);
    expect(view.quota.error).toMatch(/not found/);
    expect(view.pools.map((p) => p.pool)).toEqual([
      "agy/default/argon",
      "agy/default/gemini",
    ]);
    expect(view.idle).toEqual([]);
  });
});

describe("pools CLI verb", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-axi-test-poolscli-"));
    storePath = join(dir, "leases.json");
    process.exitCode = undefined;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function run(argv: string[]): Promise<string> {
    let out = "";
    await main({ argv, stdout: { write: (c) => (out += c) } });
    return out;
  }

  it("grants with declared usage then shows it in pools --json", async () => {
    const granted = await run([
      "grant",
      "--pool",
      "agy/default/argon",
      "--holder",
      "worker-1",
      "--task",
      "refactor parser",
      "--expect-duration",
      "20m",
      "--expect-size=medium",
      "--store",
      storePath,
    ]);
    expect(granted).toContain("task: refactor parser");
    expect(granted).toContain("expectedDuration: 20m");
    expect(granted).toContain("expectedSize: medium");

    const out = await run([
      "pools",
      "--store",
      storePath,
      "--quota-file",
      FIXTURE,
      "--json",
    ]);
    const parsed = JSON.parse(out);
    const argon = parsed.pools.find(
      (p: { pool: string }) => p.pool === "agy/default/argon",
    );
    expect(argon.active).toBe(1);
    expect(argon.holders[0].task).toBe("refactor parser");
    expect(parsed.quota.available).toBe(true);
  });

  it("renders TOON with an idle warning", async () => {
    const out = await run([
      "pools",
      "--store",
      storePath,
      "--quota-file",
      FIXTURE,
    ]);
    expect(out).toContain("pools[");
    expect(out).toContain("agy/default/argon");
    expect(out).toContain("idle pools with no lease");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("degrades cleanly when quota-axi is missing", async () => {
    const prev = process.env.LEASE_AXI_QUOTA_BIN;
    process.env.LEASE_AXI_QUOTA_BIN = "/nonexistent/quota-axi-missing";
    try {
      const out = await run(["pools", "--store", storePath, "--json"]);
      const parsed = JSON.parse(out);
      expect(parsed.quota.available).toBe(false);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.LEASE_AXI_QUOTA_BIN;
      else process.env.LEASE_AXI_QUOTA_BIN = prev;
    }
  });

  it("exits 2 on an unknown flag and on a task-less grant to a requireTask pool", async () => {
    const bad = await run(["pools", "--bogus"]);
    expect(bad).toContain("VALIDATION_ERROR");
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;

    const cfg = join(dir, "pools.json");
    writeFileSync(
      cfg,
      JSON.stringify({ pools: { "agy/default/argon": { requireTask: true } } }),
    );
    const out = await run([
      "grant",
      "--pool",
      "agy/default/argon",
      "--config",
      cfg,
      "--store",
      storePath,
    ]);
    expect(out).toContain("requires a declared task");
    expect(process.exitCode).toBe(2);
  });
});
