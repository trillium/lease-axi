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

| Verb                 | Purpose                                                         | Exit on Full / Error                   |
| -------------------- | --------------------------------------------------------------- | -------------------------------------- |
| `grant`              | Acquire a slot in a named pool with `--cap` and `--ttl`         | Exit `75` if full; exit `0` on success |
| `renew`              | Heartbeat to extend a lease's expiration deadline               | Exit `1` if expired / not found        |
| `release`            | Free an acquired slot immediately                               | Exit `0` (idempotent)                  |
| `status` (or `list`) | Inspect active pools, holders, and remaining lease TTLs         | Exit `0`                               |
| `serve`              | Start HTTP authority service for network / tailnet coordination | Runs until stopped                     |

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

| Flag                     | Commands          | Description                                       | Default                                |
| ------------------------ | ----------------- | ------------------------------------------------- | -------------------------------------- |
| `--pool <name>`          | `grant`, `status` | Pool identifier (e.g. `agy/default/gemini`)       | Required for `grant`                   |
| `--cap <n>`              | `grant`           | Maximum concurrent slots allowed                  | `1`                                    |
| `--ttl <dur>`            | `grant`, `renew`  | Lease time-to-live (`30s`, `2m`, `1h`)            | `60s`                                  |
| `--holder <id>`          | `grant`           | Explicit identifier for the lease holder          | Auto-generated host+pid                |
| `--wait <dur>`           | `grant`           | Max time to wait/poll for capacity                | `0s` (immediate deferral)              |
| `--retry-interval <dur>` | `grant`           | Polling interval when `--wait` is active          | `100ms`                                |
| `--server <url>`         | All               | Remote HTTP authority URL (or `LEASE_AXI_SERVER`) | None (local file store)                |
| `--store <path>`         | All               | Path to local store file (or `LEASE_AXI_STORE`)   | `~/.local/state/lease-axi/leases.json` |
| `--json`                 | All               | Output structured JSON instead of TOON            | `false`                                |
| `--bind <ip>`            | `serve`           | HTTP bind address (or `LEASE_AXI_BIND`)           | `127.0.0.1`                            |
| `--port <p>`             | `serve`           | HTTP listen port (or `LEASE_AXI_PORT`)            | `7117`                                 |

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
