# AGENTS.md

## Repository Purpose

VibiNet is a deterministic input-synced netcode library for realtime games.
Clients replay the same input stream and compute the same game state.

## Repository Layout

- `vibinet-ts/`: the TypeScript implementation — `src/` (the 3 source
  files), `package.json`, `tsconfig.json`, `bun.lock`, `node_modules/`.
- `devs/`: dev-specific stuff — `scripts/` (ops), `test/` (bun tests),
  `dist/` (generated build output, gitignored).
- `demo/`: example apps (`demo/walkers/`).
- `data/`: room post storage written by the server (gitignored).
- `README.md` (product docs), `TUTORIAL.md` (self-contained game-building
  guide), `AGENTS.md` (this file) stay at the repo root.

## How VibiNet Works

### File layout (exactly 3 source files, split by purity + platform)

All paths below are relative to `vibinet-ts/`.

- `src/vibinet.ts`: ALL pure zero-dependency code. One Types section up
  top, then one section per type: Writer/Reader (bit cursors), Packed (bit
  packer), Nick (64-bit room ids and their text form), Check, Message (wire
  codec), Time, Post, State, Engine (replay core: finalization model, one
  base state + small pending window, checksums).
- `src/client.ts`: the client side and package entry point. WebSocket
  transport (`client_new`: reconnect, time sync, post queue) + the stateful
  `VibiNet.game` shell (owns transport, engine value, state memos) + the
  identity layer (User/Addr/Sig/Chain/Auth/Claim sections — pure functions
  that live here only because they depend on @noble/curves + @noble/hashes;
  the server is 100% auth-unaware). Re-exports everything from vibinet.ts.
- `src/server.ts`: the impure server side (entry point: `bun run
  vibinet-ts/src/server.ts`). Append-only disk storage (Store/Record
  sections), watcher/stream bookkeeping, checkpoints, static HTTP for the
  demo. All disk paths are anchored to the repo root via `import.meta.url`
  (works from any cwd): posts go to `data/<16hex>.dat/.idx`.
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
- Malformed frames are ignored (never crash). Rooms are 64-bit ids (nicks
  like `JohnBear#15FF` in code/UIs; raw 64 bits on the wire; 16 hex digits
  as data file names), so no name validation is needed.
- Payloads that fail to decode client-side still become posts with
  `data: undefined`: ordered and finalized, never applied. One junk payload
  must not stall a room's frontier.

### Identity layer (client-side only)

- User = secp256k1 keypair; address = identity; auto-nick = address' last 8
  bytes (printing only — auth always compares full addresses).
- Auth rooms (`auth: true`) wrap posts in `Envelope = { auth, body }`:
  `Join` (one EIP-191 signature anchoring a sha256/16 hash chain, signs the
  room nick + strictly increasing time) then `Pass` (one 16-byte preimage
  per post, one sha256 to verify). Server total order makes first-reveal-
  wins deterministic; theft/replay folds as anonymous.
- Engine state of auth rooms is `{ auth, game }` (see `auth_config`); posts
  reach on_post enriched with `$user`/`$nick` (null = anonymous/invalid).
- Names: signed claims in the claimer's auto-nick room; highest signed time
  wins; display-only, never game state (`name_set`/`name_get`).

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
- `devs/test/engine.test.ts` holds the pure-core property tests (order
  invariance, finalization equivalence, prediction, checksums,
  non-mutation).
- The shell memoizes computed states and invalidates them from the arriving
  post's tick onward.

### Demo app

- `demo/walkers/`: browser demo and tutorial app.

### Ops automation (`devs/scripts/`)

- `provision.sh`: provisions/updates a production box end-to-end (bun,
  caddy, systemd units, auto-sync). Idempotent; re-run it whenever server
  entry paths or units change.
- `sync-main.sh`: canonical sync job used in production (runs on the box,
  pulls main, `bun install` in `vibinet-ts/`, restarts vibinet.service).
- `check-official-endpoint.sh`: blocks deprecated official endpoint.

## Official Server Context

- Official WebSocket endpoint: `wss://net.studiovibi.com`.
- Hosted walkers demo: `https://net.studiovibi.com` (same box, caddy).
- Current production machine: AWS EC2 sa-east-1 (São Paulo), account
  483162586707 (srvictormaia@gmail.com), instance `i-0bb121a73862e8342`
  (t4g.small, Ubuntu 24.04 arm64), Elastic IP `54.207.112.112`. SSH:
  `ssh vibinet` (alias in Taelin's ssh config, key
  `~/.ssh/vibinet_aws.pem`).
- Cost: ~US$20/mo (instance ~$12 + EBS 30GB + Elastic IP). AWS budget
  `vibinet-monthly` alerts srvictormaia@gmail.com at 50%/100%/forecast
  of $30/mo.
- DNS: `studiovibi.com` zone lives on Namecheap; `net` A record ->
  54.207.112.112 (updated 2026-07-02).
- Provisioned by `devs/scripts/provision.sh` (bun + caddy auto-TLS on 443
  -> 127.0.0.1:8080 + systemd units). Re-runnable; see header for the AWS
  commands that created the machine.
- Remote repo path: `/home/ubuntu/vibinet`.
- Production auto-sync tracks only GitHub branch `main` (45s timer);
  deploy = push to main.
- Previous machine (18.230.148.202 / 18.228.157.116) is dead; DNS was
  repointed 2026-07-02.

## Important Repo Areas

### Must read first

- `README.md` for product usage and self-hosting guidance.
- `TUTORIAL.md` for the complete how-to-build-a-game guide.
- `vibinet-ts/package.json` for scripts.
- `vibinet-ts/src/` for library/server behavior.
- `devs/scripts/` for deployment and sync behavior.

### Validation area

- `devs/test/` contains simulation and correctness tests. Run them from
  `vibinet-ts/`: `bun test ../devs/test` (or `npm test`).
- Use tests to validate behavior changes before deploy/publish.

## Generated or Runtime Files

- `devs/dist/` and `demo/walkers/dist/` are generated bundles.
- `data/*.dat` and `data/*.idx` are persistent room event files.
- `.tmp/` is local scratch space.

## Agent Working Rules

1. Keep this `AGENTS.md` updated when architecture or repo structure changes.
2. Do not hardcode `ws://net.studiovibi.com:8080` as official endpoint.
3. Before deploy, run (from `vibinet-ts/`):
   `npm run check:official-endpoint`, `npm run check`, and
   `bun test ../devs/test`.
4. Keep `TUTORIAL.md` in sync with API/behavior changes.
5. Treat GitHub `main` as production source of truth.
6. Do not make persistent production edits directly on remote working tree.
7. If server behavior changes, update this file and the remote runbook at
   `/home/ubuntu/VIBINET_SERVER_NOTES.md`.
8. If server entry paths or systemd units change, re-run
   `devs/scripts/provision.sh vibinet` after pushing (auto-sync only pulls
   code; it does not rewrite units).
