# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that travel with the code.

Architecture, CLI flags, store formats, and server contracts are owned by [README.md](README.md). Follow the sections named there instead of restating them here.

- [VISION.md](VISION.md) is the project's acceptance policy and architectural charter.
- `lease-axi` is a neutral pool lease tool. It caps concurrency on shared resources (such as Antigravity pools, API subscriptions, or shared project environments).
- It never queries vendor usage endpoints, never mints credentials, never proxies API calls, and never alters model routing.
- The deferral exit code on capacity exhaustion is strictly 75 (`EX_TEMPFAIL`). Callers and tests depend on this exact exit code.
- Validation errors exit 2 (`VALIDATION_ERROR` via `axi-sdk-js`).
- State mutations are atomic:
  - Local mode acquires exclusive lock via `openSync(path, "wx", 0o600)` with process PID, hostname, and token.
  - State file updates write to a temporary file (`.tmp.<uuid>`) and atomic `renameSync`.
  - HTTP authority mode (`serve`) synchronizes operations through the same underlying store engine.
- Expired leases are reclaimed at admission time on every `grant` and during `status` queries.
- Tests are synthetic and isolated: never rely on live services, network addresses outside loopback, or shared system paths. Tests run in temporary directories (`mkdtempSync`).

## Development

```sh
pnpm install
pnpm run build
pnpm run lint
pnpm run format:check
pnpm test
```

After modifying dependencies or configuration, ensure `pnpm run lint && pnpm run format:check && pnpm test` pass before committing.

## Maintaining this file

Keep this file for knowledge useful to future agent sessions in this project.
Do not repeat what the codebase or README already document; point to the authoritative file or command instead.
Keep entries concise and factual.
