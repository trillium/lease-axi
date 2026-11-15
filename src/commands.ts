import { AxiError } from "axi-sdk-js";
import {
  type CommonFlags,
  parseGrantFlags,
  parsePoolsFlags,
  parseQuotaFlags,
  parseReleaseFlags,
  parseRenewFlags,
  parseServeFlags,
  parseStatusFlags,
} from "./args.js";
import { HttpLeaseClient } from "./client.js";
import { loadPoolConfig } from "./config.js";
import { buildPoolsView } from "./pools.js";
import { resolveQuotaSource } from "./quota.js";
import {
  renderGrant,
  renderPools,
  renderQuota,
  renderRelease,
  renderRenew,
  renderStatus,
} from "./render.js";
import { startServer } from "./server.js";
import { FileLeaseStore, getDefaultStorePath } from "./store.js";
import { type GrantDeferred, type ILeaseStore } from "./types.js";

export class DeferralError extends Error {
  readonly result: GrantDeferred;
  readonly json: boolean;

  constructor(result: GrantDeferred, json: boolean) {
    super(result.reason);
    this.name = "DeferralError";
    this.result = result;
    this.json = json;
  }
}

export type LeaseContext = {
  binPath: string;
};

export function resolveStore(flags: CommonFlags): ILeaseStore {
  if (flags.server) {
    return new HttpLeaseClient(flags.server);
  }
  return new FileLeaseStore(flags.store, loadPoolConfig(flags.config));
}

export async function grantCommand(args: string[]): Promise<string> {
  const flags = parseGrantFlags(args);
  const store = resolveStore(flags);
  const result = await store.grant({
    pool: flags.pool,
    cap: flags.cap,
    ttl: flags.ttl,
    holder: flags.holder,
    wait: flags.wait,
    retryInterval: flags.retryInterval,
    task: flags.task,
    expectDuration: flags.expectDuration,
    expectSize: flags.expectSize,
  });

  if (result.granted) {
    return renderGrant(result, flags.json);
  }

  process.exitCode = 75;
  throw new DeferralError(result, flags.json);
}

export async function renewCommand(args: string[]): Promise<string> {
  const flags = parseRenewFlags(args);
  const store = resolveStore(flags);
  try {
    const result = await store.renew({
      id: flags.id,
      ttl: flags.ttl,
    });
    return renderRenew(result, flags.json);
  } catch (err) {
    throw new AxiError((err as Error).message, "LEASE_NOT_FOUND");
  }
}

export async function releaseCommand(args: string[]): Promise<string> {
  const flags = parseReleaseFlags(args);
  const store = resolveStore(flags);
  const result = await store.release({
    id: flags.id,
  });
  return renderRelease(result, flags.json);
}

export async function statusCommand(args: string[]): Promise<string> {
  const flags = parseStatusFlags(args);
  const store = resolveStore(flags);
  const result = await store.status(flags.pool);
  return renderStatus(result, flags.json);
}

export async function poolsCommand(args: string[]): Promise<string> {
  const flags = parsePoolsFlags(args);
  const store = resolveStore(flags);
  if (store instanceof HttpLeaseClient) {
    return renderPools(await store.pools(), flags.json);
  }
  const status = await store.status();
  const result = await buildPoolsView(
    status,
    resolveQuotaSource(flags.quotaFile),
    loadPoolConfig(flags.config),
  );
  return renderPools(result, flags.json);
}

/** Read the authority's cached snapshot. Deliberately has no local probe path. */
export async function quotaCommand(args: string[]): Promise<string> {
  const flags = parseQuotaFlags(args);
  if (!flags.server) {
    throw new AxiError(
      "quota reads the cached snapshot of a lease-axi server and needs --server <url>",
      "VALIDATION_ERROR",
      [
        "Pass --server http://authority:7117 or set LEASE_AXI_SERVER",
        "To see local quota-axi state use `lease-axi pools`",
      ],
    );
  }
  return renderQuota(
    await new HttpLeaseClient(flags.server).quota(flags.pool),
    flags.json,
  );
}

export async function serveCommand(args: string[]): Promise<string> {
  const flags = parseServeFlags(args);
  const storePath = flags.store ?? getDefaultStorePath();
  const config = loadPoolConfig(flags.config);
  const server = await startServer({
    bind: flags.bind,
    port: flags.port,
    storePath,
    config,
    quota: resolveQuotaSource(flags.quotaFile),
    quotaIntervalSeconds: flags.quotaIntervalSeconds,
    quotaStaleAfterSeconds: flags.quotaStaleAfterSeconds,
  });

  const info = {
    url: server.url,
    bind: server.bind,
    port: server.port,
    store: storePath,
  };

  const output = flags.json
    ? JSON.stringify({ server: info }, null, 2)
    : `server:\n  url: ${info.url}\n  bind: ${info.bind}\n  port: ${info.port}\n  store: ${info.store}`;

  process.stdout.write(`${output}\n`);

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      await server.close();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

  return "";
}
