import { create_client, ClientApi, gen_name as gen_name_impl } from "./client.ts";
import type { Packed as PackedType } from "./packer.ts";

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
// are not discarded: compute_state_at is clamped to a safety frontier so
// pruning only removes history proven complete from the server.
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
  packer: PackedType;
  tick_rate: number;
  tolerance: number;
  smooth?: (remote: S, local: S) => S;
  cache?: boolean;
  snapshot_stride?: number;
  snapshot_count?: number;
  client?: ClientApi<P>;
};

type DebugPostDump<P> = {
  room: string;
  index: number;
  server_time: number;
  client_time: number;
  name?: string;
  official_time: number;
  official_tick: number;
  data: P;
};

type DebugTimelineBucketDump<P> = {
  tick: number;
  remote_count: number;
  local_count: number;
  remote_posts: DebugPostDump<P>[];
  local_posts: DebugPostDump<P>[];
};

type DebugSnapshotDump<S> = {
  tick: number;
  state: S;
};

export type VibiNetDebugDump<S, P> = {
  room: string;
  tick_rate: number;
  tolerance: number;
  cache_enabled: boolean;
  snapshot_stride: number;
  snapshot_count: number;
  snapshot_start_tick: number | null;
  no_pending_posts_before_ms: number | null;
  max_contiguous_remote_index: number;
  initial_time: number | null;
  initial_tick: number | null;
  max_remote_index: number;
  post_count: number;
  server_time: number | null;
  server_tick: number | null;
  ping: number;
  history_truncated: boolean;
  cache_drop_guard_hits: number;
  counts: {
    remote_posts: number;
    local_posts: number;
    timeline_ticks: number;
    snapshots: number;
  };
  ranges: {
    timeline_min_tick: number | null;
    timeline_max_tick: number | null;
    snapshot_min_tick: number | null;
    snapshot_max_tick: number | null;
    min_remote_index: number | null;
    max_remote_index: number | null;
  };
  remote_posts: DebugPostDump<P>[];
  local_posts: DebugPostDump<P>[];
  timeline: DebugTimelineBucketDump<P>[];
  snapshots: DebugSnapshotDump<S>[];
  client_debug: unknown;
};

export type VibiNetRecomputeDump<S> = {
  target_tick: number;
  initial_tick: number | null;
  cache_invalidated: boolean;
  invalidated_snapshot_count: number;
  history_truncated: boolean;
  state: S;
  notes: string[];
};

export class VibiNet<S, P> {
  static game = VibiNet;
  room:                string;
  init:                S;
  on_tick:             (state: S) => S;
  on_post:             (post: P, state: S) => S;
  packer:              PackedType;
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
  no_pending_posts_before_ms: number | null;
  max_contiguous_remote_index: number;
  cache_drop_guard_hits: number;
  latest_index_poll_interval_id: ReturnType<typeof setInterval> | null;
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
    const safe_prune_tick = this.safe_prune_tick();
    if (safe_prune_tick !== null && prune_tick > safe_prune_tick) {
      this.cache_drop_guard_hits += 1;
      prune_tick = safe_prune_tick;
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

  private tick_ms(): number {
    return 1000 / this.tick_rate;
  }

  private cache_window_ticks(): number {
    return this.snapshot_stride * Math.max(0, this.snapshot_count - 1);
  }

  private safe_prune_tick(): number | null {
    if (this.no_pending_posts_before_ms === null) {
      return null;
    }
    return this.time_to_tick(this.no_pending_posts_before_ms);
  }

  private safe_compute_tick(requested_tick: number): number {
    if (!this.cache_enabled) {
      return requested_tick;
    }
    const safe_prune_tick = this.safe_prune_tick();
    if (safe_prune_tick === null) {
      return requested_tick;
    }
    const safe_tick =
      safe_prune_tick +
      this.cache_window_ticks();
    return Math.min(requested_tick, safe_tick);
  }

  private advance_no_pending_posts_before_ms(candidate: number): void {
    const bounded = Math.max(0, Math.floor(candidate));
    if (
      this.no_pending_posts_before_ms === null ||
      bounded > this.no_pending_posts_before_ms
    ) {
      this.no_pending_posts_before_ms = bounded;
    }
  }

  private advance_contiguous_remote_frontier(): void {
    for (;;) {
      const next_index = this.max_contiguous_remote_index + 1;
      const post = this.remote_posts.get(next_index);
      if (!post) {
        break;
      }
      this.max_contiguous_remote_index = next_index;
      this.advance_no_pending_posts_before_ms(this.official_time(post));
    }
  }

  private on_latest_post_index_info(info: {
    room: string;
    latest_index: number;
    server_time: number;
  }): void {
    if (info.room !== this.room) {
      return;
    }
    if (info.latest_index > this.max_contiguous_remote_index) {
      return;
    }
    const conservative_margin = this.tick_ms();
    const candidate =
      info.server_time -
      this.tolerance -
      conservative_margin;
    this.advance_no_pending_posts_before_ms(candidate);
  }

  private request_latest_post_index(): void {
    if (!this.client_api.get_latest_post_index) {
      return;
    }
    try {
      this.client_api.get_latest_post_index(this.room);
    } catch {
      // Socket may be temporarily unavailable. Retry on next poll.
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

    if (this.remote_posts.has(post.index)) {
      return;
    }

    const before_window =
      this.cache_enabled &&
      this.snapshot_start_tick !== null &&
      tick < this.snapshot_start_tick;
    if (before_window) {
      this.cache_drop_guard_hits += 1;
      this.snapshots.clear();
      this.snapshot_start_tick = null;
    }

    this.remote_posts.set(post.index, post);
    if (post.index > this.max_remote_index) {
      this.max_remote_index = post.index;
    }
    this.advance_contiguous_remote_frontier();
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
      this.cache_drop_guard_hits += 1;
      this.snapshots.clear();
      this.snapshot_start_tick = null;
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

  private post_to_debug_dump(post: Post<P>): DebugPostDump<P> {
    return {
      room: post.room,
      index: post.index,
      server_time: post.server_time,
      client_time: post.client_time,
      name: post.name,
      official_time: this.official_time(post),
      official_tick: this.official_tick(post),
      data: post.data,
    };
  }

  private timeline_tick_bounds(): { min: number | null; max: number | null } {
    let min: number | null = null;
    let max: number | null = null;
    for (const tick of this.timeline.keys()) {
      if (min === null || tick < min) {
        min = tick;
      }
      if (max === null || tick > max) {
        max = tick;
      }
    }
    return { min, max };
  }

  private snapshot_tick_bounds(): { min: number | null; max: number | null } {
    let min: number | null = null;
    let max: number | null = null;
    for (const tick of this.snapshots.keys()) {
      if (min === null || tick < min) {
        min = tick;
      }
      if (max === null || tick > max) {
        max = tick;
      }
    }
    return { min, max };
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
    this.no_pending_posts_before_ms = null;
    this.max_contiguous_remote_index = -1;
    this.cache_drop_guard_hits = 0;
    this.latest_index_poll_interval_id = null;
    this.max_remote_index     = -1;

    if (this.client_api.on_latest_post_index) {
      this.client_api.on_latest_post_index((info) => {
        this.on_latest_post_index_info(info);
      });
    }

    // Wait for initial time sync before interacting with server
    this.client_api.on_sync(() => {
      console.log(`[VIBI] synced; loading+watching room=${this.room}`);
      const on_info_post = (post: Post<P>) => {
        // If this official post matches a local predicted one, drop the local
        // copy.
        if (post.name) {
          this.remove_local_post(post.name);
        }
        this.add_remote_post(post);
      };

      // Load all existing posts before enabling live stream.
      this.client_api.load(this.room, 0, this.packer, on_info_post);
      this.client_api.watch(this.room, this.packer, on_info_post);
      this.request_latest_post_index();
      if (this.latest_index_poll_interval_id !== null) {
        clearInterval(this.latest_index_poll_interval_id);
      }
      this.latest_index_poll_interval_id = setInterval(() => {
        this.request_latest_post_index();
      }, 2000);
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
    at_tick = this.safe_compute_tick(at_tick);
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

  debug_dump(): VibiNetDebugDump<S, P> {
    const remote_posts = Array
      .from(this.remote_posts.values())
      .sort((a, b) => a.index - b.index)
      .map((post) => this.post_to_debug_dump(post));
    const local_posts = Array
      .from(this.local_posts.values())
      .sort((a, b) => {
        const ta = this.official_tick(a);
        const tb = this.official_tick(b);
        if (ta !== tb) {
          return ta - tb;
        }
        const na = a.name ?? "";
        const nb = b.name ?? "";
        return na.localeCompare(nb);
      })
      .map((post) => this.post_to_debug_dump(post));
    const timeline = Array
      .from(this.timeline.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([tick, bucket]) => ({
        tick,
        remote_count: bucket.remote.length,
        local_count: bucket.local.length,
        remote_posts: bucket.remote.map((post) => this.post_to_debug_dump(post)),
        local_posts: bucket.local.map((post) => this.post_to_debug_dump(post)),
      }));
    const snapshots = Array
      .from(this.snapshots.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([tick, state]) => ({ tick, state }));

    const initial_time = this.initial_time();
    const initial_tick = this.initial_tick();
    const timeline_bounds = this.timeline_tick_bounds();
    const snapshot_bounds = this.snapshot_tick_bounds();
    const history_truncated =
      initial_tick !== null &&
      timeline_bounds.min !== null &&
      timeline_bounds.min > initial_tick;

    let server_time: number | null = null;
    let server_tick: number | null = null;
    try {
      server_time = this.server_time();
      server_tick = this.server_tick();
    } catch {
      server_time = null;
      server_tick = null;
    }

    let min_remote_index: number | null = null;
    let max_remote_index: number | null = null;
    for (const index of this.remote_posts.keys()) {
      if (min_remote_index === null || index < min_remote_index) {
        min_remote_index = index;
      }
      if (max_remote_index === null || index > max_remote_index) {
        max_remote_index = index;
      }
    }

    const client_debug =
      typeof this.client_api.debug_dump === "function"
        ? this.client_api.debug_dump()
        : null;

    return {
      room: this.room,
      tick_rate: this.tick_rate,
      tolerance: this.tolerance,
      cache_enabled: this.cache_enabled,
      snapshot_stride: this.snapshot_stride,
      snapshot_count: this.snapshot_count,
      snapshot_start_tick: this.snapshot_start_tick,
      no_pending_posts_before_ms: this.no_pending_posts_before_ms,
      max_contiguous_remote_index: this.max_contiguous_remote_index,
      initial_time,
      initial_tick,
      max_remote_index: this.max_remote_index,
      post_count: this.post_count(),
      server_time,
      server_tick,
      ping: this.ping(),
      history_truncated,
      cache_drop_guard_hits: this.cache_drop_guard_hits,
      counts: {
        remote_posts: this.remote_posts.size,
        local_posts: this.local_posts.size,
        timeline_ticks: this.timeline.size,
        snapshots: this.snapshots.size,
      },
      ranges: {
        timeline_min_tick: timeline_bounds.min,
        timeline_max_tick: timeline_bounds.max,
        snapshot_min_tick: snapshot_bounds.min,
        snapshot_max_tick: snapshot_bounds.max,
        min_remote_index,
        max_remote_index,
      },
      remote_posts,
      local_posts,
      timeline,
      snapshots,
      client_debug,
    };
  }

  debug_recompute(at_tick?: number): VibiNetRecomputeDump<S> {
    const initial_tick = this.initial_tick();
    const timeline_bounds = this.timeline_tick_bounds();
    const history_truncated =
      initial_tick !== null &&
      timeline_bounds.min !== null &&
      timeline_bounds.min > initial_tick;

    let target_tick = at_tick;
    if (target_tick === undefined) {
      try {
        target_tick = this.server_tick();
      } catch {
        target_tick = undefined;
      }
    }
    if (target_tick === undefined) {
      target_tick = initial_tick ?? 0;
    }

    const invalidated_snapshot_count = this.snapshots.size;
    this.snapshots.clear();
    this.snapshot_start_tick = null;

    const notes: string[] = [];
    if (history_truncated) {
      notes.push(
        "Local history before timeline_min_tick was pruned; full room replay may be impossible without reloading posts."
      );
    }

    if (initial_tick === null || target_tick < initial_tick) {
      notes.push("No replayable post range available at target tick.");
      return {
        target_tick,
        initial_tick,
        cache_invalidated: true,
        invalidated_snapshot_count,
        history_truncated,
        state: this.init,
        notes,
      };
    }

    const state = this.compute_state_at_uncached(initial_tick, target_tick);
    return {
      target_tick,
      initial_tick,
      cache_invalidated: true,
      invalidated_snapshot_count,
      history_truncated,
      state,
      notes,
    };
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

  close(): void {
    if (this.latest_index_poll_interval_id !== null) {
      clearInterval(this.latest_index_poll_interval_id);
      this.latest_index_poll_interval_id = null;
    }
    this.client_api.close();
  }

  static gen_name(): string {
    return gen_name_impl();
  }
}

export namespace VibiNet {
  export type Packed = PackedType;
  export type Options<S, P> = VibiNetOptions<S, P>;
  export type DebugDump<S, P> = VibiNetDebugDump<S, P>;
  export type RecomputeDump<S> = VibiNetRecomputeDump<S>;
}
