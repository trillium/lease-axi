import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_PATH = join(__dirname, "..", "dist", "bin", "lease-axi.js");

describe("Built CLI binary execution", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lease-axi-test-built-cli-"));
    storePath = join(tempDir, "leases.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs --version on built binary", async () => {
    const { stdout } = await execFileAsync("node", [CLI_PATH, "--version"]);
    expect(stdout.trim()).toBe("0.1.0");
  });

  it("runs --help on built binary", async () => {
    const { stdout } = await execFileAsync("node", [CLI_PATH, "--help"]);
    expect(stdout).toContain("usage: lease-axi");
  });

  it("grants slot and exits 0; second process defers with exit 75", async () => {
    // Process 1: grant
    const p1 = await execFileAsync("node", [
      CLI_PATH,
      "grant",
      "--pool",
      "binary-pool",
      "--cap",
      "1",
      "--holder",
      "proc-1",
      "--store",
      storePath,
    ]);
    expect(p1.stdout).toContain("lease:");
    expect(p1.stdout).toContain("holder: proc-1");

    // Process 2: should exit 75
    let exitCode: number | undefined;
    let p2Stdout = "";
    try {
      await execFileAsync("node", [
        CLI_PATH,
        "grant",
        "--pool",
        "binary-pool",
        "--cap",
        "1",
        "--holder",
        "proc-2",
        "--store",
        storePath,
      ]);
    } catch (err: any) {
      exitCode = err.code;
      p2Stdout = err.stdout;
    }

    expect(exitCode).toBe(75);
    expect(p2Stdout).toContain("deferred:");
    expect(p2Stdout).toContain("proc-1");
  });
});
