# VibiNet

Deterministic input-synced netcode for real-time browser games.

You write your game as two pure functions (`on_tick`, `on_post`). VibiNet
syncs **inputs**, not state: the server timestamps, orders, stores, and
broadcasts posts; every client replays the same post stream through the same
pure functions and computes the same state. Local inputs apply instantly via
prediction; late posts trigger an automatic rollback + replay from cached
snapshots.

Requirements: your logic must be deterministic. Same inputs, same order, same
result. No `Math.random()`, no `Date.now()`, no reads outside the state. Both
functions must treat state as immutable (return new objects, never mutate).

## Install

```bash
npm install vibinet
```

```ts
import { VibiNet } from "vibinet";
```

## Quick Start

```ts
import { VibiNet } from "vibinet";

// 1. State: plain data, one snapshot of the world per tick.
type State = { [pid: string]: { x: number; y: number; dx: number } };
const initial: State = {};

// 2. Posts: player inputs. The ONLY thing sent over the network.
type Post =
  | { $: "spawn"; pid: number; x: number; y: number }
  | { $: "move";  pid: number; dx: number };

// 3. Pure logic.
function on_tick(s: State): State {
  const out: State = {};
  for (const [pid, p] of Object.entries(s)) {
    out[pid] = { ...p, x: p.x + p.dx };
  }
  return out;
}

function on_post(post: Post, s: State): State {
  switch (post.$) {
    case "spawn": return { ...s, [post.pid]: { x: post.x, y: post.y, dx: 0 } };
    case "move":  return { ...s, [post.pid]: { ...s[post.pid], dx: post.dx } };
  }
}

// 4. Wire schema for posts (see "Packed Types" below).
const packer: VibiNet.Packed = {
  $: "Union",
  variants: {
    spawn: { $: "Struct", fields: {
      pid: { $: "UInt", size: 8 },
      x:   { $: "Int",  size: 32 },
      y:   { $: "Int",  size: 32 },
    }},
    move: { $: "Struct", fields: {
      pid: { $: "UInt", size: 8 },
      dx:  { $: "Int",  size: 8 },
    }},
  },
};

// 5. Create the game object.
const game = new VibiNet.game<State, Post>({
  server: "ws://localhost:8080", // omit for the official server
  room: "my-room",
  initial,
  on_tick,
  on_post,
  packer,
  tick_rate: 24,  // ticks per second
  tolerance: 300, // ms a late input may land in the past
});

// 6. Post inputs only after time sync; render every frame.
game.on_sync(() => {
  game.post({ $: "spawn", pid: 65, x: 200, y: 200 });
});

function frame() {
  const state = game.compute_render_state();
  // ...draw state...
  requestAnimationFrame(frame);
}
frame();
```

Every client in the same room must use identical `initial`, `on_tick`,
`on_post`, `packer`, `tick_rate`, and `tolerance`, or they will desync.

## API

### `new VibiNet.game<S, P>(options)`

`VibiNet.game` is the class itself (`new VibiNet(...)` also works). `S` is
your state type, `P` your post type.

| Option            | Type                    | Default            | Meaning |
|-------------------|-------------------------|--------------------|---------|
| `room`            | `string`                | required           | Room to join. Must match `[A-Za-z0-9_-]{1,64}`. |
| `initial`         | `S`                     | required           | State before the first post. |
| `on_tick`         | `(s: S) => S`           | required           | Advances the world by one tick. Pure. |
| `on_post`         | `(p: P, s: S) => S`     | required           | Applies one input. Pure. |
| `packer`          | `VibiNet.Packed`        | required           | Wire schema for `P`. |
| `tick_rate`       | `number`                | required           | Ticks per second. |
| `tolerance`       | `number`                | required           | Max ms an input may apply in the past (see Time Model). |
| `server`          | `string`                | official server    | WebSocket URL. `http(s)://` is auto-upgraded to `ws(s)://`. |
| `smooth`          | `(remote: S, local: S) => S` | `(r, l) => r` | Blends stable past + predicted present (see below). |
| `cache`           | `boolean`               | `true`             | Snapshot caching. Off = full replay per call (debug only). |
| `snapshot_stride` | `number`                | `8`                | Ticks between snapshots. |
| `snapshot_count`  | `number`                | `256`              | Snapshots kept. Rollback window = `stride * count` ticks. |
| `client`          | `ClientApi<P>`          | real WebSocket     | Injectable transport, for tests/simulation. |

### Methods

| Method                     | Returns    | Meaning |
|----------------------------|------------|---------|
| `on_sync(cb)`              | `void`     | Runs `cb` once time sync is ready (immediately if already synced). Do not `post` before this. |
| `post(data: P)`            | `void`     | Sends an input and applies it locally right away (prediction). Throws if called before sync. Queued and flushed if the socket is down. |
| `compute_render_state()`   | `S`        | State to draw this frame: `smooth(remote_state, local_state)`. |
| `compute_current_state()`  | `S`        | State at the current server tick (with local prediction). |
| `compute_state_at(tick)`   | `S`        | State at an arbitrary tick (clamped to known-complete history). |
| `server_time()`            | `number`   | Synced server time in ms. Throws before first sync. |
| `server_tick()`            | `number`   | `time_to_tick(server_time())`. |
| `time_to_tick(ms)`         | `number`   | `floor(ms * tick_rate / 1000)`. |
| `ping()`                   | `number`   | Smoothed RTT in ms (`Infinity` before first sample). |
| `post_count()`             | `number`   | Total posts seen in the room. |
| `initial_time()` / `initial_tick()` | `number \| null` | Time/tick of the room's first post (`null` if none yet). |
| `close()`                  | `void`     | Unwatches and closes the connection. |
| `debug_dump()`             | dump       | Full engine introspection (posts, timeline, snapshots, client). |
| `debug_recompute(tick?)`   | dump       | Drops the cache and replays from scratch. Debug only. |
| `VibiNet.gen_name()`       | `string`   | Static. Random 8-char id (useful for room names). |

### Other exports

```ts
import { VibiNet, create_client, gen_name, OFFICIAL_SERVER_URL } from "vibinet";
```

- `create_client(server?)` — the raw WebSocket transport (`ClientApi`), only
  needed to build custom transports or tests.
- `OFFICIAL_SERVER_URL` — `wss://net.studiovibi.com`.
- Types: `VibiNet.Packed`, `VibiNet.Options<S, P>`, `VibiNet.DebugDump<S, P>`,
  `VibiNet.RecomputeDump<S>`.

## Time Model

A **room** is an append-only stream of posts. Its first post anchors tick 0's
epoch. Each post gets a `client_time` (sender's synced clock) and a
`server_time` (assigned at ingestion, monotone). The tick a post lands on is
the same for every client:

```
official_time = max(client_time, server_time - tolerance)   // server also
official_tick = floor(official_time * tick_rate / 1000)     // clamps
                                                            // client_time <= server_time
```

So an input applies at the moment the player pressed it, as long as it reaches
the server within `tolerance` ms — clients that already passed that tick roll
back and replay. Larger `tolerance` = more responsive under lag, but deeper
rollbacks and higher remote render delay.

### Rendering and `smooth`

`compute_render_state()` computes two states and blends them:

- `local_state`: current tick, including your predicted inputs.
- `remote_state`: a past tick that is stable (no rollbacks expected):
  `remote_tick = curr_tick - max(tolerance_ticks, half_rtt_ticks + 1)`.

Default `smooth` returns `remote_state` (everything delayed but stable). The
usual pattern is: take yourself from `local_state`, everyone else from
`remote_state`:

```ts
const smooth = (remote: State, local: State): State =>
  local[me] ? { ...remote, [me]: local[me] } : remote;
```

### Rollback window

Snapshots cover `snapshot_stride * snapshot_count` ticks (default 2048 ticks
= ~85 s at 24 tps). Posts older than the window are pruned only after the
server proves no earlier post can still arrive, so history is never silently
dropped. Late joiners replay the whole room to catch up. On reconnect, the
client resumes from its last seen post index.

## Packed Types

Schemas are values of type `VibiNet.Packed`. Encoding is a compact bitstream:
no field names, no padding, LSB-first.

| Schema | Value | Wire format |
|--------|-------|-------------|
| `{ $: "Struct", fields: {a: T, ...} }` | object | each field in key order |
| `{ $: "Tuple", fields: [T, ...] }` | array | each element in order |
| `{ $: "Vector", size: N, type: T }` | array of length N | N elements, no length |
| `{ $: "List", type: T }` | array | 1-bit cons tag per item + item, 0-bit end |
| `{ $: "Map", key: K, value: V }` | `Map` or object (decodes to `Map`) | list of key/value pairs |
| `{ $: "Union", variants: {tag: T, ...} }` | `{ $: "tag", ... }` | `ceil(log2(n))`-bit tag + payload |
| `{ $: "String" }` | string | UTF-8 bytes as a List |
| `{ $: "UInt", size: N }` | number (`bigint` if N > 53) | N bits |
| `{ $: "Int", size: N }` | number (`bigint` if N > 53) | N bits, two's complement |
| `{ $: "Nat" }` | number | unary (N+1 bits) — small values only |

Union notes: tag ids are assigned by *sorting variant names* — renaming a
variant changes the wire format. For `Struct` variants the object itself is
the payload; for any other variant type use `{ $: "tag", value: payload }`.

## Server

The server is game-agnostic: it assigns monotone timestamps, appends posts to
disk, and streams them to watchers in contiguous index order. It never
decodes payloads and never runs game logic.

```bash
bun run src/server.ts                          # 0.0.0.0:8080, also serves walkers demo
HOST=127.0.0.1 PORT=8080 bun run src/server.ts # behind a reverse proxy
```

- Posts persist in `db/<room>.dat` + `db/<room>.idx` (append-only). Delete
  both files to reset a room.
- Room names are restricted to `[A-Za-z0-9_-]{1,64}`.
- Client and server must run the same vibinet version: the wire protocol is
  not stable across minor versions (0.2.0 changed it).
- Browser pages served over HTTPS must use `wss://` (the client auto-upgrades
  and warns).
- Deployment/auto-sync helpers live in `scripts/` (see `AGENTS.md`).

## Demo

`walkers/` is a complete commented example (players are letters moving with
WASD): state, posts, packer, smoothing, and browser bootstrap in one file.
Run `bun run src/server.ts` and open `http://localhost:8080`.
