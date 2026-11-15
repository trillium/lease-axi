import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";

export type PoolRule = {
  /** Maximum concurrent leases. Overrides any cap a caller requests. */
  cap?: number;
  /** Refuse grants that do not declare --task. */
  requireTask?: boolean;
};

export type IdleRule = {
  /** A window resetting within this many minutes with no lease is idle. */
  nearExpiryMinutes: number;
};

export type PoolConfig = {
  /** Rules keyed by provider (first segment of the pool name). */
  providers: Record<string, PoolRule>;
  /** Rules keyed by the full pool name; they win over provider rules. */
  pools: Record<string, PoolRule>;
  idle: IdleRule;
};

export const BUILTIN_CONFIG: PoolConfig = {
  providers: { agy: { cap: 1 }, codex: { cap: 1 }, "opencode-go": { cap: 1 } },
  pools: {},
  idle: { nearExpiryMinutes: 60 },
};

export function getDefaultConfigPath(): string {
  if (process.env.LEASE_AXI_CONFIG) return process.env.LEASE_AXI_CONFIG;
  const base = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "lease-axi")
    : join(homedir(), ".config", "lease-axi");
  return join(base, "pools.json");
}

function validateRule(where: string, rule: unknown): PoolRule {
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
    throw new AxiError(`Config ${where} must be an object`, "VALIDATION_ERROR");
  }
  const raw = rule as Record<string, unknown>;
  const out: PoolRule = {};
  if (raw.cap !== undefined) {
    if (
      typeof raw.cap !== "number" ||
      !Number.isInteger(raw.cap) ||
      raw.cap < 1
    ) {
      throw new AxiError(
        `Config ${where}.cap must be a positive integer`,
        "VALIDATION_ERROR",
      );
    }
    out.cap = raw.cap;
  }
  if (raw.requireTask !== undefined) {
    if (typeof raw.requireTask !== "boolean") {
      throw new AxiError(
        `Config ${where}.requireTask must be a boolean`,
        "VALIDATION_ERROR",
      );
    }
    out.requireTask = raw.requireTask;
  }
  return out;
}

function validateRules(
  where: string,
  rules: unknown,
): Record<string, PoolRule> {
  if (rules === undefined) return {};
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
    throw new AxiError(`Config ${where} must be an object`, "VALIDATION_ERROR");
  }
  const out: Record<string, PoolRule> = {};
  for (const [key, rule] of Object.entries(rules)) {
    out[key] = validateRule(`${where}.${key}`, rule);
  }
  return out;
}

/** Merge a parsed config document over the built-in defaults. */
export function parsePoolConfig(doc: unknown): PoolConfig {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new AxiError("Pool config must be a JSON object", "VALIDATION_ERROR");
  }
  const raw = doc as Record<string, unknown>;
  const providers = {
    ...BUILTIN_CONFIG.providers,
    ...validateRules("providers", raw.providers),
  };
  const pools = validateRules("pools", raw.pools);
  let nearExpiryMinutes = BUILTIN_CONFIG.idle.nearExpiryMinutes;
  if (raw.idle !== undefined) {
    const idle = raw.idle as Record<string, unknown>;
    const v = idle?.nearExpiryMinutes;
    if (v !== undefined) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new AxiError(
          "Config idle.nearExpiryMinutes must be a non-negative number",
          "VALIDATION_ERROR",
        );
      }
      nearExpiryMinutes = v;
    }
  }
  return { providers, pools, idle: { nearExpiryMinutes } };
}

/**
 * Load the pool config. A missing file at the default location means built-in
 * defaults; a missing file that was named explicitly is an error.
 */
export function loadPoolConfig(path?: string): PoolConfig {
  const explicit = path ?? process.env.LEASE_AXI_CONFIG;
  const target = explicit ?? getDefaultConfigPath();
  if (!existsSync(target)) {
    if (explicit) {
      throw new AxiError(
        `Pool config not found: ${target}`,
        "VALIDATION_ERROR",
      );
    }
    return BUILTIN_CONFIG;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(target, "utf8"));
  } catch (err) {
    throw new AxiError(
      `Pool config ${target} is not valid JSON: ${(err as Error).message}`,
      "VALIDATION_ERROR",
    );
  }
  return parsePoolConfig(doc);
}

export function providerOf(pool: string): string {
  return pool.split("/")[0] ?? pool;
}

/** The rule that governs a pool: exact pool beats provider. */
export function resolvePoolRule(config: PoolConfig, pool: string): PoolRule {
  return {
    ...config.providers[providerOf(pool)],
    ...config.pools[pool],
  };
}
