# AGENTS.md

## Repository Purpose

VibiNet is a deterministic input-synced netcode library for realtime games.
Clients replay the same input stream and compute the same game state.

## How VibiNet Works

### Core runtime

- `src/vibi.ts`: deterministic replay engine.
- `src/client.ts`: WebSocket client, room ops, and time sync.
- `src/index.ts`: public package exports.

### Protocol and encoding

- `src/packer.ts`: bit-level schema serializer/deserializer.
- `src/protocol.ts`: wire message schema and adapters.
- `src/binary.ts`: binary helpers used by storage/protocol internals.

### Server side

- `src/server.ts`: Bun HTTP + WebSocket server.
- `src/storage.ts`: append-only room persistence.
- `src/server_url.ts`: official endpoint constant and URL normalization.

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
- Current production machine: `ubuntu@18.230.148.202`.
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
