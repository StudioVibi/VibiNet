# AGENTS.md

## Repository Purpose

VibiNet is a deterministic input-synced netcode library for realtime games.
Clients replay the same input stream and compute the same game state.

## How VibiNet Works

### Core runtime

- `src/vibi.ts`: deterministic replay engine.
- `src/client.ts`: WebSocket client, room ops, and time sync.
- `src/index.ts`: public package exports.
- `test/desync_regression.test.ts`: regression tests for desync root cause.

### Protocol and encoding

- `src/packer.ts`: bit-level schema serializer/deserializer (bounds-checked decode).
- `src/protocol.ts`: wire message schema and adapters.
- `src/binary.ts`: binary helpers used by storage internals.
- Protocol includes latest-index checkpoint messages used by replay safety.
- Time sync messages carry a nonce; only the reply to the latest request is
  accepted (stale replies would poison the clock offset).
- `watch` carries a `from` index; there is no separate `load` message. The
  client tracks a per-room cursor and re-watches from it on reconnect.

### Server side

- `src/server.ts`: Bun HTTP + WebSocket server.
- `src/storage.ts`: append-only room persistence.
- `src/server_url.ts`: official endpoint constant and URL normalization.
- Server streams room posts with per-connection ordered contiguous cursors.
- Server time is monotone (post server_time never decreases in index) and
  client_time is clamped to it on ingestion (no future-dated posts).
- Malformed frames are ignored (never crash); room names are validated
  against `[A-Za-z0-9_-]{1,64}` before touching storage.

### Replay safety model

- Client tracks `no_pending_posts_before_ms` in `src/vibi.ts`.
- The contiguous frontier advances by `server_time - tolerance` (NOT
  `official_time`, which is not monotone in index).
- `compute_state_at` is clamped so pruning never crosses unknown history.
- If a post arrives before the cache window, cache is invalidated loudly;
  posts are not silently dropped.
- `compute_state_at` results are memoized per (tick, timeline_version).

### Demo app

- `walkers/`: browser demo and tutorial app.

### Ops automation

- `scripts/setup-auto-sync.sh`: installs/updates remote sync units.
- `scripts/sync-main.sh`: canonical sync job used in production.
- `scripts/check-official-endpoint.sh`: blocks deprecated official endpoint.
- `scripts/deploy.sh`: manual deploy fallback.

## Official Server Context

- Official WebSocket endpoint: `wss://net.studiovibi.com`.
- Official host: `net.studiovibi.com`.
- Current production machine: `ubuntu@18.228.157.116`.
- Remote runbook: `/home/ubuntu/VIBINET_SERVER_NOTES.md`.
- Remote repo path: `/home/ubuntu/vibinet`.
- Production auto-sync tracks only GitHub branch `main`.

## Important Repo Areas

### Must read first

- `README.md` for product usage and self-hosting guidance.
- `package.json` for scripts and publish behavior.
- `src/` for library/server behavior.
- `scripts/` for deployment and sync behavior.

### Validation area

- `test/` contains simulation and correctness tests.
- Use tests to validate behavior changes before deploy/publish.

## Generated or Runtime Files

- `dist/` and `walkers/dist/` are generated bundles.
- `db/*.dat` and `db/*.idx` are persistent room event files.
- `.tmp/` is local scratch space.

## Agent Working Rules

1. Keep this `AGENTS.md` updated when architecture or repo structure changes.
2. Do not hardcode `ws://net.studiovibi.com:8080` as official endpoint.
3. Before publish/deploy, run:
   `npm run check:official-endpoint`, `npm run check`, and `bun test`.
4. Treat GitHub `main` as production source of truth.
5. Do not make persistent production edits directly on remote working tree.
6. If server behavior changes, update this file and the remote runbook at
   `/home/ubuntu/VIBINET_SERVER_NOTES.md`.
