import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { BUILTIN_CONFIG, parsePoolConfig } from "../src/config.js";
import {
  commandLoadSource,
  evaluateMachines,
  fileLoadSource,
  parseBeszelHosts,
} from "../src/machines.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "beszel-hosts.json");

describe("machine load evaluation", () => {
  it("parses beszel hosts --json", async () => {
    const hosts = await fileLoadSource(FIXTURE).read();
    expect(hosts[0]).toEqual({
      name: "mini0",
      status: "up",
      load1: 30.2,
      cores: 10,
    });
    expect(hosts).toHaveLength(5);
  });

  it("orders eligible machines least-loaded first and refuses the overloaded one", async () => {
    const hosts = await fileLoadSource(FIXTURE).read();
    const r = evaluateMachines(hosts, BUILTIN_CONFIG, "t");
    expect(r.eligible.map((m) => m.machine)).toEqual([
      "m1studio1",
      "mini1",
      "lnx-server",
    ]);
    const mini0 = r.refused.find((m) => m.machine === "mini0");
    expect(mini0?.reason).toMatch(
      /load per core 3.02 exceeds maxLoadPerCore 1.5/,
    );
    expect(r.refused.find((m) => m.machine === "mini3")?.reason).toBe(
      "host is down",
    );
  });

  it("honours absolute maxLoad and config-order spread", async () => {
    const hosts = await fileLoadSource(FIXTURE).read();
    const cfg = parsePoolConfig({
      machines: {
        mini1: { maxLoad: 2 },
        lnx: {},
        "lnx-server": { maxLoad: 5 },
        m1studio1: {},
      },
      spread: "config-order",
    });
    const r = evaluateMachines(hosts, cfg, "t");
    expect(r.eligible.map((m) => m.machine)).toEqual([
      "lnx-server",
      "m1studio1",
    ]);
    expect(r.refused.map((m) => [m.machine, m.reason])).toEqual([
      ["mini1", "load 2.7 exceeds maxLoad 2"],
      ["lnx", "not reported by beszel (unknown host)"],
    ]);
  });

  it("refuses rather than guesses when cores are unknown for a per-core limit", () => {
    const r = evaluateMachines(
      [{ name: "x", status: "up", load1: 1 }],
      BUILTIN_CONFIG,
      "t",
    );
    expect(r.eligible).toEqual([]);
    expect(r.refused[0].reason).toMatch(/core count unknown/);
  });

  it("can narrow to named machines", async () => {
    const hosts = await fileLoadSource(FIXTURE).read();
    const r = evaluateMachines(hosts, BUILTIN_CONFIG, "t", ["mini0"]);
    expect(r.eligible).toEqual([]);
    expect(r.refused).toHaveLength(1);
  });

  it("rejects malformed machine config", () => {
    expect(() => parsePoolConfig({ machines: { a: { maxLoad: 0 } } })).toThrow(
      /maxLoad/,
    );
    expect(() => parsePoolConfig({ machines: [] })).toThrow(/machines/);
    expect(() => parsePoolConfig({ spread: "random" })).toThrow(/spread/);
  });

  it("rejects a beszel error document", () => {
    expect(() =>
      parseBeszelHosts({ v: 1, error: "auth failed", exit: 4 }),
    ).toThrow(/auth failed/);
  });
});

describe("beszel command source and CLI", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-axi-test-machines-"));
    process.exitCode = undefined;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.LEASE_AXI_BESZEL_BIN;
    process.exitCode = undefined;
  });

  function fakeBeszel(script: string): string {
    const bin = join(dir, "beszel");
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  async function run(argv: string[]) {
    let out = "";
    await main({ argv, stdout: { write: (c) => (out += c) } });
    return out;
  }

  it("runs `beszel hosts --json` and reads it", async () => {
    const bin = fakeBeszel(
      `[ "$1 $2" = "hosts --json" ] || exit 64\ncat '${FIXTURE}'`,
    );
    const hosts = await commandLoadSource(bin).read();
    expect(hosts.map((h) => h.name)).toContain("mini1");
  });

  it("reports a missing beszel binary", async () => {
    await expect(
      commandLoadSource("/nonexistent/beszel-missing").read(),
    ).rejects.toThrow(/not found/);
  });

  it("surfaces beszel's own hub error message", async () => {
    const bin = fakeBeszel(
      `echo '{"v":1,"error":"hub unreachable","exit":4}'\nexit 4`,
    );
    await expect(commandLoadSource(bin).read()).rejects.toThrow(
      /hub unreachable/,
    );
  });

  it("prints the ranking and exits 0 when a machine is eligible", async () => {
    const out = await run(["machines", "--beszel-file", FIXTURE, "--json"]);
    const doc = JSON.parse(out);
    expect(doc.eligible[0].machine).toBe("m1studio1");
    expect(doc.refused.map((m: { machine: string }) => m.machine)).toContain(
      "mini0",
    );
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("TOON output names the best machine and the refusal reason", async () => {
    const out = await run(["machines", "--beszel-file", FIXTURE]);
    expect(out).toContain("best: m1studio1");
    expect(out).toContain("exceeds maxLoadPerCore");
  });

  it("exits 75 when every requested machine is over its limit", async () => {
    const out = await run([
      "machines",
      "--beszel-file",
      FIXTURE,
      "--machine",
      "mini0,mini3",
    ]);
    expect(out).toContain("no machine is under its load limit");
    expect(process.exitCode).toBe(75);
  });

  it("reports unreachable beszel with a clear error and exit 1, not a guess", async () => {
    process.env.LEASE_AXI_BESZEL_BIN = fakeBeszel(
      `echo '{"v":1,"error":"hub unreachable","exit":4}'\nexit 4`,
    );
    const out = await run(["machines"]);
    expect(out).toContain("BESZEL_UNAVAILABLE");
    expect(out).toContain("hub unreachable");
    expect(out).toContain("not guessed");
    expect(process.exitCode).toBe(1);
  });
});
