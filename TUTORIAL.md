# VibiNet Tutorial: Building an Online Game

This is a self-contained guide (for humans and AIs) to building a real-time
multiplayer game with VibiNet. It starts from zero — what VibiNet is, why it
exists, how it works — and ends with everything you need to know: the full
API, the wire format, the time model, identity/auth, servers, testing, and
every gotcha we know about.

Read sections 1–5 in order; they build a complete working game. Sections
6–15 are reference material you'll come back to.

## Table of Contents

1. [What is VibiNet?](#1-what-is-vibinet)
2. [The Big Idea: Sync Inputs, Not State](#2-the-big-idea-sync-inputs-not-state)
3. [Key Concepts](#3-key-concepts)
4. [Setup](#4-setup)
5. [Your First Game: Dots](#5-your-first-game-dots)
6. [The Determinism Contract](#6-the-determinism-contract)
7. [The Time Model](#7-the-time-model)
8. [Wire Schemas: Packed Types](#8-wire-schemas-packed-types)
9. [Identity: Users, Auth, and Names](#9-identity-users-auth-and-names)
10. [Rooms and Nicks](#10-rooms-and-nicks)
11. [Desync Detection and Debugging](#11-desync-detection-and-debugging)
12. [Running Your Own Server](#12-running-your-own-server)
13. [Testing Your Game Headlessly](#13-testing-your-game-headlessly)
14. [API Reference](#14-api-reference)
15. [Checklist and Gotchas](#15-checklist-and-gotchas)

## 1. What is VibiNet?

VibiNet is a **deterministic input-synced netcode library** for real-time
browser games, written in TypeScript.

You write your game as **two pure functions**:

```ts
on_tick: (state: State) => State           // advance the world by one tick
on_post: (post: Post, state: State) => State  // apply one player input
```

VibiNet does everything else: it sends inputs over the network, orders them,
replays them on every client, predicts your own inputs locally so controls
feel instant, rolls back and replays when late inputs arrive, and
cross-checks state hashes between clients to catch bugs.

What you get:

- **Perfect consistency.** Every client computes the exact same game state.
  There is no "server state" to reconcile against — the input log *is* the
  truth, and the state is a pure function of it.
- **Instant local feedback.** Your own inputs apply immediately
  (prediction), then get confirmed by the server echo.
- **Tiny bandwidth.** Only inputs travel — a few bytes per keypress — never
  world snapshots.
- **A dumb, game-agnostic server.** The server never runs game logic and
  never decodes payloads. One server binary hosts every game ever written
  with VibiNet. You can use the official one and ship a game without
  deploying anything.
- **Trivial replays and spectating.** Since state = fold(inputs), joining
  late, spectating, and replaying a match are all the same operation:
  replay the log.

What it is *not*: VibiNet is not for games that need server-side secrets
(hidden information lives on every client) or server-side authority against
cheaters who modify their client (clients can send any *input*, but can
never corrupt another client's *state*). It is ideal for action games,
co-op games, MOBAs, board games, and anything where "everyone sees
everything" is acceptable.

## 2. The Big Idea: Sync Inputs, Not State

Traditional netcode synchronizes **state**: the server simulates the world
and streams snapshots to clients, which interpolate/extrapolate them. That
costs bandwidth, requires game logic on the server, and makes clients
disagree in the details.

VibiNet synchronizes **inputs** (this is the "lockstep + rollback" family
that fighting games use, generalized). The mental model:

```
A room is an append-only log of posts (inputs), timestamped by the server.

      #0 spawn A       #1 move A up      #2 spawn B      #3 move B left ...
   ─────┬─────────────────┬──────────────────┬────────────────┬─────────►
        t=0ms             t=350ms            t=900ms          t=1430ms

State at any time T = fold on_post/on_tick over all posts before T:

  state(T) = ticks and posts, interleaved in order, applied to `initial`
```

Every client receives the same log, applies the same pure functions, and
therefore computes the same state. Determinism does the synchronization.

Two problems arise, and VibiNet solves both:

1. **Latency**: waiting for the server before applying your own input would
   feel awful. So the client applies your input *optimistically* at the
   current tick (prediction). When a *remote* input arrives that lands in
   the recent past, the client **rolls back** to before it, inserts it, and
   replays forward. This is invisible: it happens between two frames.
2. **Unbounded history**: replaying from t=0 forever would be slow. The
   server periodically broadcasts **checkpoints** ("the log is complete
   through index N as of time T"), which lets clients prove that no unseen
   post can land before a certain tick. Everything older is folded into a
   single **base state** and discarded. Memory and rollback cost stay
   bounded (~2 seconds of pending history), no matter how long the match.

## 3. Key Concepts

| Term | Meaning |
|---|---|
| **Room** | An independent append-only log of posts, identified by a 64-bit id (written as a *nick*, like `JohnBear#15FF`). Rooms need no creation step: posting to one brings it into existence. Use one room per match. |
| **Post** | One player input, as plain data (e.g. `{ $: "move", pid: 3, dir: 1 }`). The only thing that ever crosses the network. |
| **State** | A full snapshot of your game world at one tick. Plain data (objects, arrays, numbers, strings). |
| **Tick** | A discrete simulation step. `tick_rate` ticks happen per second. `on_tick` advances state by exactly one tick. |
| **`on_tick`** | Pure function `S => S`: physics, movement, timers — everything that happens with no input. |
| **`on_post`** | Pure function `(P, S) => S`: applies one input to the state. |
| **Packer** | A schema (`Packed` value) describing your post type, so it can be encoded as a compact bitstream. |
| **Prediction** | Your own posts apply locally the moment you send them. |
| **Rollback** | When a post arrives that lands on a past tick, clients rewind to that tick and replay. Automatic and invisible. |
| **Tolerance** | How many ms in the past an input may land (config). Higher = more forgiving to lag, but deeper rollbacks. |
| **Finalization** | Proven-complete history gets folded into one base state and discarded. `finalized_tick()` never rolls back. |
| **Desync** | Two clients computed different states for the same tick — always a bug (broken determinism or mismatched configs). Detected automatically via state hashes. |
| **Auth (optional)** | A client-side identity protocol: posts arrive tagged with the sender's verified address (`$user`). The server knows nothing about it. |

## 4. Setup

VibiNet lives in a single repository. The TypeScript implementation is in
`vibinet-ts/`:

```
vibinet/
├── vibinet-ts/          # the implementation (this is what you import)
│   ├── src/vibinet.ts   #   pure core: packer, codec, replay engine
│   ├── src/client.ts    #   client entry point (import this)
│   ├── src/server.ts    #   server entry point (bun run this)
│   └── package.json
├── demo/walkers/        # complete example game
├── devs/                # dev stuff: tests, ops scripts, build output
├── data/                # room storage written by a local server
├── README.md
└── TUTORIAL.md          # this file
```

Get it and check it works ([bun](https://bun.sh) required for the server
and tests; the client runs in any browser):

```bash
git clone https://github.com/StudioVibi/VibiNet vibinet
cd vibinet/vibinet-ts
bun install
bun test ../devs/test        # should print: 53 pass
```

Import the client in your game code:

```ts
import { VibiNet } from "./vibinet/vibinet-ts/src/client.ts";
```

(Or add `vibinet-ts` as a package dependency; its entry point is
`src/client.ts`. Bundle with `bun build` or esbuild for the browser.)

You do **not** need to run a server: by default clients connect to the
official one at `wss://net.studiovibi.com`. To develop fully offline, see
[section 12](#12-running-your-own-server).

## 5. Your First Game: Dots

We'll build a complete multiplayer game: every player is a colored dot that
moves with WASD. Two browser tabs (or two computers) in the same room will
see each other move in real time. This is the whole game — one TypeScript
file plus a small HTML page.

### 5.1 State

State is one snapshot of the world. Plain data, no classes, no functions:

```ts
type Dot = {
  x:  number;  // position, in pixels
  y:  number;
  dx: number;  // velocity: -1, 0, or +1 per axis
  dy: number;
};

type State = { [pid: string]: Dot };

const initial: State = {};   // the world before the first post
```

`pid` is a player id. In this demo each player picks a random number when
they join; [section 9](#9-identity-users-auth-and-names) shows how to use
real authenticated identities instead.

### 5.2 Posts

Posts are inputs — *intentions*, not results. Send "I pressed left", never
"my x is now 120" (positions are computed, not transmitted):

```ts
type Post =
  | { $: "spawn"; pid: number }
  | { $: "moved"; pid: number; dx: number; dy: number };
```

Two habits worth copying: posts are a tagged union on `$`, and each post
carries the sender's id (state has no notion of "who sent this" — unless
you use auth, which adds it back verifiably).

### 5.3 on_tick

Advance the world by one tick, with no input. Pure: build a new state,
never mutate the old one:

```ts
const SPEED = 4; // pixels per tick

function on_tick(s: State): State {
  const out: State = {};
  for (const pid of Object.keys(s).sort()) {   // sorted: deterministic order
    const d = s[pid];
    out[pid] = { ...d, x: d.x + d.dx * SPEED, y: d.y + d.dy * SPEED };
  }
  return out;
}
```

Note the `.sort()`: if your logic ever makes players interact (collisions,
damage), iteration order affects the result, and object key order is not
something to rely on. Sorting keys makes order explicit. See
[section 6](#6-the-determinism-contract).

### 5.4 on_post

Apply one input. Also pure:

```ts
function on_post(post: Post, s: State): State {
  switch (post.$) {
    case "spawn":
      if (s[post.pid]) return s;                       // already spawned
      return { ...s, [post.pid]: { x: 200, y: 200, dx: 0, dy: 0 } };
    case "moved":
      if (!s[post.pid]) return s;                      // not spawned: ignore
      return { ...s, [post.pid]: { ...s[post.pid], dx: post.dx, dy: post.dy } };
  }
}
```

**Always handle nonsense gracefully** (double spawns, moves from unknown
players, out-of-range values). Any client can send any post; your fold must
stay total and never throw. A throwing `on_post` crashes every client in
the room at the same tick.

### 5.5 The packer

The packer is a schema describing `Post`, so VibiNet can encode it as a
compact bitstream (full reference in
[section 8](#8-wire-schemas-packed-types)):

```ts
const packer: VibiNet.Packed = {
  $: "Union",
  variants: {
    spawn: { $: "Struct", fields: {
      pid: { $: "UInt", size: 16 },
    }},
    moved: { $: "Struct", fields: {
      pid: { $: "UInt", size: 16 },
      dx:  { $: "Int",  size: 2 },    // -1, 0, +1 fit in 2 bits
      dy:  { $: "Int",  size: 2 },
    }},
  },
};
```

A `moved` post is 21 bits on the wire: 1 tag bit + 16 + 2 + 2.

### 5.6 Creating the game

```ts
import { VibiNet, nick_gen } from "./vibinet/vibinet-ts/src/client.ts";

const room = new URLSearchParams(location.search).get("room") ?? nick_gen();

const game = new VibiNet.game<State, Post>({
  room,            // e.g. "JohnBear#15FF"; nick_gen() makes a fresh one
  initial,
  on_tick,
  on_post,
  packer,
  tick_rate: 24,   // ticks per second
  tolerance: 300,  // ms an input may land in the past
  smooth,          // defined in 5.8
  // server: "ws://localhost:8080",  // omit to use the official server
});
```

**Every client in a room must pass identical `initial`, `on_tick`,
`on_post`, `packer`, `tick_rate`, `tolerance`, and `auth`.** These define
the room's protocol; mismatched clients desync (or fail to decode). Ship
them as shared code.

### 5.7 Sending inputs

Wait for time sync before posting (posting earlier throws — the client
can't timestamp yet):

```ts
const me = Math.floor(Math.random() * 65536); // this tab's pid

game.on_sync(() => {
  game.post({ $: "spawn", pid: me });

  const held = { w: false, a: false, s: false, d: false };
  const send = () => game.post({
    $: "moved", pid: me,
    dx: (held.d ? 1 : 0) - (held.a ? 1 : 0),
    dy: (held.s ? 1 : 0) - (held.w ? 1 : 0),
  });
  const on_key = (down: boolean) => (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k in held && held[k as keyof typeof held] !== down) {
      held[k as keyof typeof held] = down;
      send();
    }
  };
  window.addEventListener("keydown", on_key(true));
  window.addEventListener("keyup",   on_key(false));
});
```

Post on input *edges* (key down/up), not every frame — posts are cheap but
not free. The state carries the velocity between posts; `on_tick` does the
moving.

### 5.8 Rendering and `smooth`

Each frame, ask the game for the state to draw:

```ts
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx    = canvas.getContext("2d")!;

function frame() {
  const s = game.compute_render_state();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const pid of Object.keys(s)) {
    const d = s[pid];
    ctx.fillStyle = Number(pid) === me ? "#4f4" : "#f44";
    ctx.beginPath();
    ctx.arc(d.x, d.y, 10, 0, 6.2832);
    ctx.fill();
  }
  requestAnimationFrame(frame);
}
frame();
```

`compute_render_state()` computes two states and blends them with your
`smooth` function:

- `local`: the current tick, including your own predicted inputs.
- `remote`: a slightly past tick that is *stable* — far enough back that
  arriving inputs won't rewrite it, so remote players never visibly warp.

The default `smooth` returns `remote` (everything stable but slightly
delayed — including you, which feels laggy). The standard pattern is: draw
*yourself* from `local` (instant controls) and *everyone else* from
`remote` (no warping):

```ts
const smooth = (remote: State, local: State): State =>
  local[me] ? { ...remote, [me]: local[me] } : remote;
```

### 5.9 Serving it in a browser

Put the code above in `game.ts`, bundle it, and load it from a page:

```bash
bun build game.ts --outdir dist --target=browser --format=esm
```

```html
<!doctype html>
<canvas id="canvas" width="800" height="600"></canvas>
<script type="module" src="./dist/game.js"></script>
```

Serve the directory with any static file server. That's the entire
deployment — the game connects to the official VibiNet server, so there is
no backend to write or host.

### 5.10 Try it

Open the page in two tabs with the same `?room=` — two dots, each
controlled by its tab, in perfect sync. Open a third tab minutes later: it
replays the log and lands in the same state (late join is free).

The repository contains this game, fully commented, as
[`demo/walkers/`](demo/walkers/) — players are letters instead of dots.
Run `bun run vibinet-ts/src/server.ts` from the repo root and open
`http://localhost:8080` to play it.

## 6. The Determinism Contract

Everything in VibiNet rests on one requirement: **`on_tick` and `on_post`
must be deterministic and pure**. Same inputs, same order, same result — on
every machine, every browser, every replay. Violations cause desyncs:
clients silently drift apart, then the hash check flags it.

The rules:

1. **No randomness.** `Math.random()` is different on every client. If you
   need randomness, derive it deterministically from state + inputs — e.g.
   keep a PRNG seed in the state:

   ```ts
   // xorshift32: same sequence on every client
   function rng_next(seed: number): number {
     let x = seed | 0;
     x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
     return x >>> 0;
   }
   // in on_tick / on_post:
   const seed2 = rng_next(s.seed);
   const roll  = seed2 % 6;                    // deterministic "dice"
   return { ...s, seed: seed2, /* use roll */ };
   ```

   Seed it from post data (e.g. a value the spawner includes) — never from
   `Math.random()` inside the fold.

2. **No clocks.** `Date.now()`, `performance.now()` differ per client. Time
   is already in the model: count ticks in your state if you need timers.

3. **No transcendental floats.** `Math.sin`, `cos`, `sqrt`, `pow`, `exp`,
   `log`, ... are **not bit-exact across JS engines**. Plain float
   `+ - * /` **is** IEEE-754-exact and safe. If you need trig (aiming,
   rotation), use integer/fixed-point math, precomputed tables (stored as
   literals, not computed with `Math.sin` at runtime!), or a polynomial
   approximation you wrote yourself with `+ - * /`.

4. **No outside reads.** State and the post are the only inputs. No
   globals, no DOM, no `localStorage`, no network, no mutable captured
   variables.

5. **No mutation.** Treat state as immutable; return new objects
   (`{ ...s, field }` spreads). VibiNet replays folds from snapshots it
   keeps — mutating a state you were handed corrupts history.

6. **No key-order dependence.** `Object.keys()` order depends on insertion
   history, which *is* deterministic in JS but easy to get wrong across
   code paths. If iteration order affects the outcome, sort the keys.

7. **Handle every post, never throw.** Malicious or buggy clients can send
   any well-formed post. Ignore invalid ones (`return s`). A post whose
   *payload* fails to even decode is delivered with `data: undefined` and
   skipped automatically — it can't stall the room — but a decodable post
   that makes your `on_post` throw will crash every client identically.

8. **Same code on every client.** A room's `initial`, `on_tick`, `on_post`,
   `packer`, `tick_rate`, `tolerance`, `auth` are the room's protocol.
   Version-skewed clients desync; when you change game logic, change rooms
   (or ship a version tag in the room nick).

State must also be **JSON-safe plain data** (objects/arrays/strings/finite
numbers/booleans/null): the desync hash uses `JSON.stringify`, so bigints,
`Map`s, classes, or `undefined` fields in state will break or weaken it.
Represent hashes/ids as hex strings (see the `Hex` packed type).

## 7. The Time Model

### Posts and ticks

Each post carries two timestamps:

- `client_time`: the sender's synced clock when they posted.
- `server_time`: assigned by the server at ingestion; monotone within the
  room; `client_time` is clamped to never exceed it.

The tick a post lands on is computed identically by everyone:

```
official_time = max(client_time, server_time - tolerance)
official_tick = floor(official_time * tick_rate / 1000)
```

Meaning: an input applies **at the moment the player pressed it**, as long
as it reaches the server within `tolerance` ms; otherwise it applies
`tolerance` ms before ingestion. Clients that already simulated past that
tick roll back and replay.

A room's first post anchors tick 0. Clocks are synced against the server
with ping-compensated requests (that's what `on_sync` waits for).

### Choosing `tick_rate` and `tolerance`

- `tick_rate`: simulation granularity. 24 is fine for most games; higher
  rates cost proportionally more CPU during replays.
- `tolerance`: the responsiveness/stability dial.
  - Higher (300–500ms): inputs from laggy players still apply "when
    pressed" — fair and responsive — but rollbacks are deeper and remote
    render delay is larger.
  - Lower (50–100ms): shallow rollbacks, snappier remote view, but slow
    connections get their inputs shifted late.

`compute_render_state` shows remote players
`max(tolerance_ticks, half_rtt_ticks + 1)` ticks in the past — that's the
price of never showing a state that might roll back.

### Finalization (why memory stays bounded)

The server broadcasts a **checkpoint** about once per second: "the log is
complete through index N as of server time T". Contiguous posts and
checkpoints advance a proven **frontier**: no unseen post can ever land
before `frontier - tolerance`. History below it is folded into a single
base state and discarded.

Consequences you can rely on:

- `finalized_tick()` never decreases and its state never changes.
- `compute_state_at(tick)` works for any `tick >= finalized_tick()`;
  earlier ticks clamp to the base (their history is gone).
- Memory and worst-case rollback are ~(tolerance + latency + 1s) of posts,
  regardless of match length.
- Late joiners replay the whole log once, then carry the same small window.

### Reconnection

The transport reconnects automatically (exponential backoff), re-syncs
time, re-watches the room from the last seen post index, and flushes posts
queued while offline. You don't have to do anything.

## 8. Wire Schemas: Packed Types

Posts are encoded as compact bitstreams — no field names, no padding,
LSB-first. A schema is a `Packed` value:

| Schema | Runtime value | Wire format |
|---|---|---|
| `{ $: "Struct", fields: {a: T, b: U} }` | object `{a, b}` | each field, in the schema's key order |
| `{ $: "Tuple", fields: [T, U] }` | array `[t, u]` | each element in order |
| `{ $: "Vector", size: N, type: T }` | array of length N | N elements, no length prefix |
| `{ $: "List", type: T }` | array | per item: 1 bit "cons" + item; then 1 bit "nil" |
| `{ $: "Map", key: K, value: V }` | `Map` or plain object | as a List of key/value pairs; **decodes to `Map`** |
| `{ $: "Union", variants: {x: T, y: U} }` | `{ $: "x", ... }` | `ceil(log2(n))`-bit tag + payload |
| `{ $: "String" }` | string | UTF-8 bytes as a List |
| `{ $: "UInt", size: N }` | number (`bigint` if N > 53) | N bits |
| `{ $: "Int", size: N }` | number (`bigint` if N > 53) | N bits, two's complement |
| `{ $: "Nat" }` | number | unary, N+1 bits — tiny values only |
| `{ $: "Hex", size: N }` | string of 2N hex chars | N raw bytes |

Union rules (important):

- Tag ids are assigned by **sorting variant names alphabetically**.
  Renaming a variant silently changes the wire format — another reason all
  clients must run the same packer.
- If a variant's type is a `Struct`, the object itself is the payload:
  `{ $: "moved", pid: 3, dx: 1 }`. For any *other* variant type, wrap it:
  `{ $: "tag", value: payload }`.

Practical notes:

- Sizes are exact: a `{ $: "UInt", size: 7 }` field costs 7 bits. Choose
  the smallest sizes that fit your domain.
- `Hex` is how you carry hashes/signatures/ids: raw bytes on the wire, a
  lowercase hex *string* in your state (state must stay JSON-safe).
- Values out of range (negative into `UInt`, too-long `Vector`, ...) throw
  at encode time — on the sender, where the bug is.
- Truncated or corrupt frames throw at decode; VibiNet turns an
  undecodable *payload* into a post with `data: undefined` which is
  ordered and finalized but never reaches `on_post`.
- The pure functions `packed_encode(packer, value)` /
  `packed_decode(packer, bytes)` are exported — handy for tests.

## 9. Identity: Users, Auth, and Names

Without auth, posts are anonymous: any client can claim any `pid` (fine for
demos and co-op with friends). The identity layer fixes impersonation —
**entirely client-side**. The server never learns about users, signatures,
or names; identity is a deterministic protocol folded by the clients,
riding inside ordinary post payloads.

### Users and addresses

A **user** is an Ethereum-style secp256k1 keypair. Their **address**
(`0x` + 40 hex) is their identity everywhere. Its last 8 bytes are their
**auto-nick** (e.g. `JohnBear#15FF`) — a printable handle (and the id of
their personal room). Signatures are EIP-191 personal messages, so a wallet
like MetaMask could hold the key instead; no protocol change.

```ts
import { user_init, user_addr, user_nick } from "./vibinet/vibinet-ts/src/client.ts";

const user = user_init();   // browser: load from localStorage, or create+save
user_addr(user);            // "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
user_nick(user);            // "JohnBear#15FF"
```

(`user_new()` makes a keypair without persisting; `user_save`/`user_load`
are the localStorage halves of `user_init`.)

### Auth rooms

```ts
const game = new VibiNet.game<State, Post>({
  room: "Match_42#A3F1",
  auth: true,   // room protocol: ALL clients of this room must set it
  user,         // sign my posts (omit to post anonymously in an auth room)
  /* initial, on_tick, on_post, packer, tick_rate, tolerance, smooth */
});
```

With `auth: true`, every post reaching your `on_post` carries two extra
fields — `$user` (sender's verified address) and `$nick` (its auto-nick) —
or `null` for anonymous/invalid posts. Now identity comes from the
protocol, not from a self-reported `pid`:

```ts
type Post = { $: "moved"; dx: number; dy: number };  // no pid field needed!

function on_post(post: Post & { $user?: string | null }, s: State): State {
  if (post.$user == null) return s;    // ignore anonymous posts (typical)
  const dot = s[post.$user];           // keyed by address
  /* ... */
}
```

What anonymous posts may do is your game's choice; most games ignore them.
Invalid auth (forged, stolen, replayed) deliberately folds to `$user:
null` — indistinguishable from anonymous, because a forger could just post
anonymously anyway.

Requirements: `auth: true` posts must be objects (they get enriched with
`$user`/`$nick`); `user` without `auth: true` throws; and `auth` is part of
the room protocol like the packer — all clients must agree.

### How it works (so you can trust it)

- The first post carries a **Join**: one signature binding the sender's
  address to the head of a fresh hash chain (`head = H^16384(seed)`,
  16-byte links, H = sha256 truncated). ~86 bytes, once per ~16k posts.
- Every later post carries a **Pass**: the next chain preimage. Verifying
  is one sha256 (~1µs); cost is +16 bytes per post.
- The server's total order makes "first reveal wins" identical on every
  client, so a stolen or replayed link hashes against an already-advanced
  head and folds as anonymous.
- Join replay fails too: each Join signs the room nick (no cross-room
  replay) and a strictly increasing timestamp (no same-room replay).
- Exhausted chains re-anchor with a new Join automatically.

Auth compares full 160-bit addresses, never nicks — nicks are for
printing. Two users colliding on an auto-nick is harmless.

Threat model: malicious clients (impersonation, theft, replay) are
defeated. The server is trusted for *ordering* only — the same trust the
rest of VibiNet already places in it — and transport runs over TLS.

### Display names

A **name** is decoration on top of an address: not unique, display-only,
and **never game state** (it lives in the user's own room, and your room's
state must never depend on another room's posts).

```ts
import { name_set, name_get } from "./vibinet/vibinet-ts/src/client.ts";

await name_set(user, "Johnny_the_Bear");   // sign + publish (once, not per match)
const name = await name_get(address);      // -> "Johnny_the_Bear" | null
```

Under the hood: `name_set` posts a signed claim to the user's auto-nick
room (the room *is* the registry); `name_get` folds that room — claims
whose signature recovers the exact address win by highest signed time
(renames work; replayed old claims can't win). Names match
`[A-Za-z0-9_]{1,32}`.

Since names aren't unique, **always render name and nick together** —
`Johnny_the_Bear (JohnBear#15FF)` — so a copied name never passes as a
copied identity. Fetch names asynchronously for display; keep game logic on
addresses.

## 10. Rooms and Nicks

A room id is exactly **64 bits**. Its text form is a **nick**:

```
JohnBear#15FF
└──────┘ └──┘
 body     4 hex digits
```

- Body: up to 8 chars from `[_a-zA-Z0-9$]` (6 bits each; `_` is the zero
  digit, so leading `_` are stripped when printing — `Bob#1234` and
  `_____Bob#1234` are the same id).
- Then `#` and 4 hex digits (uppercase when printed; any case parses).
- In URLs and filenames, `.` replaces `#` (`?room=JohnBear.15FF`, because
  `#` starts a URL fragment). Parsers accept both separators.

Rooms have no creation step, no membership list, no server-side meaning.
Posting to a nick brings the room into existence; anyone who knows the nick
can watch and post. Helpers (all exported):

| Function | Does |
|---|---|
| `nick_gen()` | fresh random nick — use one per match |
| `nick_read(text)` | nick → 64-bit id (`bigint`), `null` if invalid |
| `nick_show(id)` | 64-bit id → canonical nick |
| `nick_norm(text)` | canonicalize a nick string (`null` if invalid) |
| `nick_link(text)` | nick with `#` → URL-safe `.` form |

Since ids are only 64 bits, a determined attacker can find a keypair whose
auto-nick collides with someone's — which is why nothing authenticates by
nick, ever. Addresses authenticate; nicks print.

## 11. Desync Detection and Debugging

While folding finalized history, each client hashes its state every
`check_stride` ticks (default 64) and piggybacks the newest `(tick, hash)`
on outgoing posts. Receivers compare it against their own hash for that
tick. On mismatch:

```ts
new VibiNet.game({
  /* ... */
  on_desync: (info) => {
    // { tick, ours, theirs } — report it; this is always a bug
    console.error("DESYNC", info);
  },
});
game.desync();   // null, or the same info after the fact
```

A desync means determinism broke: mismatched room configs, or an impurity
in `on_tick`/`on_post` (see [section 6](#6-the-determinism-contract)).
Since only finalized (authoritative) states are hashed, false positives
don't happen: matching logic always produces matching hashes.

Debugging aids:

- `game.debug_dump()` — room config, auth status, time sync, ping, and
  engine internals (base tick, frontier, post counts, pending window).
- `game.compute_state_at(tick)` — inspect any live tick.
- `game.post_count()`, `game.finalized_tick()`, `game.initial_tick()`,
  `game.ping()`.
- Determinism bugs reproduce headlessly: replay the same posts through
  your fold twice (or through the pure engine, see
  [section 13](#13-testing-your-game-headlessly)) and diff the states.

## 12. Running Your Own Server

The server is game-agnostic: it assigns monotone timestamps, appends posts
to disk, streams them to watchers in contiguous index order, and broadcasts
checkpoints. It never decodes payloads and never runs game logic — so one
server hosts any number of games and rooms.

```bash
bun run vibinet-ts/src/server.ts                          # 0.0.0.0:8080 (+ walkers demo over HTTP)
HOST=127.0.0.1 PORT=8080 bun run vibinet-ts/src/server.ts # behind a reverse proxy
```

Then point clients at it: `server: "ws://localhost:8080"`.

Operational facts:

- Storage: `data/<code>.dat` + `data/<code>.idx` at the repo root,
  append-only, one pair per room (`<code>` = the room's 64-bit id as 16 hex
  digits). Delete both files to reset a room; a deleted `.idx` is rebuilt
  from the `.dat` on demand.
- Env: `PORT` (8080), `HOST` (0.0.0.0), `CHECKPOINT_MS` (1000 — the
  checkpoint period; lower shrinks the clients' pending window at the cost
  of chattier broadcasts).
- WebSocket frames are capped at 64 KB (posts are inputs; they should be
  tiny).
- Client and server must run the **same VibiNet version** — the wire
  protocol is not stable across minor versions.
- Pages served over HTTPS must use `wss://` (browsers block mixed content;
  the client auto-upgrades `http(s)://` URLs to `ws(s)://` and warns).
- For TLS, put caddy/nginx in front (production setup, systemd units, and
  auto-deploy live in `devs/scripts/` — see `AGENTS.md`).
- Malformed frames are ignored (never crash); rooms are 64-bit ids so
  there's nothing to validate server-side.

The official server (`wss://net.studiovibi.com`, the default) runs exactly
this code, synced to the repo's `main` branch.

## 13. Testing Your Game Headlessly

Because everything is pure, your whole game is testable without a browser,
a server, or a socket.

**Test your fold directly.** `on_tick`/`on_post` are plain functions:

```ts
import { test, expect } from "bun:test";

test("dots move", () => {
  let s = on_post({ $: "spawn", pid: 1 }, initial);
  s = on_post({ $: "moved", pid: 1, dx: 1, dy: 0 }, s);
  s = on_tick(s);
  expect(s[1].x).toBe(204);
});
```

**Test order-invariance and determinism with the pure engine.** The replay
core is exported (`engine_new`, `engine_step`, `engine_state_at`,
`engine_check` from `vibinet.ts`): feed it posts in different arrival
orders and assert identical states. `devs/test/engine.test.ts` is a
ready-made template of such property tests.

**Simulate a whole room.** `VibiNet.game` accepts a `client` option — an
injectable transport implementing `ClientApi` — so you can run N clients
against a simulated lossy/laggy network in one process, no IO at all.
`devs/test/sim_network.ts` implements one (random latency, reorder,
disconnects) and `devs/test/vibi_sim.test.ts` shows N clients converging
to equal state hashes. Copy that pattern for your game.

**Test the wire schema.** Round-trip your packer:

```ts
const bytes = packed_encode(packer, { $: "moved", pid: 7, dx: -1, dy: 1 });
expect(packed_decode(packer, bytes)).toEqual({ $: "moved", pid: 7, dx: -1, dy: 1 });
```

Run everything with `bun test`.

## 14. API Reference

Everything is exported from `vibinet-ts/src/client.ts` (which re-exports
the entire pure core from `vibinet.ts`).

### `new VibiNet.game<S, P>(options)`

`S` = your state type, `P` = your post type. (`VibiNet.game` is the class
itself; `new VibiNet(...)` is identical.)

| Option | Type | Default | Meaning |
|---|---|---|---|
| `room` | `string` | required | Room nick (`"JohnBear#15FF"`; `.` accepted for `#`). |
| `initial` | `S` | required | State before the first post. |
| `on_tick` | `(s: S) => S` | required | Advance one tick. Pure. |
| `on_post` | `(p: P, s: S) => S` | required | Apply one input. Pure. With `auth`, `p` carries `$user`/`$nick`. |
| `packer` | `Packed` | required | Wire schema for `P`. |
| `tick_rate` | `number` | required | Ticks per second. |
| `tolerance` | `number` | required | Max ms an input may land in the past. |
| `server` | `string` | official server | WebSocket URL; `http(s)://` auto-upgrades. |
| `smooth` | `(remote: S, local: S) => S` | `(r, l) => r` | Blend stable past + predicted present. |
| `check_stride` | `number` | `64` | Ticks between desync checksums. |
| `on_desync` | `(info: Desync) => void` | none | Called once on hash mismatch. |
| `client` | `ClientApi<P>` | real WebSocket | Injectable transport (tests). |
| `auth` | `boolean` | `false` | Fold the identity envelope. Room-wide protocol choice. |
| `user` | `User` | none | Sign outgoing posts (requires `auth: true`). |

### Methods

| Method | Returns | Meaning |
|---|---|---|
| `on_sync(cb)` | `void` | Run `cb` once time-synced (immediately if already). Don't `post` before this. |
| `post(data)` | `void` | Send an input; applies locally instantly. Throws before sync. Queued while offline. |
| `compute_render_state()` | `S` | What to draw this frame: `smooth(remote, local)`. |
| `compute_current_state()` | `S` | State at the current server tick (with prediction). |
| `compute_state_at(tick)` | `S` | State at any tick ≥ `finalized_tick()` (earlier clamps). |
| `server_time()` | `number` | Synced server clock, ms. Throws before sync. |
| `server_tick()` | `number` | `time_to_tick(server_time())`. |
| `time_to_tick(ms)` | `number` | `floor(ms * tick_rate / 1000)`. |
| `ping()` | `number` | Smoothed RTT ms (`Infinity` before first sample). |
| `post_count()` | `number` | Posts seen in the room so far. |
| `initial_tick()` | `number \| null` | Tick of the room's first post. |
| `finalized_tick()` | `number \| null` | Newest never-rolls-back tick. |
| `desync()` | `Desync \| null` | Set if a peer's hash disagreed with ours. |
| `close()` | `void` | Unwatch and disconnect. |
| `debug_dump()` | `unknown` | Engine + transport introspection. |
| `VibiNet.nick_gen()` | `string` | Static: fresh random room nick. |

### Function exports

- **Rooms/nicks**: `nick_gen`, `nick_read`, `nick_show`, `nick_norm`,
  `nick_link`, `nick_hex`.
- **Identity**: `user_new`, `user_init`, `user_load`, `user_save`,
  `user_addr`, `user_nick`, `addr_nick`; `sig_make`, `sig_addr`;
  `chain_new`, `chain_head`, `chain_pass`, `chain_verify`; `auth_config`,
  `auth_packed`; `name_set`, `name_get`, `name_valid`, `claim_make`,
  `claim_addr`, `claim_fold`.
- **Pure core**: `engine_new`, `engine_step`, `engine_state_at`,
  `engine_check`, `packed_encode`, `packed_decode`, `message_encode`,
  `message_decode`, `time_to_tick`, `state_hash`, ...
- **Transport**: `client_new(server?)` — the raw `ClientApi` (reconnect,
  time sync, watch/post); only needed for custom shells or tests.
- **Constants**: `OFFICIAL_SERVER_URL` (`"wss://net.studiovibi.com"`),
  `CHAIN_SIZE`.
- **Types**: `Packed`, `Options<S, P>`, `ClientApi<P>`, `Event<P>`,
  `Engine<S, P>`, `Config<S, P>`, `Desync`, `User`, `Address`, `Signature`,
  `Auth`, `Envelope<P>`, `AuthState`, `Meta`, `Claim`.

## 15. Checklist and Gotchas

Before shipping, check:

- [ ] `on_tick`/`on_post` are pure and deterministic (section 6's 8 rules).
- [ ] `on_post` tolerates every possible post without throwing.
- [ ] All clients share identical room config (logic, packer, rates, auth).
- [ ] State is JSON-safe plain data (no bigints/Maps/classes/undefined).
- [ ] You only `post()` after `on_sync` fired.
- [ ] Posts are intentions (inputs), not outcomes (positions).
- [ ] `smooth` takes *you* from `local`, others from `remote`.
- [ ] Auth games ignore `$user == null` posts (or handle them on purpose).
- [ ] Names are rendered with their nick, and never influence game state.
- [ ] New match ⇒ new room (`nick_gen()`); new game version ⇒ new rooms.

Common surprises:

- **Union tags sort alphabetically** — renaming a post variant is a wire
  format change.
- **`Map` packed type decodes to a `Map`**, even if you encoded a plain
  object.
- **`compute_state_at` clamps below `finalized_tick()`** — old history is
  gone by design.
- **Rooms are public**: anyone with the nick can read and post. Don't put
  secrets in posts; use fresh unguessable nicks for private matches.
- **The server is trusted for ordering, not for content** — it can't forge
  a user's posts (auth), but it assigns timestamps and order.
- **Wire protocol changes across versions**: matching client/server
  versions are required; old rooms' stored posts don't survive breaking
  upgrades.
- **A room's log is append-only and grows forever** on the server's disk;
  clients stay bounded, but reset rooms you no longer need (delete their
  `data/` pair) if you self-host.

Happy hacking. For the library's internals — engine invariants, frontier
proofs, file-by-file architecture — read `AGENTS.md` and the comments in
`vibinet-ts/src/vibinet.ts`; for a complete worked example, read
`demo/walkers/index.ts`.
