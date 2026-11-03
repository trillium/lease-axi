import {
  type GrantRequest,
  type GrantResult,
  type ILeaseStore,
  type ReleaseRequest,
  type ReleaseResult,
  type RenewRequest,
  type RenewResult,
  type StatusResult,
} from "./types.js";

export class HttpLeaseClient implements ILeaseStore {
  readonly baseUrl: string;

  constructor(serverUrl: string) {
    let url = serverUrl.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = `http://${url}`;
    }
    this.baseUrl = url.replace(/\/+$/, "");
  }

  async grant(req: GrantRequest): Promise<GrantResult> {
    const res = await fetch(`${this.baseUrl}/grant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });

    if (res.status === 200) {
      return (await res.json()) as GrantResult;
    }
    if (res.status === 429) {
      return (await res.json()) as GrantResult;
    }

    const errorBody = await res.text();
    let msg = `HTTP ${res.status}: ${res.statusText}`;
    try {
      const parsed = JSON.parse(errorBody);
      if (parsed.message) msg = parsed.message;
    } catch {
      if (errorBody) msg = errorBody;
    }
    throw new Error(`Failed to grant lease from server: ${msg}`);
  }

  async renew(req: RenewRequest): Promise<RenewResult> {
    const res = await fetch(`${this.baseUrl}/renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });

    if (res.status === 200) {
      return (await res.json()) as RenewResult;
    }

    const errorBody = await res.text();
    let msg = `HTTP ${res.status}: ${res.statusText}`;
    try {
      const parsed = JSON.parse(errorBody);
      if (parsed.message) msg = parsed.message;
    } catch {
      if (errorBody) msg = errorBody;
    }
    throw new Error(`Failed to renew lease from server: ${msg}`);
  }

  async release(req: ReleaseRequest): Promise<ReleaseResult> {
    const res = await fetch(`${this.baseUrl}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });

    if (res.status === 200) {
      return (await res.json()) as ReleaseResult;
    }

    const errorBody = await res.text();
    let msg = `HTTP ${res.status}: ${res.statusText}`;
    try {
      const parsed = JSON.parse(errorBody);
      if (parsed.message) msg = parsed.message;
    } catch {
      if (errorBody) msg = errorBody;
    }
    throw new Error(`Failed to release lease from server: ${msg}`);
  }

  async status(pool?: string): Promise<StatusResult> {
    const target = pool
      ? `${this.baseUrl}/status?pool=${encodeURIComponent(pool)}`
      : `${this.baseUrl}/status`;
    const res = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (res.status === 200) {
      return (await res.json()) as StatusResult;
    }

    const errorBody = await res.text();
    let msg = `HTTP ${res.status}: ${res.statusText}`;
    try {
      const parsed = JSON.parse(errorBody);
      if (parsed.message) msg = parsed.message;
    } catch {
      if (errorBody) msg = errorBody;
    }
    throw new Error(`Failed to fetch status from server: ${msg}`);
  }
}
