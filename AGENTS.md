# AGENTS.md

## Repository Purpose

VibiNet is a deterministic input-synced netcode library for realtime games.
Clients replay the same input stream and compute the same game state.

## How VibiNet Works

### File layout (exactly 3 source files, split by purity + platform)

- `src/vibinet.ts`: ALL pure code, zero platform deps. One Types section up
  top, then one section per type: Writer/Reader (bit cursors), Packed (bit
  packer), Check, Message (wire codec), Time, Post, State, Engine (replay
  core: finalization model, one base state + small pending window,
  checksums).
- `src/client.ts`: the impure client side and package entry point. WebSocket
  transport (`client_new`: reconnect, time sync, post queue) + the stateful
  `VibiNet.game` shell (owns transport, engine value, state memos).
  Re-exports everything from vibinet.ts.
- `src/server.ts`: the impure server side (entry point: `bun run
  src/server.ts`). Append-only disk storage (Store/Record sections),
  watcher/stream bookkeeping, checkpoints, static HTTP for walkers.
- Dependency graph is a strict line: `server.ts -> vibinet.ts <- client.ts`.

### Naming discipline (bend.ts style)

- Every top-level function is `<type>_<functionality>`: `engine_step`,
  `packed_encode`, `message_decode`, `store_append`, `writer_bit`, ...
- Sections are named after types (`// Engine`, `// Packed`, `// Store`).
- All types of a file live in its leading `// Types` section.
- Keep this discipline when adding code.

### Protocol and encoding

- Wire frames are a Packed Union (`Message` in vibinet.ts); decode is
  bounds-checked (truncated frames throw, never yield zeros).
- Time sync messages carry a nonce; only the reply to the latest request is
  accepted (stale replies would poison the clock offset).
- `watch` carries a `from` index; there is no separate `load` message. The
  client tracks a per-room cursor and re-watches from it on reconnect.
- The server pushes `checkpoint` messages (per watch + every CHECKPOINT_MS);
  clients never poll. Posts carry an optional (tick, hash) checksum of the
  sender's finalized state for desync detection.

### Server side

- Server streams room posts with per-connection ordered contiguous cursors.
- Server time is monotone (post server_time never decreases in index) and
  client_time is clamped to it on ingestion (no future-dated posts).
- Malformed frames are ignored (never crash); room names are validated
  against `[A-Za-z0-9_-]{1,64}` before touching storage.

### Replay safety model

- `frontier_ms` in the Engine section is the proven bound: no unseen post
  can land before it. It advances by `server_time - tolerance` of contiguous
  posts and checkpoints (NOT by `post_time`, which is not monotone in
  index).
- Ticks below the frontier are folded into `base_state` and discarded; a
  post below base is impossible by construction (monotone server time,
  contiguous delivery, tolerance clamp on both sides).
- `engine_state_at(tick)` answers any tick >= base; earlier ticks clamp to
  base.
- `test/engine.test.ts` holds the pure-core property tests (order
  invariance, finalization equivalence, prediction, checksums,
  non-mutation).
- The shell memoizes computed states and invalidates them from the arriving
  post's tick onward.

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
- Current production machine: AWS EC2 sa-east-1 (São Paulo), account
  483162586707, instance `i-0bb121a73862e8342` (t4g.small, Ubuntu 24.04
  arm64), Elastic IP `54.207.112.112`. SSH: `ssh vibinet` (alias in
  Taelin's ssh config, key `~/.ssh/vibinet_aws.pem`).
- Provisioned by `scripts/provision.sh` (bun + caddy auto-TLS on 443 ->
  127.0.0.1:8080 + systemd units). Re-runnable; see header for the AWS
  commands that created the machine.
- Remote repo path: `/home/ubuntu/vibinet`.
- Production auto-sync tracks only GitHub branch `main` (45s timer);
  deploy = push to main.
- Previous machine (18.230.148.202 / 18.228.157.116) is dead; DNS was
  repointed 2026-07-02.

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
