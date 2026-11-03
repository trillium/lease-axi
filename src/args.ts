import { AxiError } from "axi-sdk-js";

export type CommonFlags = {
  server?: string;
  store?: string;
  json: boolean;
};

export type GrantFlags = CommonFlags & {
  pool: string;
  cap: number;
  ttl: string;
  holder?: string;
  wait?: string;
  retryInterval?: string;
};

export type RenewFlags = CommonFlags & {
  id: string;
  ttl?: string;
};

export type ReleaseFlags = CommonFlags & {
  id: string;
};

export type StatusFlags = CommonFlags & {
  pool?: string;
};

export type ServeFlags = CommonFlags & {
  bind: string;
  port: number;
};

export function parseGrantFlags(args: string[]): GrantFlags {
  let pool = "";
  let cap = 1;
  let ttl = "60s";
  let holder: string | undefined;
  let wait: string | undefined;
  let retryInterval: string | undefined;
  let server: string | undefined = process.env.LEASE_AXI_SERVER;
  let store: string | undefined = process.env.LEASE_AXI_STORE;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pool") {
      pool = args[++i] ?? "";
    } else if (arg.startsWith("--pool=")) {
      pool = arg.slice(7);
    } else if (arg === "--cap") {
      const val = Number(args[++i]);
      if (!Number.isInteger(val) || val < 1) {
        throw new AxiError(
          `Invalid --cap: "${args[i]}". Must be a positive integer`,
          "VALIDATION_ERROR",
        );
      }
      cap = val;
    } else if (arg.startsWith("--cap=")) {
      const val = Number(arg.slice(6));
      if (!Number.isInteger(val) || val < 1) {
        throw new AxiError(
          `Invalid --cap: "${arg.slice(6)}". Must be a positive integer`,
          "VALIDATION_ERROR",
        );
      }
      cap = val;
    } else if (arg === "--ttl") {
      ttl = args[++i] ?? "";
    } else if (arg.startsWith("--ttl=")) {
      ttl = arg.slice(6);
    } else if (arg === "--holder") {
      holder = args[++i];
    } else if (arg.startsWith("--holder=")) {
      holder = arg.slice(9);
    } else if (arg === "--wait") {
      wait = args[++i];
    } else if (arg.startsWith("--wait=")) {
      wait = arg.slice(7);
    } else if (arg === "--retry-interval") {
      retryInterval = args[++i];
    } else if (arg.startsWith("--retry-interval=")) {
      retryInterval = arg.slice(17);
    } else if (arg === "--server") {
      server = args[++i];
    } else if (arg.startsWith("--server=")) {
      server = arg.slice(9);
    } else if (arg === "--store") {
      store = args[++i];
    } else if (arg.startsWith("--store=")) {
      store = arg.slice(8);
    } else if (arg === "--json") {
      json = true;
    } else if (!arg.startsWith("-") && !pool) {
      pool = arg;
    } else {
      throw new AxiError(
        `Unknown flag or argument: ${arg}`,
        "VALIDATION_ERROR",
        ["Run `lease-axi grant --help` for usage details"],
      );
    }
  }

  if (!pool.trim()) {
    throw new AxiError(
      "Missing required flag --pool <name>",
      "VALIDATION_ERROR",
      ["Specify a pool name, e.g. `lease-axi grant --pool agy/default/gemini`"],
    );
  }

  return {
    pool: pool.trim(),
    cap,
    ttl,
    holder,
    wait,
    retryInterval,
    server,
    store,
    json,
  };
}

export function parseRenewFlags(args: string[]): RenewFlags {
  let id = "";
  let ttl: string | undefined;
  let server: string | undefined = process.env.LEASE_AXI_SERVER;
  let store: string | undefined = process.env.LEASE_AXI_STORE;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--id") {
      id = args[++i] ?? "";
    } else if (arg.startsWith("--id=")) {
      id = arg.slice(5);
    } else if (arg === "--ttl") {
      ttl = args[++i];
    } else if (arg.startsWith("--ttl=")) {
      ttl = arg.slice(6);
    } else if (arg === "--server") {
      server = args[++i];
    } else if (arg.startsWith("--server=")) {
      server = arg.slice(9);
    } else if (arg === "--store") {
      store = args[++i];
    } else if (arg.startsWith("--store=")) {
      store = arg.slice(8);
    } else if (arg === "--json") {
      json = true;
    } else if (!arg.startsWith("-") && !id) {
      id = arg;
    } else {
      throw new AxiError(
        `Unknown flag or argument: ${arg}`,
        "VALIDATION_ERROR",
        ["Run `lease-axi renew --help` for usage details"],
      );
    }
  }

  if (!id.trim()) {
    throw new AxiError("Missing required lease id", "VALIDATION_ERROR", [
      "Specify a lease id, e.g. `lease-axi renew <id>` or `lease-axi renew --id <id>`",
    ]);
  }

  return {
    id: id.trim(),
    ttl,
    server,
    store,
    json,
  };
}

export function parseReleaseFlags(args: string[]): ReleaseFlags {
  let id = "";
  let server: string | undefined = process.env.LEASE_AXI_SERVER;
  let store: string | undefined = process.env.LEASE_AXI_STORE;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--id") {
      id = args[++i] ?? "";
    } else if (arg.startsWith("--id=")) {
      id = arg.slice(5);
    } else if (arg === "--server") {
      server = args[++i];
    } else if (arg.startsWith("--server=")) {
      server = arg.slice(9);
    } else if (arg === "--store") {
      store = args[++i];
    } else if (arg.startsWith("--store=")) {
      store = arg.slice(8);
    } else if (arg === "--json") {
      json = true;
    } else if (!arg.startsWith("-") && !id) {
      id = arg;
    } else {
      throw new AxiError(
        `Unknown flag or argument: ${arg}`,
        "VALIDATION_ERROR",
        ["Run `lease-axi release --help` for usage details"],
      );
    }
  }

  if (!id.trim()) {
    throw new AxiError("Missing required lease id", "VALIDATION_ERROR", [
      "Specify a lease id, e.g. `lease-axi release <id>` or `lease-axi release --id <id>`",
    ]);
  }

  return {
    id: id.trim(),
    server,
    store,
    json,
  };
}

export function parseStatusFlags(args: string[]): StatusFlags {
  let pool: string | undefined;
  let server: string | undefined = process.env.LEASE_AXI_SERVER;
  let store: string | undefined = process.env.LEASE_AXI_STORE;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pool") {
      pool = args[++i];
    } else if (arg.startsWith("--pool=")) {
      pool = arg.slice(7);
    } else if (arg === "--server") {
      server = args[++i];
    } else if (arg.startsWith("--server=")) {
      server = arg.slice(9);
    } else if (arg === "--store") {
      store = args[++i];
    } else if (arg.startsWith("--store=")) {
      store = arg.slice(8);
    } else if (arg === "--json") {
      json = true;
    } else if (!arg.startsWith("-") && !pool) {
      pool = arg;
    } else {
      throw new AxiError(
        `Unknown flag or argument: ${arg}`,
        "VALIDATION_ERROR",
        ["Run `lease-axi status --help` for usage details"],
      );
    }
  }

  return {
    pool: pool?.trim(),
    server,
    store,
    json,
  };
}

export function parseServeFlags(args: string[]): ServeFlags {
  let bind = process.env.LEASE_AXI_BIND ?? "127.0.0.1";
  let port = process.env.LEASE_AXI_PORT
    ? Number(process.env.LEASE_AXI_PORT)
    : 7117;
  let store: string | undefined = process.env.LEASE_AXI_STORE;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--bind") {
      bind = args[++i] ?? bind;
    } else if (arg.startsWith("--bind=")) {
      bind = arg.slice(7);
    } else if (arg === "--port") {
      const p = Number(args[++i]);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        throw new AxiError(
          `Invalid --port: "${args[i]}". Must be an integer 1-65535`,
          "VALIDATION_ERROR",
        );
      }
      port = p;
    } else if (arg.startsWith("--port=")) {
      const p = Number(arg.slice(7));
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        throw new AxiError(
          `Invalid --port: "${arg.slice(7)}". Must be an integer 1-65535`,
          "VALIDATION_ERROR",
        );
      }
      port = p;
    } else if (arg === "--store") {
      store = args[++i];
    } else if (arg.startsWith("--store=")) {
      store = arg.slice(8);
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new AxiError(
        `Unknown flag or argument: ${arg}`,
        "VALIDATION_ERROR",
        ["Run `lease-axi serve --help` for usage details"],
      );
    }
  }

  return {
    bind,
    port,
    store,
    json,
  };
}
