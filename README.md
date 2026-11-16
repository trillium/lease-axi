# lease-axi

Neutral pool lease CLI: grant, renew, and release concurrency slots with heartbeat expiry.

`lease-axi` caps how many agents may run on one quota pool or shared resource at once (for example, at most one agent per Antigravity pool or Claude account), so a second spawn waits or defers instead of two agents draining one budget and failing together.

- **Atomic admission under lock:** Slots in named pools are evaluated and granted atomically.
- **Deferral contract (exit 75):** When a pool is at capacity, `grant` defers the caller with exit code 75 (`EX_TEMPFAIL`) and structured holder info.
- **Heartbeat & TTL expiry:** Leases expire automatically after a TTL. Active agents extend leases with periodic `renew` heartbeats; crashed or dead agents automatically free their slots.
- **Single authority:** Works locally with an atomic, lock-protected file store by default, or runs as a lightweight HTTP authority (`serve`) for tailnets and cross-machine agent pools.
- **Token-efficient output:** TOON format by default for minimal token overhead, plus full `--json` support.

---

## Verbs and Commands

| Verb                 | Purpose                                                         | Exit on Full / Error                                  |
| -------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| `grant`              | Acquire a slot in a named pool with `--cap` and `--ttl`         | Exit `75` if full; exit `0` on success                |
| `renew`              | Heartbeat to extend a lease's expiration deadline               | Exit `1` if expired / not found                       |
| `release`            | Free an acquired slot immediately                               | Exit `0` (idempotent)                                 |
| `status` (or `list`) | Inspect active pools, holders, and remaining lease TTLs         | Exit `0`                                              |
| `pools`              | Join quota-axi state, pool config and leases; flag idle pools   | Exit `0`                                              |
| `quota`              | Read the server's cached quota snapshot with its age            | Exit `0`; needs `--server`                            |
| `machines`           | Rank machines by beszel load; refuse over-limit machines        | Exit `75` if none eligible; `1` if beszel unreachable |
| `serve`              | Start HTTP authority service for network / tailnet coordination | Runs until stopped                                    |

---

## Quick Start

### 1. Grant a Lease Slot

Acquire a slot in pool `agy/default/gemini` with capacity 1 and a 60-second TTL:

```sh
lease-axi grant --pool agy/default/gemini --cap 1 --ttl 60s --holder agent-worker-1
```

Default TOON output:

```text
lease:
  id: lease_04e76a8dbb124119
  pool: agy/default/gemini
  holder: agent-worker-1
  cap: 1
  acquiredAt: "2026-11-03T12:00:00.000Z"
  expiresAt: "2026-11-03T12:01:00.000Z"
  ttl: 1m
```

### 2. Capacity Deferral (Exit Code 75)

If a second agent attempts to acquire the same pool before the first releases or expires:

```sh
lease-axi grant --pool agy/default/gemini --cap 1 --holder agent-worker-2
```

The command defers and exits with **code 75**:

```text
deferred:
  pool: agy/default/gemini
  cap: 1
  active: 1
  reason: pool capacity reached (1/1)
holders[1]{id,holder,expiresAt,remainingSeconds}:
  lease_04e76a8dbb124119,agent-worker-1,"2026-11-03T12:01:00.000Z",45
```

### 3. Waiting / Blocking on Contention

Callers can pass `--wait <duration>` to block/poll until a slot becomes available:

```sh
lease-axi grant --pool agy/default/gemini --cap 1 --wait 30s --holder agent-worker-2
```

If the first agent releases or expires within 30 seconds, the second agent acquires the lease and exits 0. If 30 seconds elapse while still full, it defers with exit 75.

### 4. Heartbeat Renewal

Extend the lease's TTL by another 60 seconds:

```sh
lease-axi renew lease_04e76a8dbb124119 --ttl 60s
```

TOON output:

```text
renewed:
  id: lease_04e76a8dbb124119
  pool: agy/default/gemini
  holder: agent-worker-1
  expiresAt: "2026-11-03T12:02:00.000Z"
  ttl: 1m
```

### 5. Release Slot

When the agent finishes:

```sh
lease-axi release lease_04e76a8dbb124119
```

TOON output:

```text
released:
  id: lease_04e76a8dbb124119
  pool: agy/default/gemini
  holder: agent-worker-1
```

### 6. Inspect Status

```sh
lease-axi status
```

TOON output:

```text
pools[1]{pool,active,cap}:
  agy/default/gemini,1,1
leases[1]{id,pool,holder,cap,acquiredAt,expiresAt,ttlSeconds,remainingSeconds}:
  lease_04e76a8dbb124119,agy/default/gemini,agent-worker-1,1,"2026-11-03T12:00:00.000Z","2026-11-03T12:01:00.000Z",60,42
```

### 7. Declare expected usage

`grant` accepts a declaration of what the holder is about to do. It is stored on the lease and shown to anyone deferred behind it:

```sh
lease-axi grant --pool agy/default/argon --holder worker-1 \
  --task "refactor parser" --expect-duration 20m --expect-size medium
```

`--expect-duration` is the expected total run time (the lease `--ttl` stays the heartbeat deadline). `--expect-size` is free text (`small`, `~40 files`).

---

## Quota-aware pools

`lease-axi` can name its pools after quota-axi's quota pools, `provider/account/scope` (for example `agy/default/argon`, `agy/default/claude_gpt`, `codex/default/all_models`). `quota-axi` is optional: it is only read by `pools`, and every other verb works without it.

### Pool config

Caps are enforced by the authority from a JSON config (`--config`, `LEASE_AXI_CONFIG`, else `$XDG_CONFIG_HOME/lease-axi/pools.json`). A configured cap overrides any `--cap` a caller passes. Built-in defaults cap `agy`, `codex` and `opencode-go` pools at 1.

```json
{
  "providers": { "agy": { "cap": 1 }, "codex": { "cap": 1 } },
  "pools": { "agy/default/argon": { "cap": 1, "requireTask": true } },
  "idle": { "nearExpiryMinutes": 60 }
}
```

An exact pool rule beats its provider rule. `requireTask` makes `grant` exit 2 unless `--task` is declared. In `serve` mode the server's config is the one that applies.

### The `pools` view

```sh
lease-axi pools
lease-axi pools --server http://authority:7117
```

Each pool shows remaining percent, whether its window has started, when it resets, its cap, and its current holders with their declared task. A config-managed pool with **no lease** is flagged `idle` when:

- `unstarted`: its session window (or its only window) is still at 100% remaining, so the clock has not started; or
- `near-expiry`: a window that still has unused quota resets within `idle.nearExpiryMinutes` (default 60), weekly windows included.

Exhausted pools are never flagged. Quota comes from `quota-axi --json` (override the binary with `LEASE_AXI_QUOTA_BIN`, or a saved document with `--quota-file` / `LEASE_AXI_QUOTA_FILE`). If quota-axi is missing or fails, `pools` still prints leases and configured pools and sets `quota.available: false` with the error. `lease-axi serve` answers `GET /pools` from its cached quota snapshot, so every machine sees one table.

### One quota source: `serve` caches, `quota` reads

`lease-axi serve` is the only thing that runs quota-axi. It probes on an interval (`--quota-interval`, `LEASE_AXI_QUOTA_INTERVAL`, default `5m`), keeps the latest snapshot per pool with its age, and serves it at `GET /quota[?pool=<name>]` alongside `/pools` and `/status`. Neither endpoint probes per request. If a probe fails the last good snapshot is kept and the error is reported.

```sh
lease-axi quota --server http://authority:7117          # TOON
lease-axi quota --server http://authority:7117 --json
lease-axi quota --pool agy/default/argon
```

`quota` has no local probe path: without `--server` (or `LEASE_AXI_SERVER`) it exits `2`. Output shows `fetchedAt`, `age`, and `stale`; a snapshot older than `--quota-stale-after` (default 3 intervals) is marked `stale` with a warning, and a server that has never read quota-axi successfully reports `available: false`.

---

## Machine load and spread

`lease-axi machines` reads current load from [beszel](https://beszel.dev) (`beszel hosts --json`, reached over the tailnet) and returns machines in the order work should go to them. It is read-only: it holds no lease, and `fm-spawn`/`fm-send` are not yet wired to call it.

Limits and policy live in the same config file as the pool rules (`--config`, `LEASE_AXI_CONFIG`, else `~/.config/lease-axi/pools.json`):

```json
{
  "machines": {
    "*": { "maxLoadPerCore": 1.5 },
    "mini0": { "maxLoadPerCore": 1.0 },
    "lnx-server": { "maxLoad": 6 }
  },
  "spread": "least-loaded"
}
```

- Keys under `machines` are beszel host names; `*` is the default rule for any host without its own. Limits compare against the host's 1-minute load: `maxLoad` is absolute, `maxLoadPerCore` is load divided by CPU cores. If both are set, both must hold. Built-in default: `"*": { "maxLoadPerCore": 1.5 }`.
- Candidates are the machines named in config (not `*`); with none named, every host beszel reports. `--machine a,b` narrows to those.
- `spread`: `least-loaded` (default) orders eligible machines by load per core, lowest first; `config-order` keeps the order of the `machines` keys.
- A machine is **refused**, with a reason, when it is down, missing from beszel, over a limit, or lacks the data (load, cores) a limit needs. Nothing is guessed.

```sh
lease-axi machines
lease-axi machines --machine mini0,mini1 --json
```

Exit `0` when at least one machine is eligible, `75` when none is (the same deferral code as `grant`). If beszel cannot be read (binary missing, hub or tailnet unreachable) the command exits `1` with `BESZEL_UNAVAILABLE` and the beszel message. Override the binary with `LEASE_AXI_BESZEL_BIN`, or read a saved `beszel hosts --json` document with `--beszel-file` / `LEASE_AXI_BESZEL_FILE`.

---

## Authority Modes

### Local Lock-Protected Store (Default)

By default, state lives in `$XDG_STATE_HOME/lease-axi/leases.json` (or `~/.local/state/lease-axi/leases.json`), overridden by `--store <path>` or `LEASE_AXI_STORE`.
All reads, writes, and admissions are serialized through an atomic lockfile (`leases.json.lock`) with stale-process detection.

### Remote HTTP Authority Mode (Tailnet / Cross-Host)

When multiple machines or fleet containers share quota pools:

1. **Start the authority server on one machine:**
   ```sh
   lease-axi serve --bind 0.0.0.0 --port 7117
   ```
2. **Workers on any host point to the authority:**
   ```sh
   lease-axi grant --server http://my-authority:7117 --pool agy/default/gemini --cap 1
   ```
   or configure the environment:
   ```sh
   export LEASE_AXI_SERVER="http://my-authority:7117"
   lease-axi grant --pool agy/default/gemini --cap 1
   ```

No authentication tokens are required when deployed across a private Tailscale tailnet.

---

## JSON Output

Pass `--json` to any command for structured JSON output:

```sh
lease-axi grant --pool test-pool --cap 1 --json
```

```json
{
  "granted": true,
  "lease": {
    "id": "lease_8f0a2d4889c1482b",
    "pool": "test-pool",
    "holder": "macbook:12345:a1b2c3d4",
    "cap": 1,
    "acquiredAt": "2026-11-03T12:00:00.000Z",
    "expiresAt": "2026-11-03T12:01:00.000Z",
    "ttlSeconds": 60
  }
}
```

When deferred:

```json
{
  "granted": false,
  "deferred": true,
  "pool": "test-pool",
  "cap": 1,
  "active": 1,
  "holders": [
    {
      "id": "lease_8f0a2d4889c1482b",
      "holder": "agent-1",
      "expiresAt": "2026-11-03T12:01:00.000Z",
      "remainingSeconds": 34
    }
  ],
  "reason": "pool capacity reached (1/1)"
}
```

---

## Flags Reference

| Flag                      | Commands                   | Description                                                      | Default                                |
| ------------------------- | -------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| `--pool <name>`           | `grant`, `status`, `quota` | Pool identifier (e.g. `agy/default/gemini`)                      | Required for `grant`                   |
| `--cap <n>`               | `grant`                    | Maximum concurrent slots allowed                                 | `1`                                    |
| `--ttl <dur>`             | `grant`, `renew`           | Lease time-to-live (`30s`, `2m`, `1h`)                           | `60s`                                  |
| `--holder <id>`           | `grant`                    | Explicit identifier for the lease holder                         | Auto-generated host+pid                |
| `--wait <dur>`            | `grant`                    | Max time to wait/poll for capacity                               | `0s` (immediate deferral)              |
| `--retry-interval <dur>`  | `grant`                    | Polling interval when `--wait` is active                         | `100ms`                                |
| `--task <text>`           | `grant`                    | Declare what the holder will run                                 | None                                   |
| `--expect-duration <d>`   | `grant`                    | Declare expected run time                                        | None                                   |
| `--expect-size <text>`    | `grant`                    | Declare expected size                                            | None                                   |
| `--config <path>`         | `grant`, `pools`, `serve`  | Pool config file (or `LEASE_AXI_CONFIG`)                         | `~/.config/lease-axi/pools.json`       |
| `--quota-file <path>`     | `pools`, `serve`           | Read quota-axi JSON from a file (or `LEASE_AXI_QUOTA_FILE`)      | Runs `quota-axi --json`                |
| `--server <url>`          | All                        | Remote HTTP authority URL (or `LEASE_AXI_SERVER`)                | None (local file store)                |
| `--store <path>`          | All                        | Path to local store file (or `LEASE_AXI_STORE`)                  | `~/.local/state/lease-axi/leases.json` |
| `--json`                  | All                        | Output structured JSON instead of TOON                           | `false`                                |
| `--quota-interval <d>`    | `serve`                    | Seconds-between quota-axi probes (or `LEASE_AXI_QUOTA_INTERVAL`) | `5m`                                   |
| `--quota-stale-after <d>` | `serve`                    | Snapshot age beyond which `quota` marks it stale                 | 3 intervals                            |
| `--bind <ip>`             | `serve`                    | HTTP bind address (or `LEASE_AXI_BIND`)                          | `127.0.0.1`                            |
| `--port <p>`              | `serve`                    | HTTP listen port (or `LEASE_AXI_PORT`)                           | `7117`                                 |

---

## Agent Integration Pattern

```sh
#!/usr/bin/env bash
POOL="agy/default/gemini"

# Acquire lease; defer task if capacity full (exit 75 propagates to orchestrator)
LEASE_JSON=$(lease-axi grant --pool "$POOL" --cap 1 --ttl 60s --json) || exit $?
LEASE_ID=$(echo "$LEASE_JSON" | jq -r '.lease.id')

# Ensure release on normal exit or interruption
trap 'lease-axi release "$LEASE_ID" >/dev/null 2>&1' EXIT INT TERM

# Start background heartbeat to renew lease every 20s
(
  while true; do
    sleep 20
    lease-axi renew "$LEASE_ID" --ttl 60s >/dev/null 2>&1 || exit 0
  done
) &
HEARTBEAT_PID=$!
trap 'kill "$HEARTBEAT_PID" 2>/dev/null; lease-axi release "$LEASE_ID" >/dev/null 2>&1' EXIT INT TERM

# Run agent workload safely under the lease
run_agent_task
```

---

## Development

```sh
pnpm install
pnpm run build
pnpm run lint
pnpm run format:check
pnpm test
```

## License

MIT
