# VibiNet: Build an Online Game

VibiNet is deterministic input-synced netcode for real-time browser games.
You write your game as two pure functions; VibiNet does all networking.
Only inputs ("posts") travel: the server orders them, every client
replays the same stream through the same pure functions and computes the
same state. Your own inputs apply instantly (prediction); late remote
inputs roll back and replay automatically. The server runs no game logic;
by default clients use the official one (wss://net.studiovibi.com), so
games ship with no backend.

```ts
import { VibiNet, nick_gen } from "vibinet/vibinet-ts/src/client.ts";
```

## Complete example (dots moving with WASD)

```ts
type Dot   = { x: number; y: number; dx: number; dy: number };
type State = { [pid: string]: Dot };
type Post  = { $: "spawn"; pid: number }
           | { $: "moved"; pid: number; dx: number; dy: number };

const initial: State = {};

// One simulation step (pure: never mutate).
function on_tick(s: State): State {
  const out: State = {};
  for (const k of Object.keys(s).sort()) {
    out[k] = { ...s[k], x: s[k].x + s[k].dx * 4, y: s[k].y + s[k].dy * 4 };
  }
  return out;
}

// Apply one input (pure). Must tolerate ANY post without throwing.
function on_post(p: Post, s: State): State {
  switch (p.$) {
    case "spawn": return s[p.pid] ? s : { ...s, [p.pid]: { x: 200, y: 200, dx: 0, dy: 0 } };
    case "moved": return s[p.pid] ? { ...s, [p.pid]: { ...s[p.pid], dx: p.dx, dy: p.dy } } : s;
  }
}

// Wire schema for Post (see Packed below).
const packer: VibiNet.Packed = { $: "Union", variants: {
  spawn: { $: "Struct", fields: { pid: { $: "UInt", size: 16 } } },
  moved: { $: "Struct", fields: { pid: { $: "UInt", size: 16 },
    dx: { $: "Int", size: 2 }, dy: { $: "Int", size: 2 } } },
}};

const me   = Math.floor(Math.random() * 65536); // this tab's player id
const game = new VibiNet.game<State, Post>({
  room: new URLSearchParams(location.search).get("room") ?? nick_gen(),
  initial, on_tick, on_post, packer,
  tick_rate: 24,   // ticks per second
  tolerance: 300,  // ms an input may land in the past
  // render: yourself from predicted present, others from stable past:
  smooth: (remote, local) => local[me] ? { ...remote, [me]: local[me] } : remote,
  // server: "ws://localhost:8080", // omit = official server
});

game.on_sync(() => { // never post() before this fires
  game.post({ $: "spawn", pid: me });
  // then post {$:"moved"} on key edges (not every frame)
});

function frame() {
  const s = game.compute_render_state();
  // ...draw s on a canvas...
  requestAnimationFrame(frame);
}
frame();
```

Bundle with `bun build game.ts --outdir dist --target=browser
--format=esm` and load from a static HTML page. Tabs sharing ?room= stay
in sync; late joiners replay the log.

## Determinism rules (violations desync clients)

- on_tick/on_post: pure, deterministic, never mutate the given state.
- No Math.random, no Date.now, no reads outside (state, post).
- No Math.sin/cos/sqrt/pow/etc (not bit-exact across engines); float
  + - * / is exact and fine. Randomness: keep a PRNG seed in state
  (xorshift32), seeded from post data. Timers: count ticks in state.
  Trig: fixed-point math or literal tables.
- Sort object keys before iterating when order matters.
- State must be JSON-safe plain data: no bigint, Map, class, undefined.
- Every client of a room MUST use identical initial, on_tick, on_post,
  packer, tick_rate, tolerance, auth. New game version => new rooms.
- Posts are intentions ("pressed left"), never outcomes ("x is now 120").

## Options

Required: room, initial, on_tick, on_post, packer, tick_rate, tolerance
(higher = fairer under lag, laggier remote view). Optional: server,
smooth (default returns remote), check_stride (ticks between desync
hashes, 64), on_desync, auth (false), user.

## Methods

- on_sync(cb): runs cb once time-synced; post() before it throws.
- post(p): send input; applies locally instantly; queued while offline.
- compute_render_state(): smooth(stable past, predicted present). Remote
  players show ~tolerance ms in the past by design (never rolls back).
- compute_current_state() / compute_state_at(tick): with prediction;
  ticks below finalized_tick() clamp (history folded away).
- server_time(), server_tick(), ping(), post_count(), desync(), close(),
  debug_dump(). Reconnection, time sync and rollback are automatic.

## Packed schemas

- { $: "Struct", fields: {a: T, ...} } -- object; fields in key order.
- { $: "Tuple", fields: [T, ...] }, { $: "Vector", size: N, type: T },
  { $: "List", type: T } -- arrays (fixed shape / fixed length / any).
- { $: "Map", key: K, value: V } -- always decodes to a Map.
- { $: "Union", variants: {tag: T, ...} } -- value is { $: "tag", ...fields }
  for Struct variants, { $: "tag", value: v } otherwise. Tag ids come from
  SORTING variant names: renaming a variant changes the wire format.
- { $: "String" } -- UTF-8 string.
- { $: "UInt" | "Int", size: N } -- N-bit number (bigint if N > 53).
- { $: "Nat" } -- unary: tiny values only.
- { $: "Hex", size: N } -- 2N-hex-char string, N bytes on wire (for
  hashes/ids; keeps state JSON-safe).

Out-of-range values throw at encode. Keep sizes minimal.

## Rooms

A room id is 64 bits, written as a nick: up to 8 chars of [_a-zA-Z0-9$]
+ '#' + 4 hex digits ("JohnBear#15FF"; in URLs '.' replaces '#'). Rooms
need no creation: posting brings one into existence, and anyone with the
nick can read and post (no secrets in posts). Use a fresh nick_gen() per
match.

## Identity (optional, purely client-side)

Without auth, posts are anonymous: any client can claim any pid. With
auth, each post arrives tagged with the sender's verified address:

```ts
import { user_init, name_set, name_get } from "vibinet/vibinet-ts/src/client.ts";
const user = user_init();  // persistent keypair (localStorage)
const game = new VibiNet.game<State, Post>({
  auth: true,  // room-wide protocol choice: ALL clients must agree
  user,        // signs my posts; omit to post anonymously
  /* ...same options; posts no longer need a pid field... */
});
function on_post(p: Post & { $user?: string | null }, s: State): State {
  if (p.$user == null) return s;  // ignore anonymous/invalid (typical)
  // key players by p.$user (address "0x..."); p.$nick = short handle
}
```

With auth: true, posts must be objects. Forgery/replay/theft folds to
$user: null. Display names: `await name_set(user, "Alice_9")` publishes,
`await name_get(addr)` reads. Names are NOT unique and must never affect
game state; render name + nick: "Alice_9 (JohnBear#15FF)".

## Server

Default: the official wss://net.studiovibi.com (free). Self-host: `bun run vibinet-ts/src/server.ts` (env: PORT, HOST), then
pass server: "ws://localhost:8080". Client and server must run the same
vibinet version.

## Testing and debugging

Game logic is pure: unit test on_tick/on_post directly, no network.
Round-trip the packer: packed_decode(packer, packed_encode(packer, p)).
A desync means broken determinism or mismatched configs (see rules).
game.debug_dump() shows internals.
