# Vision

`lease-axi` exists so that multiple agent workers never overcommit a shared quota pool and fail together.
It serves coding agents and agent supervisors first, and it provides atomic admission control, heartbeat renewal, and automatic TTL expiry across local processes and network hosts.
It owns exactly one thing: the safe, neutral lease of concurrency slots in named pools.

## Admission is atomic under lock

When multiple workers request admission to a pool simultaneously, admission is evaluated under a mutual-exclusion lock.
Only workers that fit within the pool's declared capacity are granted a lease slot.
There are no half-grants, races, or double-allocations: exactly $N$ slots are granted for capacity $N$.

## Deferral over failure

A pool that is full does not fail the caller with an ambiguous error; it defers the caller with exit code 75 (`EX_TEMPFAIL`).
Deferral carries structured evidence of the current holders and their remaining lease TTLs.
This clean contract allows agent dispatchers and supervisors to keep tasks queued and retry when capacity clears rather than treating concurrency contention as an execution failure.

## Dead holders free their slots

Leases are held with a time-to-live (TTL) and extended by periodic heartbeat (`renew`).
When an agent completes, it releases its lease immediately (`release`).
When an agent crashes, wedges, or is terminated without cleanup, its lease automatically expires when its TTL lapses.
Expired leases are reclaimed at admission time and during status checks, ensuring dead workers never permanently block a pool.

## Single authority across machines

A pool shared across homes or machines on a network (such as a Tailscale tailnet) requires a single source of truth.
`lease-axi` operates locally via lock-protected state files by default, and provides a lightweight HTTP serve mode (`lease-axi serve`) that acts as the single network authority.
Remote workers use the same CLI interface with `--server <url>`, preserving the same semantics and exit codes everywhere without complex middleware.

## Separation of concerns: data vs concurrency

`quota-axi` reports quota facts and stays data-only.
`lease-axi` manages concurrency leases and stays neutral.
Neither invents quota limits, and neither intercepts or proxies agent model requests.
Dispatchers make routing decisions using quota data from `quota-axi` and enforce concurrency bounds using `lease-axi`.
