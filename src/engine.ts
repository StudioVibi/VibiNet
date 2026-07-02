// engine.ts
//
// Pure deterministic replay core. No IO, no timers, no clocks, no mutation:
// every function takes values and returns new values. The shell (vibi.ts)
// owns all side effects and feeds this engine events.
//
// ## Model
//
// Game state at tick T is a fold:
//
//   state(T) = posts at tick t applied after on_tick, for t = initial..T
//
// Every post lands on its official_tick, computed from fields assigned by
// the server, so it is identical on every client:
//
//   official_time = max(client_time, server_time - tolerance)
//   official_tick = floor(official_time * tick_rate / 1000)
//
// ## Finalization (the cache)
//
// The engine keeps ONE folded state instead of a snapshot ring:
//
//   [ base_state at base_tick ]  +  [ pending posts, ~1-2s ]  ->  state_at(T)
//
// The frontier (frontier_ms) is a proven bound: no unseen post can land
// before it. It advances only by `server_time - tolerance` of contiguously
// received posts and of server checkpoints. (Never by official_time: that
// is not monotone in post index, since client_time may exceed server_time.)
// Everything strictly below the frontier tick is folded into base_state and
// discarded. A post landing below base is impossible by construction:
// server_time is monotone in index, delivery is contiguous, and
// official_time >= server_time - tolerance.
//
// ## Prediction
//
// Local posts apply immediately at their predicted tick and are replaced
// when the authoritative echo (matched by name) arrives. During replay a
// local post is clamped to >= base_tick + 1, which is exactly the earliest
// tick its echo could still land on.
//
// ## Checksums
//
// While folding, the engine records a hash of the finalized state every
// `check_stride` ticks (authoritative posts only, so it is identical on
// every client). Outgoing posts carry the newest hash; incoming posts'
// hashes are compared against the local ring. A mismatch sets `desync`.
//
// ## Costs
//
// step: O(pending) per event (copy-on-write maps) plus O(ticks folded).
// state_at: O(ticks since hint-or-base + pending). Rollback caused by a
// post at tick t inherently costs (now - t) ticks; deeper history could
// never help, because the post invalidates everything after t anyway.

export type Check = { tick: number; hash: number };

export type Desync = { tick: number; ours: number; theirs: number };

export type RemotePost<P> = {
  index: number;
  server_time: number;
  client_time: number;
  name?: string;
  check: Check | null;
  data: P;
};

export type LocalPost<P> = {
  name: string;
  client_time: number;
  data: P;
};

export type EngineEvent<P> =
  | { $: "post"; post: RemotePost<P> }
  | { $: "local_post"; post: LocalPost<P> }
  | { $: "checkpoint"; latest_index: number; server_time: number };

export type EngineConfig<S, P> = {
  initial: S;
  on_tick: (state: S) => S;
  on_post: (post: P, state: S) => S;
  tick_rate: number;
  tolerance: number;
  check_stride?: number; // ticks between finalized-state checksums (default 64)
};

export type Engine<S, P> = {
  base_state: S;              // fold of all ticks <= base_tick (final)
  base_tick: number | null;   // null until post 0 anchors the room
  initial_tick: number | null;
  frontier_ms: number;        // no unseen post can land before this time
  next_index: number;         // indices < next_index all received
  max_index: number;
  posts: Map<number, RemotePost<P>>;  // received, not yet folded
  locals: Map<string, LocalPost<P>>;  // predicted, awaiting echo
  checks: Check[];            // recent finalized-state hashes (ascending tick)
  desync: Desync | null;
};

const DEFAULT_CHECK_STRIDE = 64;
const CHECKS_KEPT = 4;
const LOCAL_TTL_MS = 5000; // drop locals whose echo never arrived

export function new_engine<S, P>(cfg: EngineConfig<S, P>): Engine<S, P> {
  return {
    base_state: cfg.initial,
    base_tick: null,
    initial_tick: null,
    frontier_ms: 0,
    next_index: 0,
    max_index: -1,
    posts: new Map(),
    locals: new Map(),
    checks: [],
    desync: null,
  };
}

export function time_to_tick<S, P>(cfg: EngineConfig<S, P>, ms: number): number {
  return Math.floor((ms * cfg.tick_rate) / 1000);
}

export function official_time<S, P>(
  cfg: EngineConfig<S, P>,
  post: { server_time: number; client_time: number }
): number {
  const floor = post.server_time - cfg.tolerance;
  return post.client_time <= floor ? floor : post.client_time;
}

export function official_tick<S, P>(
  cfg: EngineConfig<S, P>,
  post: { server_time: number; client_time: number }
): number {
  return time_to_tick(cfg, official_time(cfg, post));
}

export function latest_check<S, P>(engine: Engine<S, P>): Check | null {
  return engine.checks.length > 0 ? engine.checks[engine.checks.length - 1] : null;
}

// Apply one event. Pure: returns a new engine, never mutates the old one.
export function step<S, P>(
  cfg: EngineConfig<S, P>,
  engine: Engine<S, P>,
  event: EngineEvent<P>
): Engine<S, P> {
  switch (event.$) {
    case "post":       return add_post(cfg, engine, event.post);
    case "local_post": return add_local(engine, event.post);
    case "checkpoint": return add_checkpoint(cfg, engine, event);
  }
}

// Compute state at a tick. `hint` is an optional previously computed state
// (must be consistent with this engine's posts; the shell tracks validity).
// Ticks below base are unanswerable and clamp to base_state.
export function state_at<S, P>(
  cfg: EngineConfig<S, P>,
  engine: Engine<S, P>,
  tick: number,
  hint?: { tick: number; state: S }
): S {
  if (engine.base_tick === null || engine.initial_tick === null) {
    return cfg.initial;
  }
  if (tick < engine.initial_tick) {
    return cfg.initial;
  }
  let from = engine.base_tick;
  let state = engine.base_state;
  if (hint && hint.tick > from && hint.tick <= tick) {
    from = hint.tick;
    state = hint.state;
  }
  if (tick <= from) {
    return state; // tick at (or clamped to) the fold point
  }
  const buckets = build_buckets(cfg, engine, from + 1, tick, true);
  for (let t = from + 1; t <= tick; t++) {
    state = apply_tick(cfg, state, buckets.get(t));
  }
  return state;
}

// 32-bit FNV-1a over the canonical JSON of the state. Deterministic across
// clients because deterministic logic produces identical key order.
export function hash_state(state: unknown): number {
  const s = JSON.stringify(state);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

type Bucket<P> = { remote: RemotePost<P>[]; local: LocalPost<P>[] };

// Posts anchor the room at post 0's tick; a later post whose official_tick
// precedes it (extreme backdating) clamps to the anchor so no input is lost.
function post_tick<S, P>(
  cfg: EngineConfig<S, P>,
  initial_tick: number,
  post: RemotePost<P>
): number {
  return Math.max(official_tick(cfg, post), initial_tick);
}

function add_post<S, P>(
  cfg: EngineConfig<S, P>,
  engine: Engine<S, P>,
  post: RemotePost<P>
): Engine<S, P> {
  if (post.index < engine.next_index || engine.posts.has(post.index)) {
    return engine; // duplicate (already pending or already folded)
  }

  const posts = new Map(engine.posts);
  posts.set(post.index, post);

  // The authoritative echo replaces the local prediction.
  let locals = engine.locals;
  if (post.name !== undefined && locals.has(post.name)) {
    locals = new Map(locals);
    locals.delete(post.name);
  }

  // Advance the contiguous frontier over any newly gap-free indices.
  let next_index = engine.next_index;
  let frontier_ms = engine.frontier_ms;
  while (posts.has(next_index)) {
    const p = posts.get(next_index) as RemotePost<P>;
    frontier_ms = Math.max(frontier_ms, p.server_time - cfg.tolerance);
    next_index += 1;
  }

  // Compare the sender's finalized-state hash against ours.
  let desync = engine.desync;
  if (desync === null && post.check !== null) {
    const mine = engine.checks.find((c) => c.tick === post.check!.tick);
    if (mine && mine.hash !== post.check.hash) {
      desync = { tick: mine.tick, ours: mine.hash, theirs: post.check.hash };
    }
  }

  // Post 0 anchors the room's tick origin.
  let initial_tick = engine.initial_tick;
  let base_tick = engine.base_tick;
  if (post.index === 0 && initial_tick === null) {
    initial_tick = official_tick(cfg, post);
    base_tick = initial_tick - 1;
  }

  return finalize(cfg, {
    ...engine,
    posts,
    locals,
    next_index,
    max_index: Math.max(engine.max_index, post.index),
    frontier_ms,
    initial_tick,
    base_tick,
    desync,
  });
}

function add_local<S, P>(engine: Engine<S, P>, post: LocalPost<P>): Engine<S, P> {
  const locals = new Map(engine.locals);
  locals.set(post.name, post);
  return { ...engine, locals };
}

function add_checkpoint<S, P>(
  cfg: EngineConfig<S, P>,
  engine: Engine<S, P>,
  event: { latest_index: number; server_time: number }
): Engine<S, P> {
  // Only usable if we hold everything through latest_index: otherwise the
  // in-flight gap posts could have any (older) official time.
  if (event.latest_index >= engine.next_index) {
    return engine;
  }
  const frontier_ms = Math.max(engine.frontier_ms, event.server_time - cfg.tolerance);
  if (frontier_ms === engine.frontier_ms) {
    return engine;
  }
  return finalize(cfg, { ...engine, frontier_ms });
}

// Fold every tick strictly below the frontier tick into base_state, record
// checksums along the way, and discard the folded posts.
function finalize<S, P>(cfg: EngineConfig<S, P>, engine: Engine<S, P>): Engine<S, P> {
  if (engine.base_tick === null || engine.initial_tick === null) {
    return gc_locals(engine);
  }
  const target = time_to_tick(cfg, engine.frontier_ms) - 1;
  if (target <= engine.base_tick) {
    return gc_locals(engine);
  }

  // Authoritative posts only: base and checksums must match on all clients.
  const buckets = build_buckets(cfg, engine, engine.base_tick + 1, target, false);
  const stride = cfg.check_stride ?? DEFAULT_CHECK_STRIDE;
  const check_from = target - stride * CHECKS_KEPT; // skip hashing deep history
  let state = engine.base_state;
  let checks = engine.checks;
  for (let t = engine.base_tick + 1; t <= target; t++) {
    state = apply_tick(cfg, state, buckets.get(t));
    if (t % stride === 0 && t > check_from) {
      checks = [...checks, { tick: t, hash: hash_state(state) }];
      if (checks.length > CHECKS_KEPT) {
        checks = checks.slice(checks.length - CHECKS_KEPT);
      }
    }
  }

  const posts = new Map<number, RemotePost<P>>();
  for (const [index, post] of engine.posts) {
    if (post_tick(cfg, engine.initial_tick, post) > target) {
      posts.set(index, post);
    }
  }

  return gc_locals({ ...engine, base_state: state, base_tick: target, posts, checks });
}

// Drop stale predictions whose echo never arrived (they can no longer take
// effect anywhere near their predicted time).
function gc_locals<S, P>(engine: Engine<S, P>): Engine<S, P> {
  let stale: string[] | null = null;
  for (const [name, local] of engine.locals) {
    if (local.client_time < engine.frontier_ms - LOCAL_TTL_MS) {
      (stale ??= []).push(name);
    }
  }
  if (stale === null) {
    return engine;
  }
  const locals = new Map(engine.locals);
  for (const name of stale) {
    locals.delete(name);
  }
  return { ...engine, locals };
}

function build_buckets<S, P>(
  cfg: EngineConfig<S, P>,
  engine: Engine<S, P>,
  from: number,
  to: number,
  include_locals: boolean
): Map<number, Bucket<P>> {
  const initial_tick = engine.initial_tick as number;
  const buckets = new Map<number, Bucket<P>>();
  const bucket_at = (tick: number): Bucket<P> => {
    let bucket = buckets.get(tick);
    if (!bucket) {
      bucket = { remote: [], local: [] };
      buckets.set(tick, bucket);
    }
    return bucket;
  };
  for (const post of engine.posts.values()) {
    const tick = post_tick(cfg, initial_tick, post);
    if (tick >= from && tick <= to) {
      bucket_at(tick).remote.push(post);
    }
  }
  for (const bucket of buckets.values()) {
    bucket.remote.sort((a, b) => a.index - b.index);
  }
  if (include_locals) {
    for (const local of engine.locals.values()) {
      // Earliest tick the echo could still land on is base_tick + 1 = `from`.
      const tick = Math.max(time_to_tick(cfg, local.client_time), from);
      if (tick <= to) {
        bucket_at(tick).local.push(local);
      }
    }
  }
  return buckets;
}

function apply_tick<S, P>(
  cfg: EngineConfig<S, P>,
  state: S,
  bucket: Bucket<P> | undefined
): S {
  let next = cfg.on_tick(state);
  if (bucket) {
    for (const post of bucket.remote) {
      next = cfg.on_post(post.data, next);
    }
    for (const post of bucket.local) {
      next = cfg.on_post(post.data, next);
    }
  }
  return next;
}
