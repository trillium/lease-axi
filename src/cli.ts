import { encode } from "@toon-format/toon";
import { AxiError, exitCodeForError, runAxiCli } from "axi-sdk-js";
import {
  DeferralError,
  grantCommand,
  type LeaseContext,
  releaseCommand,
  renewCommand,
  serveCommand,
  statusCommand,
} from "./commands.js";
import { renderGrant } from "./render.js";
import { DEFERRAL_EXIT_CODE } from "./types.js";
import { VERSION } from "./version.js";

function renderError(
  message: string,
  code: string,
  suggestions: string[] = [],
): string {
  const record: Record<string, unknown> = {
    error: {
      code,
      message,
    },
  };
  if (suggestions.length > 0) {
    record.suggestions = suggestions;
  }
  return encode(record);
}

export const DESCRIPTION =
  "Agent ergonomic pool lease CLI: grant, renew and release concurrency slots with heartbeat expiry";

export const TOP_HELP = `usage: lease-axi <command> [flags]
commands[5]:
  grant, renew, release, status (list), serve
output:
  Default TOON reports compact agent-ergonomic state. Pass --json for structured JSON output.
  When a pool is at capacity, grant defers the caller and exits with status 75 (EX_TEMPFAIL).
verbs:
  grant: Acquire a slot in a pool with a cap and TTL, print the lease or defer with exit 75
  renew: Heartbeat extends lease TTL
  release: Free an acquired lease slot immediately
  status: Inspect active pools, holder leases, and remaining TTLs (alias: list)
  serve: Run lightweight HTTP authority server for tailnet / cross-machine lease coordination
flags[9]:
  --pool <name>, --cap <n>, --ttl <duration>, --holder <id>, --wait <duration>, --retry-interval <duration>, --server <url>, --store <path>, --json
examples:
  lease-axi grant --pool agy/default/gemini --cap 1 --ttl 60s
  lease-axi grant --pool agy/default/gemini --cap 1 --wait 30s
  lease-axi renew lease_01h7abc123 --ttl 60s
  lease-axi release lease_01h7abc123
  lease-axi status
  lease-axi status --pool agy/default/gemini
  lease-axi serve --bind 0.0.0.0 --port 7117
  lease-axi status --server http://authority:7117
`;

export function normalizeArgv(raw: string[]): string[] {
  if (raw[0] === "--") raw = raw.slice(1);
  if (raw.length === 0) return ["status"];
  if (raw[0] === "--help" || raw[0] === "-h") return ["--help"];
  if (raw[0] === "--version" || raw[0] === "-v") return ["--version"];
  if (raw[0] === "list") return ["status", ...raw.slice(1)];
  return raw;
}

export type MainOptions = {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
  binPath?: string;
};

export async function main(options: MainOptions = {}): Promise<void> {
  const binPath = options.binPath ?? process.argv[1] ?? "lease-axi";
  const argv = normalizeArgv(options.argv ?? process.argv.slice(2));

  await runAxiCli<LeaseContext>({
    argv,
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    commands: {
      grant: grantCommand,
      renew: renewCommand,
      release: releaseCommand,
      status: statusCommand,
      list: statusCommand,
      serve: serveCommand,
    },
    home: statusCommand,
    resolveContext: () => ({ binPath }),
    getCommandHelp: (_command) => TOP_HELP,
    formatError: (error: unknown) => {
      if (error instanceof DeferralError) {
        return {
          output: `${renderGrant(error.result, error.json)}\n`,
          exitCode: DEFERRAL_EXIT_CODE,
        };
      }
      if (error instanceof AxiError) {
        return {
          output: `${renderError(error.message, error.code, error.suggestions)}\n`,
          exitCode: exitCodeForError(error),
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        output: `${renderError(message, "UNKNOWN")}\n`,
        exitCode: 1,
      };
    },
  });
}
