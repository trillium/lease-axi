import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { PoolWindowState } from "./types.js";

/** A quota pool discovered from `quota-axi --json`, named provider/account/scope. */
export type QuotaPool = {
  pool: string;
  provider: string;
  account: string;
  scope: string;
  windows: PoolWindowState[];
};

export type QuotaSnapshot = {
  generatedAt?: string;
  pools: QuotaPool[];
};

export type QuotaSource = {
  describe: string;
  read(): Promise<QuotaSnapshot>;
};

type RawWindow = {
  id?: unknown;
  kind?: unknown;
  percentRemaining?: unknown;
  percentUsed?: unknown;
  resetsAt?: unknown;
};

type RawProvider = {
  provider?: unknown;
  accountKey?: unknown;
  windows?: unknown;
  quotaSemantics?: {
    effectiveAvailability?: Array<{ scope?: unknown; boundedBy?: unknown }>;
  };
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toWindow(raw: RawWindow): PoolWindowState | undefined {
  const id = str(raw.id);
  if (!id) return undefined;
  const percentRemaining = num(raw.percentRemaining);
  const percentUsed = num(raw.percentUsed);
  const started =
    (percentUsed !== undefined && percentUsed > 0) ||
    (percentRemaining !== undefined && percentRemaining < 100);
  return {
    id,
    kind: str(raw.kind),
    percentRemaining,
    resetsAt: str(raw.resetsAt),
    started,
  };
}

/** Scope a window belongs to when quota-axi gives no explicit grouping. */
export function scopeFromWindowId(id: string): string {
  if (id.startsWith("model:")) return id;
  const stripped = id.replace(/_(?:\d+h|daily|weekly|monthly)$/, "");
  return stripped === id ? "all" : stripped;
}

/** Turn a `quota-axi --json` document into named pools. Unusable providers yield none. */
export function parseQuotaDocument(doc: unknown): QuotaSnapshot {
  const root = (doc ?? {}) as {
    generatedAt?: unknown;
    providers?: unknown;
  };
  const providers = Array.isArray(root.providers)
    ? (root.providers as RawProvider[])
    : [];
  const pools: QuotaPool[] = [];
  const seen = new Set<string>();

  for (const p of providers) {
    const provider = str(p.provider);
    if (!provider || !Array.isArray(p.windows) || p.windows.length === 0) {
      continue;
    }
    const account = str(p.accountKey) ?? "default";
    const windows = (p.windows as RawWindow[])
      .map(toWindow)
      .filter((w): w is PoolWindowState => w !== undefined);
    const byId = new Map(windows.map((w) => [w.id, w]));

    const groups = new Map<string, PoolWindowState[]>();
    const semantic = p.quotaSemantics?.effectiveAvailability;
    if (Array.isArray(semantic)) {
      for (const entry of semantic) {
        const scope = str(entry.scope);
        if (!scope || !Array.isArray(entry.boundedBy)) continue;
        const members = (entry.boundedBy as unknown[])
          .map((id) => (typeof id === "string" ? byId.get(id) : undefined))
          .filter((w): w is PoolWindowState => w !== undefined);
        if (members.length > 0) groups.set(scope, members);
      }
    }
    if (groups.size === 0) {
      for (const w of windows) {
        const scope = scopeFromWindowId(w.id);
        groups.set(scope, [...(groups.get(scope) ?? []), w]);
      }
    }

    for (const [scope, members] of groups) {
      const pool = `${provider}/${account}/${scope}`;
      if (seen.has(pool)) continue;
      seen.add(pool);
      pools.push({ pool, provider, account, scope, windows: members });
    }
  }

  return { generatedAt: str(root.generatedAt), pools };
}

export function fileQuotaSource(path: string): QuotaSource {
  return {
    describe: `file:${path}`,
    async read() {
      return parseQuotaDocument(JSON.parse(readFileSync(path, "utf8")));
    },
  };
}

export function commandQuotaSource(
  bin: string,
  timeoutMs = 30_000,
): QuotaSource {
  return {
    describe: `cmd:${bin}`,
    read() {
      return new Promise<QuotaSnapshot>((resolve, reject) => {
        execFile(
          bin,
          ["--json"],
          { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => {
            if (err) {
              reject(
                new Error(
                  (err as NodeJS.ErrnoException).code === "ENOENT"
                    ? `${bin} not found on PATH`
                    : `${bin} failed: ${err.message}`,
                ),
              );
              return;
            }
            try {
              resolve(parseQuotaDocument(JSON.parse(stdout)));
            } catch (parseErr) {
              reject(
                new Error(
                  `${bin} did not print valid JSON: ${(parseErr as Error).message}`,
                ),
              );
            }
          },
        );
      });
    },
  };
}

/** `--quota-file` beats LEASE_AXI_QUOTA_FILE beats LEASE_AXI_QUOTA_BIN beats `quota-axi`. */
export function resolveQuotaSource(file?: string): QuotaSource {
  const f = file ?? process.env.LEASE_AXI_QUOTA_FILE;
  if (f) return fileQuotaSource(f);
  return commandQuotaSource(process.env.LEASE_AXI_QUOTA_BIN ?? "quota-axi");
}
