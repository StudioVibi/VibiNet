# VibiNet

VibiNet lets you build real‑time online games by writing **offline game logic**.
You define the state and how it changes; VibiNet handles networking, ordering,
time sync, and replay so every client computes the same state.

If you can write the offline version of your game, VibiNet can make it online.

## Installation

```bash
npm install vibinet
```

## Importing

```ts
import { VibiNet } from "vibinet";
```

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
const server = "ws://net.studiovibi.com:8080"; // optional
const room = "walkers";

const game = new VibiNet.game<State, Post>({
  server,
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

If you omit `server`, it defaults to `ws://net.studiovibi.com:8080`. You can
point it at any WebSocket server that speaks the VibiNet protocol.
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

This starts a server on port 8080 that also serves the Walkers demo.

To connect a client to your self‑hosted server:

```ts
const game = new VibiNet.game({ server: "ws://<ip>:8080", ... });
```

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
