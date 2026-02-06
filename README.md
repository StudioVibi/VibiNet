# VibiNet

VibiNet lets you build real‑time online games by writing **offline game logic**.
You define the state and how it changes; VibiNet handles networking, ordering,
time sync, and replay so every client computes the same state.

If you can write the offline version of your game, VibiNet can make it online.

## Quick Start (Recommended)

```bash
npm install vibinet
```

```ts
import { VibiNet } from "vibinet";
```

Create your game instance directly from the installed package:

```ts
const game = new VibiNet.game<State, Post>({
  room: "my-room",
  initial,
  on_tick,
  on_post,
  packer,
  tick_rate,
  tolerance,
  smooth, // optional
});
```

If you omit `server`, VibiNet uses the official server at
`wss://net.studiovibi.com` (host: `net.studiovibi.com`).

For production usage, prefer omitting `server` unless you are explicitly
self-hosting.

## How It Works

Most multiplayer engines sync state: the server runs the game, clients receive
snapshots. This works, but it's complex and bandwidth‑heavy.

VibiNet does something different: it syncs **inputs**.

You write your game as if it were offline — a pure function from state to state.
VibiNet runs that same function on every client. The server's only job is to
collect inputs, timestamp them, and broadcast them in order. Every client
replays the same inputs from the same starting point, so every client computes
the same state.

This means:
- The server never runs your game logic.
- Late joiners replay the input history to catch up.
- Bandwidth is tiny (just inputs, not world state).

The tradeoff is that your logic must be **deterministic**. Same inputs, same
order, same result — every time. No `Math.random()`, no floating‑point drift,
no reading from outside the game state.

Under the hood (short):
- **Time sync + official ticks.** Clients continuously ping the server to align
  clocks. Each post has client and server time; VibiNet assigns a deterministic
  tick using `tolerance` so all clients agree.
- **Local prediction + rollback netcode.** Local posts apply immediately; when a
  late post arrives, VibiNet rewinds to that tick and replays forward.
- **Snapshot caching.** Recent state snapshots are cached in a bounded window
  so rollback and replay stay fast.
- **Gapless ingest + safe pruning.** The stream is applied in contiguous index
  order, and cache pruning is clamped by a completeness frontier so no history
  event is silently discarded.
- **Compact binary.** Posts are encoded with your `packer` and stored/sent as
  raw bytes.

Below are the concepts that make this work.

### Rooms

A **room** is an append‑only stream of posts. Think of it as a game universe.
The first post starts the room and anchors its initial time.

Rooms are multi‑purpose: a match, a lobby, a shard, or the entire world.

### Posts

A **post** is a player input — spawn, key down, key up, etc. Posts are the
**only** things sent over the network. You never send state. Every client
replays the same post stream to compute the same state.

### Ticks, Time, and Tolerance

Time advances in fixed **ticks**. Each tick, VibiNet runs `on_tick` (your
function that advances the world), then applies all posts assigned to that tick
in order.

Each post has a client time and a server time. VibiNet clamps the official time
so inputs can land slightly in the past:

`official_time = max(client_time, server_time - tolerance)`

This lets players with moderate latency still have their inputs feel responsive.

### Smoothing (Optional)

VibiNet can optionally blend a stable past state with a locally predicted
present state so your own inputs feel instant. The Walkers example shows a
simple pattern for this below.

## Example: Walkers

Let's build a tiny multiplayer game called **Walkers**. Each player is a single
letter that moves with WASD. That's it — simple enough to fit in one file, but
enough to show how VibiNet works.

The full, commented version of this tutorial lives in `walkers/index.ts`.

### 1) Define State

State is a complete snapshot of the world at one tick. It should be plain data
that can be copied and replayed deterministically.

For Walkers, each player has a position (`x`, `y`) and four booleans tracking
which keys are currently held:

```ts
type Player = {
  x: number;
  y: number;
  w: number;
  a: number;
  s: number;
  d: number;
};

type State = { [char: string]: Player };

const initial: State = {};
```

### 2) Define Posts

Posts are user inputs. We keep the TypeScript type ergonomic, but we'll pack it
compactly on the wire.

Walkers needs three kinds of posts:
- `spawn`: a player joins at a position.
- `down`: a player presses a key.
- `up`: a player releases a key.

Walkers uses a `pid` field to identify players. That's just a game choice — you
can use any id scheme you want.

```ts
type Key =
  | { $: "w" }
  | { $: "a" }
  | { $: "s" }
  | { $: "d" };

type Post =
  | { $: "spawn"; pid: number; x: number; y: number }
  | { $: "down"; pid: number; key: Key }
  | { $: "up"; pid: number; key: Key };
```

### 3) Write The Two Pure Functions

`on_tick(state)` advances the world by one tick.
`on_post(post, state)` applies a single input.

Both must be **pure** and **deterministic**. They must not mutate the input
state — always return a new object. The engine assumes immutability; mutating
will desync clients.

```ts
function on_tick(state: State): State {
  // move each player based on which keys are held
}

function on_post(post: Post, state: State): State {
  // handle spawn, key down, key up
}
```

### 4) Pack Posts Efficiently

VibiNet stores and sends posts in compact binary form. You describe the shape
once with a `Packed` schema.

For Walkers:
- `pid` is a single ASCII code → `UInt(8)`.
- Keys are 4 variants → a 2‑bit union.

```ts
const key_packer: VibiNet.Packed = {
  $: "Union",
  variants: {
    w: { $: "Struct", fields: {} },
    a: { $: "Struct", fields: {} },
    s: { $: "Struct", fields: {} },
    d: { $: "Struct", fields: {} },
  },
};

const packer: VibiNet.Packed = {
  $: "Union",
  variants: {
    spawn: {
      $: "Struct",
      fields: {
        pid: { $: "UInt", size: 8 },
        x: { $: "Int", size: 32 },
        y: { $: "Int", size: 32 },
      },
    },
    down: {
      $: "Struct",
      fields: {
        pid: { $: "UInt", size: 8 },
        key: key_packer,
      },
    },
    up: {
      $: "Struct",
      fields: {
        pid: { $: "UInt", size: 8 },
        key: key_packer,
      },
    },
  },
};
```

### 5) Choose Timing

`tick_rate` is how many ticks per second. `tolerance` is the time window (in ms)
for late posts to still be applied in the past.

```ts
const tick_rate = 24;
const tolerance = 300;
```

### 6) (Optional) Smooth Local Prediction

By default, VibiNet renders a **stable past** so all clients agree. If you want
your own inputs to feel instant, blend in your local predicted player.

VibiNet computes two states:
- **local_state**: present tick, including your local inputs.
- **remote_state**: a past tick that is stable across clients.

The past tick is chosen as:

`remote_tick = current_tick - max(tolerance_ticks, half_rtt_ticks + 1)`

Walkers uses a single character as the player id. We keep our player from the
local state and everyone else from the remote state:

```ts
const my_char = "A"; // however you pick the local player

const smooth = (remote_state: State, local_state: State): State => {
  const me = local_state[my_char];
  if (!me) return remote_state;
  return { ...remote_state, [my_char]: me };
};
```

### 7) Create The VibiNet Game Object

Now you can construct the game. This object owns the network connection and
state replay.

```ts
const room = "walkers";

const game = new VibiNet.game<State, Post>({
  room,
  initial,
  on_tick,
  on_post,
  packer,
  tick_rate,
  tolerance,
  smooth, // optional
});
```

If you omit `server`, it defaults to `wss://net.studiovibi.com`
(official host: `net.studiovibi.com`). You can point it at any WebSocket
server that speaks the VibiNet protocol.
If you don't want smoothing, omit the `smooth` field.

Every player in the same room must use **identical** logic and config. If they
don't, they'll compute different states and desync.

### 8) Use The Game Object

VibiNet connects automatically. `game.on_sync` fires once time sync is ready.
Only post after that.

```ts
const pid = "A".charCodeAt(0);

game.on_sync(() => {
  game.post({ $: "spawn", pid, x: 200, y: 200 });
});

// In your render loop:
const state = game.compute_render_state();
```

If a websocket drops (idle tab, network change, sleep/wake), the client
reconnects automatically and re-subscribes watched rooms. The room stream is
replayed by index order, so state converges again after reconnect. Posts created
while offline are queued and flushed on reconnect.

Rendering is up to you — VibiNet only computes state.

## Self‑Hosting

The VibiNet server is game‑agnostic. It:
- assigns server time and orders posts,
- stores raw post payloads (it does not decode them),
- broadcasts posts to watchers.

It never runs your game logic.

To run your own server:

```bash
bun run src/server.ts
```

This starts a server on `0.0.0.0:8080` by default and also serves the Walkers
demo.

For production, run it behind a reverse proxy on `80/443` and keep the VibiNet
process on localhost only:

```bash
HOST=127.0.0.1 PORT=8080 bun run src/server.ts
```

Then proxy `wss://your-domain` -> `ws://127.0.0.1:8080`.

To connect a client to your self‑hosted server:

```ts
const game = new VibiNet.game({ server: "wss://<your-domain>", ... });
```

### Auto‑Sync From GitHub (main)

If you want the server to stay in sync with your GitHub `main` branch
automatically, use the setup script below once from your local machine:

```bash
REMOTE_HOST=ubuntu@<server-ip> \
REMOTE_DIR=/home/ubuntu/vibinet \
REPO_URL=https://github.com/<owner>/<repo> \
BRANCH=main \
scripts/setup-auto-sync.sh
```

This installs `vibinet-sync.timer` on the server. The timer periodically:
- fetches `origin/main`,
- hard-syncs the working tree to that commit,
- runs `bun install`,
- restarts `vibinet.service`.
- runs `scripts/sync-main.sh` from the repo (single source of truth).

Important:
- The server mirrors `main` exactly. Uncommitted local changes are never deployed.
- Always test the public endpoint (HTTPS page + WSS connection) after each push.
- Never hardcode `ws://` for non-localhost browser clients.

Posts are stored in `db/<room>.dat` and `db/<room>.idx` (append‑only). Delete
those files to reset a room.

## Packed Types

Packed types describe how to encode your posts. This is a usage reference for
building schemas.

### Struct

`{ $: "Struct", fields: { ... } }`

A fixed set of named fields. Your value is a plain object with those keys.

### Tuple

`{ $: "Tuple", fields: [ ... ] }`

A fixed sequence of types. Your value is an Array with matching length.

### Vector

`{ $: "Vector", size: N, type: T }`

Exactly `N` items of the same type. Your value is an Array of length `N`.

### List

`{ $: "List", type: T }`

A variable‑length sequence. Your value is a plain Array.

### Map

`{ $: "Map", key: K, value: V }`

Key/value pairs. Your value can be a `Map` or a plain object.

### Union

`{ $: "Union", variants: { ... } }`

Tagged variants. Your value must be an object with a string `$` tag.
For Struct variants, the object itself is the payload.
For non‑Struct variants, use `{ $: "tag", value: payload }`.

### String

`{ $: "String" }`

A UTF‑8 string.

### Nat

`{ $: "Nat" }`

A small non‑negative integer (unary encoded — best for small values).

### UInt

`{ $: "UInt", size: N }`

An unsigned integer in exactly `N` bits. Use `bigint` for `N > 53`.

### Int

`{ $: "Int", size: N }`

A signed integer in exactly `N` bits (two's complement). Use `bigint` for
`N > 53`.
