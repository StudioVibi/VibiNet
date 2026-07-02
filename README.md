# VibiNet

Deterministic input-synced netcode for real-time browser games.

You write your game as two pure functions (`on_tick`, `on_post`). VibiNet
syncs **inputs**, not state: the server timestamps, orders, stores, and
broadcasts posts; every client replays the same post stream through the same
pure functions and computes the same state. Local inputs apply instantly via
prediction; late posts trigger an automatic rollback + replay. Proven-final
history is folded into a single base state, so memory and rollback cost stay
bounded, and clients cross-check state hashes to detect divergence.

The library is split by purity: `vibinet-ts/src/vibinet.ts` is the entire
pure core (bit packer, wire codec, replay engine) — plain data in, plain
data out, no IO. `vibinet-ts/src/client.ts` is the client shell (WebSocket
transport + the stateful `VibiNet.game` class) plus the optional
client-side identity layer (Ethereum-style users, per-post auth, display
names — the server knows nothing about any of it), and
`vibinet-ts/src/server.ts` is the server entry point.

New here? Read `TUTORIAL.md` — a self-contained, step-by-step guide to
building an online game with VibiNet.

Requirements: your logic must be deterministic. Same inputs, same order, same
result. No `Math.random()`, no `Date.now()`, no reads outside the state, and
no transcendental math (`Math.sin`, `Math.pow`, ... are not bit-exact across
engines; float `+ - * /` is fine). Both functions must treat state as
immutable (return new objects, never mutate).

## Install

```bash
git clone https://github.com/StudioVibi/VibiNet vibinet
```

```ts
import { VibiNet } from "./vibinet/vibinet-ts/src/client.ts";
```

The TypeScript implementation lives in `vibinet-ts/` (a bun-first package:
import the source directly, or `npm run build` there to emit a browser
bundle + `.d.ts` at `devs/dist/`).

## Quick Start

```ts
import { VibiNet } from "vibinet"; // or from "./vibinet/vibinet-ts/src/client.ts"

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
  room: "MyRoom#0001",           // rooms are 64-bit nicks (see Rooms & Nicks)
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
| `room`            | `string`                | required           | Room to join, as a nick (`"JohnBear#15FF"`, see Rooms & Nicks). |
| `initial`         | `S`                     | required           | State before the first post. |
| `on_tick`         | `(s: S) => S`           | required           | Advances the world by one tick. Pure. |
| `on_post`         | `(p: P, s: S) => S`     | required           | Applies one input. Pure. |
| `packer`          | `VibiNet.Packed`        | required           | Wire schema for `P`. |
| `tick_rate`       | `number`                | required           | Ticks per second. |
| `tolerance`       | `number`                | required           | Max ms an input may apply in the past (see Time Model). |
| `server`          | `string`                | official server    | WebSocket URL. `http(s)://` is auto-upgraded to `ws(s)://`. |
| `smooth`          | `(remote: S, local: S) => S` | `(r, l) => r` | Blends stable past + predicted present (see below). |
| `check_stride`    | `number`                | `64`               | Ticks between finalized-state checksums (desync detection). |
| `on_desync`       | `(info) => void`        | none               | Called once if a peer's state hash disagrees with ours. |
| `client`          | `ClientApi<P>`          | real WebSocket     | Injectable transport, for tests/simulation. |
| `auth`            | `boolean`               | `false`            | Fold the auth envelope (see Identity). Part of the room's protocol: all clients must agree, like `packer`. |
| `user`            | `User`                  | none               | Identity signing outgoing posts (requires `auth: true`). Absent = post anonymously. |

### Methods

| Method                       | Returns          | Meaning                                                                                                                                |
| ---------------------------- | ------------     | ---------                                                                                                                              |
| `on_sync(cb)`                | `void`           | Runs `cb` once time sync is ready (immediately if already synced). Do not `post` before this.                                          |
| `post(data: P)`              | `void`           | Sends an input and applies it locally right away (prediction). Throws if called before sync. Queued and flushed if the socket is down. |
| `compute_render_state()`     | `S`              | State to draw this frame: `smooth(remote_state, local_state)`.                                                                         |
| `compute_current_state()`    | `S`              | State at the current server tick (with local prediction).                                                                              |
| `compute_state_at(tick)`     | `S`              | State at any tick >= `finalized_tick()` (earlier ticks clamp: their history is folded away).                                           |
| `server_time()`              | `number`         | Synced server time in ms. Throws before first sync.                                                                                    |
| `server_tick()`              | `number`         | `time_to_tick(server_time())`.                                                                                                         |
| `time_to_tick(ms)`           | `number`         | `floor(ms * tick_rate / 1000)`.                                                                                                        |
| `ping()`                     | `number`         | Smoothed RTT in ms (`Infinity` before first sample).                                                                                   |
| `post_count()`               | `number`         | Total posts seen in the room.                                                                                                          |
| `initial_tick()`             | `number or null` | Tick of the room's first post (`null` if none yet).                                                                                    |
| `finalized_tick()`           | `number or null` | Newest tick whose history is final (never rolls back).                                                                                 |
| `desync()`                   | `Desync or null` | Non-null if a peer's finalized-state hash disagreed with ours.                                                                         |
| `close()`                    | `void`           | Unwatches and closes the connection.                                                                                                   |
| `debug_dump()`               | dump             | Engine + transport introspection.                                                                                                      |
| `VibiNet.nick_gen()`         | `string`         | Static. Random 64-bit nick (fresh room ids: one per match).                                                                            |

### Other exports

```ts
import { VibiNet, client_new, nick_gen, user_init, name_get, OFFICIAL_SERVER_URL } from "vibinet";
```

- `client_new(server?)` — the raw WebSocket transport (`ClientApi`), only
  needed to build custom transports or tests.
- The pure core (`engine_new`, `engine_step`, `engine_state_at`,
  `packed_encode`, `packed_decode`, `message_encode`, `message_decode`, ...).
  Use it directly for headless simulation or property tests; `VibiNet.game`
  is a thin IO shell around it.
- Nicks: `nick_read`, `nick_show`, `nick_norm`, `nick_link`, `nick_gen`.
- Identity: `user_new`, `user_init`, `user_load`, `user_save`, `user_addr`,
  `user_nick`, `addr_nick`, `sig_make`, `sig_addr`, `chain_new`,
  `chain_pass`, `chain_verify`, `auth_config`, `auth_packed`, `name_set`,
  `name_get`, `claim_make`, `claim_fold` (see Identity below).
- `OFFICIAL_SERVER_URL` — `wss://net.studiovibi.com`.
- Types: `VibiNet.Packed`, `VibiNet.Options<S, P>`, `ClientApi<P>`,
  `Event<P>`, `Engine<S, P>`, `Config<S, P>`, `User`, `Address`, `Auth`,
  `Envelope<P>`, `Meta`, `Claim`.

## Rooms & Nicks

A room id is 64 bits. Its text form is a **nick**: up to 8 chars in
`[_a-zA-Z0-9$]` (6 bits each, `_` is the zero digit), then `#`, then 4 hex
digits — `JohnBear#15FF`. Leading `_` are stripped when printing, so
`Bob#1234` and `_____Bob#1234` are the same id. In URLs `#` becomes `.`
(`?room=JohnBear.15FF`); parsing accepts both. The wire and the server's db
carry only the raw 64 bits — nicks exist in code and UIs.

Rooms have no creation step, no membership, and no server-side meaning:
posting to a nick brings the room into existence. `nick_gen()` makes a
fresh random one (e.g. one per match).

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

### Finalization

The server periodically sends **checkpoints** ("the stream is complete
through index N as of time T"). Contiguously received posts and checkpoints
advance a proven frontier: no unseen post can land before it. Everything
below the frontier is folded into a single base state and discarded — a post
landing below it is impossible by construction, so history is never silently
lost. The pending window past the base is small (tolerance + latency +
checkpoint period, typically under 2 s), which bounds both memory and the
cost of any rollback. Late joiners fold the whole room to catch up; on
reconnect the client resumes from its last seen post index.

### Desync detection

While folding, each client hashes its finalized state every `check_stride`
ticks and piggybacks the newest (tick, hash) on outgoing posts. Receivers
compare against their own hash for that tick; a mismatch calls `on_desync`
and sets `desync()`. Since finalized state is authoritative-only, matching
logic always produces matching hashes.

## Identity (client-side auth)

Optional, and invisible to the server: identity is a protocol folded by the
clients, riding inside ordinary post payloads. A user is an Ethereum-style
secp256k1 keypair; their address is their identity everywhere, and its last
8 bytes are their **auto-nick** (`user_nick`) — a printable handle and the
address of their personal room. Signatures are EIP-191 personal messages,
so a wallet like MetaMask can replace the local key without protocol
changes.

```ts
import { VibiNet, user_init, name_set, name_get } from "vibinet";

const user = user_init(); // localStorage-backed keypair (created on first run)

const game = new VibiNet.game<State, Post>({
  room: "Match_42#A3F1",
  auth: true,  // this room folds identities (all clients must agree)
  user,        // sign my posts (omit to play anonymously)
  /* ...initial, on_tick, on_post, packer, tick_rate, tolerance... */
});
```

With `auth: true`, every post reaching `on_post` carries two extra fields:
`$user` (the sender's address) and `$nick` (its auto-nick) — or `null` for
anonymous or invalid posts. What anonymous posts may do is the game's
choice; most games just ignore them:

```ts
function on_post(post: Post & { $user?: string | null }, state: State): State {
  if (post.$user == null) return state; // authenticated players only
  /* ...use post.$user as the player's id... */
}
```

How it works (all pure, all deterministic, ~1µs per post):

- The first post carries a **Join**: one signature binding the sender's
  address to a fresh hash chain (`head = H^16384(seed)`, 16-byte links,
  H = sha256 truncated). ~86 bytes, once per ~16k posts.
- Every later post carries a **Pass**: the next chain preimage. Verifying
  is one sha256; +16 bytes per post. The server-assigned total order makes
  "first reveal wins" identical on every client, so a stolen or replayed
  link hashes against an already-moved head and folds as anonymous.
- Join replays fail too: each Join signs the room nick (no cross-room
  replay) and a strictly increasing time (no same-room replay).
- When a chain runs out, the client re-anchors with a new Join
  automatically.

Authentication compares full 160-bit addresses, never nicks: nicks are for
printing. Two users sharing an auto-nick (a 64-bit collision) is harmless.

Threat model: malicious clients (impersonation, theft, replay). The server
is trusted for ordering — the same trust the rest of VibiNet already places
in it — and transport runs over TLS.

### Display names

A user's **name** is decoration, not identity: not unique, display-only,
never part of game state (it lives in a different room, and rooms must stay
self-contained).

```ts
await name_set(user, "Johnny_the_Bear");        // sign + publish
const name = await name_get(address);           // read someone's name
```

`name_set` posts a signed claim to the user's own auto-nick room — the room
is the registry. `name_get` folds that room: claims whose signature
recovers the exact address win by highest signed time (renames work,
replayed old claims can never win). Names are `[A-Za-z0-9_]{1,32}`. Render
name + nick together (`Johnny_the_Bear (JohnBear#15FF)`) so a copied name
never passes as a copied identity.

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
| `{ $: "Hex", size: N }` | string of 2N hex chars (decodes lowercase) | N bytes |

Union notes: tag ids are assigned by *sorting variant names* — renaming a
variant changes the wire format. For `Struct` variants the object itself is
the payload; for any other variant type use `{ $: "tag", value: payload }`.

## Server

The server is game-agnostic: it assigns monotone timestamps, appends posts to
disk, and streams them to watchers in contiguous index order. It never
decodes payloads and never runs game logic.

```bash
bun run vibinet-ts/src/server.ts                          # 0.0.0.0:8080, also serves walkers demo
HOST=127.0.0.1 PORT=8080 bun run vibinet-ts/src/server.ts # behind a reverse proxy
```

- Posts persist in `data/<code>.dat` + `data/<code>.idx` at the repo root
  (append-only), where `<code>` is the room's 64-bit id as 16 hex digits.
  Delete both files to reset a room.
- `CHECKPOINT_MS` (default 1000) sets the checkpoint broadcast period; lower
  values shrink the clients' pending window.
- Client and server must run the same vibinet version: the wire protocol is
  not stable across minor versions (0.4.0 changed it: rooms are 64-bit).
- Browser pages served over HTTPS must use `wss://` (the client auto-upgrades
  and warns).
- Deployment/auto-sync helpers live in `devs/scripts/` (see `AGENTS.md`).

## Demo

`demo/walkers/` is a complete commented example (players are letters moving with
WASD): state, posts, packer, smoothing, and browser bootstrap in one file.
Run `bun run vibinet-ts/src/server.ts` and open `http://localhost:8080`
(share a room with `?room=SomeRoom.15FF`).
