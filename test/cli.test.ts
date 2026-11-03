import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, normalizeArgv } from "../src/cli.js";

describe("CLI entrypoint and flag routing", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lease-axi-test-cli-"));
    storePath = join(tempDir, "leases.json");
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("normalizes argv correctly", () => {
    expect(normalizeArgv([])).toEqual(["status"]);
    expect(normalizeArgv(["--help"])).toEqual(["--help"]);
    expect(normalizeArgv(["-h"])).toEqual(["--help"]);
    expect(normalizeArgv(["-v"])).toEqual(["--version"]);
    expect(normalizeArgv(["list"])).toEqual(["status"]);
    expect(normalizeArgv(["list", "--pool", "p1"])).toEqual([
      "status",
      "--pool",
      "p1",
    ]);
    expect(normalizeArgv(["grant", "--pool", "p1"])).toEqual([
      "grant",
      "--pool",
      "p1",
    ]);
  });

  it("handles --version", async () => {
    let out = "";
    await main({
      argv: ["--version"],
      stdout: { write: (c) => (out += c) },
    });
    expect(out.trim()).toBe("0.1.0");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("handles --help", async () => {
    let out = "";
    await main({
      argv: ["--help"],
      stdout: { write: (c) => (out += c) },
    });
    expect(out).toContain("usage: lease-axi");
    expect(out).toContain("grant, renew, release, status (list), serve");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("fails with validation error on missing --pool", async () => {
    let out = "";
    await main({
      argv: ["grant", "--store", storePath],
      stdout: { write: (c) => (out += c) },
    });
    expect(out).toContain("VALIDATION_ERROR");
    expect(out).toContain("Missing required flag --pool");
    expect(process.exitCode).toBe(2);
  });

  it("grants lease and outputs TOON by default", async () => {
    let out = "";
    await main({
      argv: [
        "grant",
        "--pool",
        "cli-test-pool",
        "--cap",
        "1",
        "--ttl",
        "30s",
        "--holder",
        "cli-worker",
        "--store",
        storePath,
      ],
      stdout: { write: (c) => (out += c) },
    });
    expect(out).toContain("lease:");
    expect(out).toContain("pool: cli-test-pool");
    expect(out).toContain("holder: cli-worker");
    expect(out).toContain("ttl: 30s");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("grants lease and outputs JSON with --json", async () => {
    let out = "";
    await main({
      argv: [
        "grant",
        "--pool",
        "cli-json-pool",
        "--cap",
        "1",
        "--ttl",
        "45s",
        "--holder",
        "json-worker",
        "--store",
        storePath,
        "--json",
      ],
      stdout: { write: (c) => (out += c) },
    });
    const parsed = JSON.parse(out);
    expect(parsed.granted).toBe(true);
    expect(parsed.lease.pool).toBe("cli-json-pool");
    expect(parsed.lease.holder).toBe("json-worker");
    expect(parsed.lease.ttlSeconds).toBe(45);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("defers with exit 75 when pool is at capacity", async () => {
    // 1st grant succeeds
    await main({
      argv: [
        "grant",
        "--pool",
        "capped-pool",
        "--cap",
        "1",
        "--holder",
        "h1",
        "--store",
        storePath,
      ],
      stdout: { write: () => {} },
    });
    expect(process.exitCode ?? 0).toBe(0);

    // 2nd grant defers
    let out = "";
    await main({
      argv: [
        "grant",
        "--pool",
        "capped-pool",
        "--cap",
        "1",
        "--holder",
        "h2",
        "--store",
        storePath,
      ],
      stdout: { write: (c) => (out += c) },
    });

    expect(process.exitCode).toBe(75);
    expect(out).toContain("deferred:");
    expect(out).toContain("pool: capped-pool");
    expect(out).toContain("holders[1]{id,holder,expiresAt,remainingSeconds}:");
  });

  it("defers with exit 75 in JSON mode", async () => {
    // 1st grant succeeds
    await main({
      argv: [
        "grant",
        "--pool",
        "capped-json-pool",
        "--cap",
        "1",
        "--holder",
        "h1",
        "--store",
        storePath,
      ],
      stdout: { write: () => {} },
    });

    // 2nd grant defers with --json
    let out = "";
    await main({
      argv: [
        "grant",
        "--pool",
        "capped-json-pool",
        "--cap",
        "1",
        "--holder",
        "h2",
        "--store",
        storePath,
        "--json",
      ],
      stdout: { write: (c) => (out += c) },
    });

    expect(process.exitCode).toBe(75);
    const parsed = JSON.parse(out);
    expect(parsed.granted).toBe(false);
    expect(parsed.deferred).toBe(true);
    expect(parsed.pool).toBe("capped-json-pool");
    expect(parsed.holders).toHaveLength(1);
  });

  it("renews and releases via CLI", async () => {
    let grantOut = "";
    await main({
      argv: [
        "grant",
        "--pool",
        "lifecycle-pool",
        "--store",
        storePath,
        "--json",
      ],
      stdout: { write: (c) => (grantOut += c) },
    });
    const leaseId = JSON.parse(grantOut).lease.id;

    // Renew
    let renewOut = "";
    await main({
      argv: ["renew", leaseId, "--ttl", "100s", "--store", storePath],
      stdout: { write: (c) => (renewOut += c) },
    });
    expect(renewOut).toContain("renewed:");
    expect(renewOut).toContain(leaseId);
    expect(renewOut).toContain("ttl: 1m40s");

    // Release
    let releaseOut = "";
    await main({
      argv: ["release", leaseId, "--store", storePath],
      stdout: { write: (c) => (releaseOut += c) },
    });
    expect(releaseOut).toContain("released:");
    expect(releaseOut).toContain(leaseId);

    // Status is now empty
    let statusOut = "";
    await main({
      argv: ["status", "--store", storePath],
      stdout: { write: (c) => (statusOut += c) },
    });
    expect(statusOut).toContain("pools: []");
    expect(statusOut).toContain("leases: []");
  });
});
