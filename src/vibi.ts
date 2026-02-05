import { create_client, ClientApi, gen_name as gen_name_impl } from "./client.ts";
import type { Packed } from "./packer.ts";

// # VibiNet (deterministic replay engine)
// VibiNet computes deterministic game state by replaying ticks and events.
// State at tick T is: start at init, apply on_tick(state) for each tick,
// then apply on_post(post, state) for every event in that tick. on_tick
// and on_post must treat state as immutable; when caching is on,
// smooth() must also avoid mutating its inputs.
//
// ## Time and ticks
// Each post has client_time and server_time. official_time clamps early
// client times to server_time - tolerance; otherwise it uses
// client_time. official_tick = time_to_tick(official_time). Every client
// applies the same rule, so a post maps to the same tick everywhere.
//
// ## Remote vs local events
// VibiNet keeps two sources: remote_posts (authoritative server posts,
// keyed by index) and local_posts (predicted posts created locally for
// instant response). Timeline buckets map tick -> { remote[], local[] }.
// remote[] is sorted by post.index and applied first; local[] is applied
// after it. When a server echo arrives with the same name, the local
// post is removed so input is not applied twice. Duplicate remote posts
// with the same index are ignored.
//
// ## Rendering and smooth()
// Rendering uses two states. remote_state is the authoritative state at
// a past tick (latency-adjusted); local_state is the state at the
// current tick including local prediction. compute_render_state picks
// remote_tick = curr_tick - max(tolerance_ticks, half_rtt_ticks + 1),
// computes both states, then calls smooth(remote_state, local_state).
// If smooth is omitted, the default just returns remote_state.
// The game typically keeps remote players from remote_state and the
// local player from local_state to hide jitter without delaying input.
//
// ## Caching (bounded window, default on)
// With cache off, compute_state_at replays from initial_tick every call.
// With cache on, snapshots are stored every snapshot_stride ticks and
// only snapshot_count snapshots are kept (window = stride * count).
// compute_state_at starts from the nearest snapshot <= at_tick and
// advances at most (snapshot_stride - 1) ticks. Snapshots store state
// objects without cloning because state is treated as immutable.
// For testing, the client API can be injected; by default it uses
// ./client.ts.
//
// Snapshots are keyed by tick. When a post changes a tick within the
// window (add/remove, remote/local), snapshots at or after that tick
// are dropped immediately. The next compute_state_at rebuilds them
// forward from the last remaining snapshot. Posts older than the window
// are ignored, and timeline/post data before snapshot_start_tick is
// pruned to bound memory.
//
// ## Correctness sketch
// official_tick is deterministic given post fields and config. Remote
// posts are applied in index order; local posts are removed on echo, so
// no input is applied twice. Snapshot recomputation replays the same
// on_tick/on_post sequence as a full replay, so cached and uncached
// results match within the window. Ticks older than the window clamp to
// the oldest snapshot.
//
// ## Complexity
// Cache off: time O(ticks + posts), space O(posts).
// Cache on: time O(snapshot_stride) per call, space
// O(snapshot_count * |S| + posts_in_window).

type Post<P> = {
  room: string;
  index: number;
  server_time: number;
  client_time: number;
  name?: string; // unique id for dedup/reindex (optional for legacy)
  data: P;
};

type TimelineBucket<P> = {
  remote: Post<P>[];
  local: Post<P>[];
};

type VibiNetOptions<S, P> = {
  server?: string;
  room: string;
  initial: S;
  on_tick: (state: S) => S;
  on_post: (post: P, state: S) => S;
  packer: Packed;
  tick_rate: number;
  tolerance: number;
  smooth?: (remote: S, local: S) => S;
  cache?: boolean;
  snapshot_stride?: number;
  snapshot_count?: number;
  client?: ClientApi<P>;
};

export class VibiNet<S, P> {
  static game = VibiNet;
  room:                string;
  init:                S;
  on_tick:             (state: S) => S;
  on_post:             (post: P, state: S) => S;
  packer:              Packed;
  smooth:              (remote: S, local: S) => S;
  tick_rate:           number;
  tolerance:           number;
  client_api:          ClientApi<P>;
  remote_posts:        Map<number, Post<P>>;
  local_posts:         Map<string, Post<P>>;
  timeline:            Map<number, TimelineBucket<P>>;
  cache_enabled:       boolean;
  snapshot_stride:     number;
  snapshot_count:      number;
  snapshots:           Map<number, S>;
  snapshot_start_tick: number | null;
  initial_time_value:  number | null;
  initial_tick_value:  number | null;
  max_remote_index:    number;

  // Compute the authoritative time a post takes effect.
  private official_time(post: Post<P>): number {
    if (post.client_time <= post.server_time - this.tolerance) {
      return post.server_time - this.tolerance;
    } else {
      return post.client_time;
    }
  }

  // Convert a post into its authoritative tick.
  private official_tick(post: Post<P>): number {
    return this.time_to_tick(this.official_time(post));
  }

  // Get or create the timeline bucket for a tick.
  private get_bucket(tick: number): TimelineBucket<P> {
    let bucket = this.timeline.get(tick);
    if (!bucket) {
      bucket = { remote: [], local: [] };
      this.timeline.set(tick, bucket);
    }
    return bucket;
  }

  // Insert an authoritative post into a tick bucket (kept sorted by index).
  private insert_remote_post(post: Post<P>, tick: number): void {
    const bucket = this.get_bucket(tick);
    bucket.remote.push(post);
    bucket.remote.sort((a, b) => a.index - b.index);
  }

  // Drop snapshots at or after tick; earlier snapshots remain valid.
  private invalidate_from_tick(tick: number): void {
    if (!this.cache_enabled) {
      return;
    }
    const start_tick = this.snapshot_start_tick;
    if (start_tick !== null && tick < start_tick) {
      return;
    }
    if (start_tick === null || this.snapshots.size === 0) {
      return;
    }
    const stride = this.snapshot_stride;
    const end_tick = start_tick + (this.snapshots.size - 1) * stride;
    if (tick > end_tick) {
      return;
    }
    if (tick <= start_tick) {
      this.snapshots.clear();
      return;
    }
    for (let t = end_tick; t >= tick; t -= stride) {
      this.snapshots.delete(t);
    }
  }

  // Apply on_tick/on_post from (from_tick, to_tick] to advance a state.
  private advance_state(state: S, from_tick: number, to_tick: number): S {
    let next = state;
    for (let tick = from_tick + 1; tick <= to_tick; tick++) {
      next = this.apply_tick(next, tick);
    }
    return next;
  }

  // Drop all cached timeline/post data older than prune_tick.
  private prune_before_tick(prune_tick: number): void {
    if (!this.cache_enabled) {
      return;
    }
    for (const tick of this.timeline.keys()) {
      if (tick < prune_tick) {
        this.timeline.delete(tick);
      }
    }
    for (const [index, post] of this.remote_posts.entries()) {
      if (this.official_tick(post) < prune_tick) {
        this.remote_posts.delete(index);
      }
    }
    for (const [name, post] of this.local_posts.entries()) {
      if (this.official_tick(post) < prune_tick) {
        this.local_posts.delete(name);
      }
    }
  }

  // Ensure snapshots exist through at_tick, filling forward as needed.
  private ensure_snapshots(at_tick: number, initial_tick: number): void {
    if (!this.cache_enabled) {
      return;
    }
    if (this.snapshot_start_tick === null) {
      this.snapshot_start_tick = initial_tick;
    }
    let start_tick = this.snapshot_start_tick;
    if (start_tick === null) {
      return;
    }
    if (at_tick < start_tick) {
      return;
    }

    const stride = this.snapshot_stride;
    const target_tick =
      start_tick + Math.floor((at_tick - start_tick) / stride) * stride;
    let state: S;
    let current_tick: number;

    if (this.snapshots.size === 0) {
      state = this.init;
      current_tick = start_tick - 1;
    } else {
      const end_tick = start_tick + (this.snapshots.size - 1) * stride;
      state = this.snapshots.get(end_tick) as S;
      current_tick = end_tick;
    }

    let next_tick = current_tick + stride;
    if (this.snapshots.size === 0) {
      next_tick = start_tick;
    }
    for (; next_tick <= target_tick; next_tick += stride) {
      state = this.advance_state(state, current_tick, next_tick);
      this.snapshots.set(next_tick, state);
      current_tick = next_tick;
    }

    const count = this.snapshots.size;
    if (count > this.snapshot_count) {
      const overflow = count - this.snapshot_count;
      const drop_until = start_tick + overflow * stride;
      for (let t = start_tick; t < drop_until; t += stride) {
        this.snapshots.delete(t);
      }
      start_tick = drop_until;
      this.snapshot_start_tick = start_tick;
    }

    this.prune_before_tick(start_tick);
  }

  // Add or replace an authoritative post and update the timeline.
  private add_remote_post(post: Post<P>): void {
    const tick = this.official_tick(post);

    if (post.index === 0 && this.initial_time_value === null) {
      const t = this.official_time(post);
      this.initial_time_value = t;
      this.initial_tick_value = this.time_to_tick(t);
    }

    const before_window =
      this.cache_enabled &&
      this.snapshot_start_tick !== null &&
      tick < this.snapshot_start_tick;
    if (before_window) {
      if (post.index > this.max_remote_index) {
        this.max_remote_index = post.index;
      }
      return;
    }

    if (this.remote_posts.has(post.index)) {
      return;
    }

    this.remote_posts.set(post.index, post);
    if (post.index > this.max_remote_index) {
      this.max_remote_index = post.index;
    }
    this.insert_remote_post(post, tick);
    this.invalidate_from_tick(tick);
  }

  // Add a local predicted post (applied after remote posts for the same tick).
  private add_local_post(name: string, post: Post<P>): void {
    if (this.local_posts.has(name)) {
      this.remove_local_post(name);
    }

    const tick = this.official_tick(post);
    const before_window =
      this.cache_enabled &&
      this.snapshot_start_tick !== null &&
      tick < this.snapshot_start_tick;
    if (before_window) {
      return;
    }
    this.local_posts.set(name, post);
    this.get_bucket(tick).local.push(post);
    this.invalidate_from_tick(tick);
  }

  // Remove a local predicted post once the authoritative echo arrives.
  private remove_local_post(name: string): void {
    const post = this.local_posts.get(name);
    if (!post) {
      return;
    }
    this.local_posts.delete(name);

    const tick = this.official_tick(post);
    const bucket = this.timeline.get(tick);
    if (bucket) {
      const index = bucket.local.indexOf(post);
      if (index !== -1) {
        bucket.local.splice(index, 1);
      } else {
        const by_name = bucket.local.findIndex((p) => p.name === name);
        if (by_name !== -1) {
          bucket.local.splice(by_name, 1);
        }
      }
      if (bucket.remote.length === 0 && bucket.local.length === 0) {
        this.timeline.delete(tick);
      }
    }

    this.invalidate_from_tick(tick);
  }

  // Apply on_tick plus any posts for a single tick.
  private apply_tick(state: S, tick: number): S {
    let next = this.on_tick(state);
    const bucket = this.timeline.get(tick);
    if (bucket) {
      for (const post of bucket.remote) {
        next = this.on_post(post.data, next);
      }
      for (const post of bucket.local) {
        next = this.on_post(post.data, next);
      }
    }
    return next;
  }

  // Recompute state from scratch without caching.
  private compute_state_at_uncached(initial_tick: number, at_tick: number): S {
    let state = this.init;
    for (let tick = initial_tick; tick <= at_tick; tick++) {
      state = this.apply_tick(state, tick);
    }
    return state;
  }

  // Create a VibiNet instance and hook the client sync/load/watch callbacks.
  constructor(options: VibiNetOptions<S, P>) {
    const default_smooth = (remote: S, _local: S): S => remote;
    const smooth = options.smooth ?? default_smooth;
    const cache = options.cache ?? true;
    const snapshot_stride = options.snapshot_stride ?? 8;
    const snapshot_count = options.snapshot_count ?? 256;
    const client_api =
      options.client ??
      create_client<P>(options.server);

    // Initialize configuration, caches, and timeline.
    this.room                 = options.room;
    this.init                 = options.initial;
    this.on_tick              = options.on_tick;
    this.on_post              = options.on_post;
    this.packer               = options.packer;
    this.smooth               = smooth;
    this.tick_rate            = options.tick_rate;
    this.tolerance            = options.tolerance;
    this.client_api           = client_api;
    this.remote_posts         = new Map();
    this.local_posts          = new Map();
    this.timeline             = new Map();
    this.cache_enabled        = cache;
    this.snapshot_stride      = Math.max(1, Math.floor(snapshot_stride));
    this.snapshot_count       = Math.max(1, Math.floor(snapshot_count));
    this.snapshots            = new Map();
    this.snapshot_start_tick  = null;
    this.initial_time_value   = null;
    this.initial_tick_value   = null;
    this.max_remote_index     = -1;

    // Wait for initial time sync before interacting with server
    this.client_api.on_sync(() => {
      console.log(`[VIBI] synced; watching+loading room=${this.room}`);
      // Watch the room with callback.
      this.client_api.watch(this.room, this.packer, (post) => {
        // If this official post matches a local predicted one, drop the local
        // copy.
        if (post.name) {
          this.remove_local_post(post.name);
        }
        this.add_remote_post(post);
      });

      // Load all existing posts
      this.client_api.load(this.room, 0, this.packer);
    });
  }

  // Convert a server-time timestamp to a tick index.
  time_to_tick(server_time: number): number {
    return Math.floor((server_time * this.tick_rate) / 1000);
  }

  // Read the synchronized server time.
  server_time(): number {
    return this.client_api.server_time();
  }

  // Read the current server tick.
  server_tick(): number {
    return this.time_to_tick(this.server_time());
  }

  // Total authoritative remote posts seen so far.
  post_count(): number {
    return this.max_remote_index + 1;
  }

  // Build a render state from a past (remote) tick and current (local) tick.
  compute_render_state(): S {
    const curr_tick   = this.server_tick();
    const tick_ms     = 1000 / this.tick_rate;
    const tol_ticks   = Math.ceil(this.tolerance / tick_ms);
    const rtt_ms      = this.client_api.ping();
    const half_rtt    = isFinite(rtt_ms)
      ? Math.ceil((rtt_ms / 2) / tick_ms)
      : 0;
    const remote_lag  = Math.max(tol_ticks, half_rtt + 1);
    const remote_tick = Math.max(0, curr_tick - remote_lag);

    const remote_state = this.compute_state_at(remote_tick);
    const local_state  = this.compute_state_at(curr_tick);

    return this.smooth(remote_state, local_state);
  }

  // Return the authoritative time of the first post (index 0).
  initial_time(): number | null {
    if (this.initial_time_value !== null) {
      return this.initial_time_value;
    }
    const post = this.remote_posts.get(0);
    if (!post) {
      return null;
    }
    const t = this.official_time(post);
    this.initial_time_value = t;
    this.initial_tick_value = this.time_to_tick(t);
    return t;
  }

  // Return the authoritative tick of the first post (index 0).
  initial_tick(): number | null {
    if (this.initial_tick_value !== null) {
      return this.initial_tick_value;
    }
    const t = this.initial_time();
    if (t === null) {
      return null;
    }
    this.initial_tick_value = this.time_to_tick(t);
    return this.initial_tick_value;
  }

  // Compute state at an arbitrary tick, using snapshots when enabled.
  compute_state_at(at_tick: number): S {
    const initial_tick = this.initial_tick();

    if (initial_tick === null) {
      return this.init;
    }

    if (at_tick < initial_tick) {
      return this.init;
    }

    if (!this.cache_enabled) {
      return this.compute_state_at_uncached(initial_tick, at_tick);
    }

    this.ensure_snapshots(at_tick, initial_tick);

    const start_tick = this.snapshot_start_tick;
    if (start_tick === null || this.snapshots.size === 0) {
      return this.init;
    }

    if (at_tick < start_tick) {
      return this.snapshots.get(start_tick) ?? this.init;
    }

    const stride = this.snapshot_stride;
    const end_tick = start_tick + (this.snapshots.size - 1) * stride;
    const max_index = Math.floor((end_tick - start_tick) / stride);
    const snap_index = Math.floor((at_tick - start_tick) / stride);
    const index = Math.min(snap_index, max_index);
    const snap_tick = start_tick + index * stride;
    const base_state = this.snapshots.get(snap_tick) ?? this.init;
    return this.advance_state(base_state, snap_tick, at_tick);
  }

  // Post data to the room.
  post(data: P): void {
    const name = this.client_api.post(this.room, data, this.packer);
    const t    = this.server_time();

    const local_post: Post<P> = {
      room:        this.room,
      index:       -1,
      server_time: t,
      client_time: t,
      name,
      data
    };

    this.add_local_post(name, local_post);
  }

  // Convenience for compute_state_at(current_server_tick).
  compute_current_state(): S {
    return this.compute_state_at(this.server_tick());
  }

  on_sync(callback: () => void): void {
    this.client_api.on_sync(callback);
  }

  ping(): number {
    return this.client_api.ping();
  }

  static gen_name(): string {
    return gen_name_impl();
  }
}

export namespace VibiNet {
  export type Packed = Packed;
  export type Options<S, P> = VibiNetOptions<S, P>;
}
