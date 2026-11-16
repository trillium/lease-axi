import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { MachineRule, MachinesConfig } from "./config.js";

/** One host as reported by `beszel hosts --json`. */
export type HostLoad = {
  name: string;
  status: string;
  load1?: number;
  cores?: number;
};

export type LoadSource = {
  describe: string;
  read(): Promise<HostLoad[]>;
};

export type MachineVerdict = {
  machine: string;
  /** Per-core 1-minute load, the value machines are ordered by. */
  loadPerCore?: number;
  load1?: number;
  cores?: number;
  status?: string;
  limit: MachineRule;
};

export type EligibleMachine = MachineVerdict;
export type RefusedMachine = MachineVerdict & { reason: string };

export type MachinesResult = {
  source: string;
  policy: MachinesConfig["spread"];
  /** Best choice first. */
  eligible: EligibleMachine[];
  refused: RefusedMachine[];
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Turn a `beszel hosts --json` document into host loads. Throws on an error document. */
export function parseBeszelHosts(doc: unknown): HostLoad[] {
  const root = (doc ?? {}) as { items?: unknown; error?: unknown };
  if (typeof root.error === "string") throw new Error(root.error);
  if (!Array.isArray(root.items)) {
    throw new Error("beszel hosts --json has no items array");
  }
  const hosts: HostLoad[] = [];
  for (const item of root.items as Array<Record<string, unknown>>) {
    if (typeof item?.name !== "string") continue;
    const display = (item.display ?? {}) as Record<string, unknown>;
    const la = Array.isArray(display.load) ? display.load : [];
    hosts.push({
      name: item.name,
      status: typeof item.status === "string" ? item.status : "unknown",
      load1: num(la[0]),
      cores: num(display.cores),
    });
  }
  return hosts;
}

export function fileLoadSource(path: string): LoadSource {
  return {
    describe: `file:${path}`,
    async read() {
      return parseBeszelHosts(JSON.parse(readFileSync(path, "utf8")));
    },
  };
}

export function commandLoadSource(bin: string, timeoutMs = 30_000): LoadSource {
  return {
    describe: `cmd:${bin} hosts --json`,
    read() {
      return new Promise<HostLoad[]>((resolve, reject) => {
        execFile(
          bin,
          ["hosts", "--json"],
          { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => {
            // beszel prints a JSON error document (exit 4 for hub/auth errors);
            // prefer its message over the bare exit status.
            let doc: unknown;
            try {
              doc = JSON.parse(stdout);
            } catch {
              doc = undefined;
            }
            if (err && doc === undefined) {
              reject(
                new Error(
                  (err as NodeJS.ErrnoException).code === "ENOENT"
                    ? `${bin} not found on PATH`
                    : `${bin} failed: ${err.message}`,
                ),
              );
              return;
            }
            if (doc === undefined) {
              reject(new Error(`${bin} did not print valid JSON`));
              return;
            }
            try {
              resolve(parseBeszelHosts(doc));
            } catch (parseErr) {
              reject(new Error(`${bin}: ${(parseErr as Error).message}`));
            }
          },
        );
      });
    },
  };
}

/** `--beszel-file` beats LEASE_AXI_BESZEL_FILE beats LEASE_AXI_BESZEL_BIN beats `beszel`. */
export function resolveLoadSource(file?: string): LoadSource {
  const f = file ?? process.env.LEASE_AXI_BESZEL_FILE;
  if (f) return fileLoadSource(f);
  return commandLoadSource(process.env.LEASE_AXI_BESZEL_BIN ?? "beszel");
}

function ruleFor(config: MachinesConfig, name: string): MachineRule {
  return { ...config.machines["*"], ...config.machines[name] };
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Rank machines by current load. A machine is refused when it is down, absent
 * from beszel, missing the data a limit needs, or over a limit. Nothing is
 * guessed: an unmeasurable machine is refused with the reason, never assumed idle.
 *
 * Candidates are the machines named in config (not "*"); with none named, every
 * host beszel reports. `only` narrows to specific machines.
 */
export function evaluateMachines(
  hosts: HostLoad[],
  config: MachinesConfig,
  source: string,
  only?: string[],
): MachinesResult {
  const byName = new Map(hosts.map((h) => [h.name, h]));
  const configured = Object.keys(config.machines).filter((k) => k !== "*");
  let names = configured.length > 0 ? configured : hosts.map((h) => h.name);
  if (only && only.length > 0) names = only;

  const eligible: EligibleMachine[] = [];
  const refused: RefusedMachine[] = [];
  for (const name of names) {
    const limit = ruleFor(config, name);
    const host = byName.get(name);
    const verdict: MachineVerdict = { machine: name, limit };
    if (!host) {
      refused.push({
        ...verdict,
        reason: "not reported by beszel (unknown host)",
      });
      continue;
    }
    verdict.status = host.status;
    verdict.load1 = host.load1;
    verdict.cores = host.cores;
    if (
      host.load1 !== undefined &&
      host.cores !== undefined &&
      host.cores > 0
    ) {
      verdict.loadPerCore = round(host.load1 / host.cores);
    }
    if (host.status !== "up") {
      refused.push({ ...verdict, reason: `host is ${host.status}` });
      continue;
    }
    if (host.load1 === undefined) {
      refused.push({
        ...verdict,
        reason: "beszel reports no load for this host",
      });
      continue;
    }
    if (limit.maxLoad !== undefined && host.load1 > limit.maxLoad) {
      refused.push({
        ...verdict,
        reason: `load ${host.load1} exceeds maxLoad ${limit.maxLoad}`,
      });
      continue;
    }
    if (limit.maxLoadPerCore !== undefined) {
      if (verdict.loadPerCore === undefined) {
        refused.push({
          ...verdict,
          reason: "core count unknown, cannot check maxLoadPerCore",
        });
        continue;
      }
      if (host.load1 / (host.cores as number) > limit.maxLoadPerCore) {
        refused.push({
          ...verdict,
          reason: `load per core ${verdict.loadPerCore} exceeds maxLoadPerCore ${limit.maxLoadPerCore}`,
        });
        continue;
      }
    }
    eligible.push(verdict);
  }

  if (config.spread === "least-loaded") {
    // Machines without a per-core figure sort last; ties keep config order.
    const key = (m: EligibleMachine) =>
      m.loadPerCore ?? Number.POSITIVE_INFINITY;
    eligible.sort((a, b) => key(a) - key(b));
  }
  return { source, policy: config.spread, eligible, refused };
}
