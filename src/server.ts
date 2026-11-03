import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { FileLeaseStore } from "./store.js";
import {
  type GrantRequest,
  type ILeaseStore,
  type ReleaseRequest,
  type RenewRequest,
} from "./types.js";
import { VERSION } from "./version.js";

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_SIZE = 1024 * 1024; // 1MB

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_SIZE) {
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks as unknown as Uint8Array[]).toString(
          "utf8",
        );
        if (!raw.trim()) {
          resolve({} as T);
          return;
        }
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(new Error(`Malformed JSON body: ${(err as Error).message}`));
      }
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

export function createLeaseServer(store: ILeaseStore): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const pathname = url.pathname;
      const method = req.method?.toUpperCase();

      if (method === "GET" && pathname === "/health") {
        sendJson(res, 200, {
          status: "ok",
          uptime: process.uptime(),
          version: VERSION,
        });
        return;
      }

      if (
        method === "GET" &&
        (pathname === "/status" || pathname === "/list")
      ) {
        const pool = url.searchParams.get("pool") ?? undefined;
        const result = await store.status(pool);
        sendJson(res, 200, result);
        return;
      }

      if (method === "POST" && pathname === "/grant") {
        const body = await readJsonBody<GrantRequest>(req);
        if (!body.pool || typeof body.pool !== "string") {
          sendJson(res, 400, {
            error: "VALIDATION_ERROR",
            message: "Missing or invalid required field 'pool'",
          });
          return;
        }
        const result = await store.grant(body);
        if (result.granted) {
          sendJson(res, 200, result);
        } else {
          // HTTP 429 Too Many Requests corresponds to pool capacity deferral
          sendJson(res, 429, result);
        }
        return;
      }

      if (method === "POST" && pathname === "/renew") {
        const body = await readJsonBody<RenewRequest>(req);
        if (!body.id || typeof body.id !== "string") {
          sendJson(res, 400, {
            error: "VALIDATION_ERROR",
            message: "Missing or invalid required field 'id'",
          });
          return;
        }
        try {
          const result = await store.renew(body);
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 404, {
            error: "LEASE_NOT_FOUND",
            message: (err as Error).message,
          });
        }
        return;
      }

      if (method === "POST" && pathname === "/release") {
        const body = await readJsonBody<ReleaseRequest>(req);
        if (!body.id || typeof body.id !== "string") {
          sendJson(res, 400, {
            error: "VALIDATION_ERROR",
            message: "Missing or invalid required field 'id'",
          });
          return;
        }
        const result = await store.release(body);
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, {
        error: "NOT_FOUND",
        message: `Unknown endpoint ${method} ${pathname}`,
      });
    } catch (err) {
      sendJson(res, 500, {
        error: "INTERNAL_ERROR",
        message: (err as Error).message,
      });
    }
  });
}

export type ServerOptions = {
  bind?: string;
  port?: number;
  store?: ILeaseStore;
  storePath?: string;
};

export type RunningServer = {
  server: Server;
  url: string;
  bind: string;
  port: number;
  close: () => Promise<void>;
};

export async function startServer(
  options: ServerOptions = {},
): Promise<RunningServer> {
  const bind = options.bind ?? process.env.LEASE_AXI_BIND ?? "127.0.0.1";
  const port =
    options.port ??
    (process.env.LEASE_AXI_PORT ? Number(process.env.LEASE_AXI_PORT) : 7117);
  const store = options.store ?? new FileLeaseStore(options.storePath);

  const server = createLeaseServer(store);

  return new Promise<RunningServer>((resolve, reject) => {
    server.on("error", (err) => {
      reject(err);
    });

    server.listen(port, bind, () => {
      const addr = server.address() as AddressInfo;
      const actualPort = addr.port;
      const actualHost =
        addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
      const url = `http://${actualHost}:${actualPort}`;

      resolve({
        server,
        url,
        bind,
        port: actualPort,
        close: async () => {
          return new Promise<void>((resClose, rejClose) => {
            server.close((err) => {
              if (err) rejClose(err);
              else resClose();
            });
          });
        },
      });
    });
  });
}
