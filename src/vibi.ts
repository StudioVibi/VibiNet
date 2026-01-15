import * as client from "./client.ts";

type Post<P> = {
  room: string;
  index: number;
  server_time: number;
  client_time: number;
  name?: string; // unique id for dedup/reindex (optional for legacy)
  data: P;
};

export class Vibi<S, P> {
  room:        string;
  init:        S;
  on_tick:     (state: S) => S;
  on_post:     (post: P, state: S) => S;
  smooth:      (past: S, curr: S) => S;
  tick_rate:   number;
  tolerance:   number;
  room_posts:  Map<number, Post<P>>;
  local_posts: Map<string, Post<P>>; // predicted local posts keyed by name

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

  constructor(
    room:      string,
    init:      S,
    on_tick:   (state: S) => S,
    on_post:   (post: P, state: S) => S,
    smooth:    (past: S, curr: S) => S,
    tick_rate: number,
    tolerance: number
  ) {
    this.room        = room;
    this.init        = init;
    this.on_tick     = on_tick;
    this.on_post     = on_post;
    this.smooth      = smooth;
    this.tick_rate   = tick_rate;
    this.tolerance   = tolerance;
    this.room_posts  = new Map();
    this.local_posts = new Map();

    // Wait for initial time sync before interacting with server
    client.on_sync(() => {
      console.log(`[VIBI] synced; watching+loading room=${this.room}`);
      // Watch the room with callback
      client.watch(this.room, (post) => {
        // If this official post matches a local predicted one, drop the local copy
        if (post.name && this.local_posts.has(post.name)) {
          this.local_posts.delete(post.name);
        }
        this.room_posts.set(post.index, post);
      });

      // Load all existing posts
      client.load(this.room, 0);
    });
  }

  // No extra helpers needed with local_posts: simplicity preserved

  time_to_tick(server_time: number): number {
    return Math.floor((server_time * this.tick_rate) / 1000);
  }

  server_time(): number {
    return client.server_time();
  }

  server_tick(): number {
    return this.time_to_tick(this.server_time());
  }

  // Total official posts loaded for this room
  post_count(): number {
    return this.room_posts.size;
  }

  // Compute a render-ready state by blending authoritative past and current
  // using the provided smooth(past, curr) function.
  compute_render_state(): S {
    const curr_tick  = this.server_tick();
    const tick_ms    = 1000 / this.tick_rate;
    const tol_ticks  = Math.ceil(this.tolerance / tick_ms);
    const rtt_ms     = client.ping();
    const half_rtt   = isFinite(rtt_ms) ? Math.ceil((rtt_ms / 2) / tick_ms) : 0;
    const past_ticks = Math.max(tol_ticks, half_rtt + 1);
    const past_tick  = Math.max(0, curr_tick - past_ticks);

    const past_state = this.compute_state_at(past_tick);
    const curr_state = this.compute_state_at(curr_tick);

    return this.smooth(past_state, curr_state);
  }

  initial_time(): number | null {
    const post = this.room_posts.get(0);
    if (!post) {
      return null;
    }
    return this.official_time(post);
  }

  initial_tick(): number | null {
    const t = this.initial_time();
    if (t === null) {
      return null;
    }
    return this.time_to_tick(t);
  }

  compute_state_at(at_tick: number): S {
    const initial_tick = this.initial_tick();

    if (initial_tick === null) {
      return this.init;
    }

    if (at_tick < initial_tick) {
      return this.init;
    }

    const timeline = new Map<number, Post<P>[]>();

    for (const post of this.room_posts.values()) {
      const official_tick = this.official_tick(post);
      if (!timeline.has(official_tick)) {
        timeline.set(official_tick, []);
      }
      timeline.get(official_tick)!.push(post);
    }

    for (const post of this.local_posts.values()) {
      const official_tick = this.official_tick(post);
      if (!timeline.has(official_tick)) {
        timeline.set(official_tick, []);
      }
      const local_queued: Post<P> = { ...post, index: Number.MAX_SAFE_INTEGER };
      timeline.get(official_tick)!.push(local_queued);
    }

    for (const posts of timeline.values()) {
      posts.sort((a, b) => a.index - b.index);
    }

    let state = this.init;

    for (let tick = initial_tick; tick <= at_tick; tick++) {
      state = this.on_tick(state);

      const posts = timeline.get(tick) || [];
      for (const post of posts) {
        state = this.on_post(post.data, state);
      }
    }

    return state;
  }

  // Post data to the room
  post(data: P): void {
    const name = client.post(this.room, data);
    const t    = this.server_time();

    const local_post: Post<P> = {
      room:        this.room,
      index:       -1,
      server_time: t,
      client_time: t,
      name,
      data
    };

    this.local_posts.set(name, local_post);
  }

  compute_current_state(): S {
    return this.compute_state_at(this.server_tick());
  }
}
