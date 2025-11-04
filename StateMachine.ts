import * as client from "./client.ts";

type Post<P> = {
  room: string;
  index: number;
  server_time: number;
  client_time: number;
  data: P;
};

export class StateMachine<S, P> {
  room: string;
  init: S;
  on_tick: (state: S) => S;
  on_post: (post: P, state: S) => S;
  ticks_per_second: number;
  tolerance: number;
  room_posts: Map<number, Post<P>>;

  constructor(
    room: string,
    init: S,
    on_tick: (state: S) => S,
    on_post: (post: P, state: S) => S,
    ticks_per_second: number,
    tolerance: number
  ) {
    this.room = room;
    this.init = init;
    this.on_tick = on_tick;
    this.on_post = on_post;
    this.ticks_per_second = ticks_per_second;
    this.tolerance = tolerance;
    this.room_posts = new Map();

    // Watch the room with callback
    client.watch(this.room, (post) => {
      this.room_posts.set(post.index, post);
    });

    // Load all existing posts
    client.load(this.room, 0);
  }

  time_to_tick(server_time: number): number {
    return Math.floor(server_time / this.ticks_per_second);
  }

  server_time(): number {
    return client.server_time();
  }

  server_tick(): number {
    return this.time_to_tick(this.server_time());
  }

  initial_time(): number | null {
    const post = this.room_posts.get(0);
    if (!post) {
      return null;
    }
    return post.server_time;
  }

  initial_tick(): number | null {
    const time = this.initial_time();
    if (time === null) {
      return null;
    }
    return this.time_to_tick(time);
  }

  compute_state_at(at_tick: number): S {
    const initial_tick = this.initial_tick();

    // If no posts, return initial state
    if (initial_tick === null) {
      return this.init;
    }

    // If requested tick is before initial tick, return initial state
    if (at_tick < initial_tick) {
      return this.init;
    }

    // Build timeline: Map from tick to array of posts
    const timeline = new Map<number, Post<P>[]>();

    for (const post of this.room_posts.values()) {
      // Compute official time for this post
      let official_time: number;
      if (post.client_time <= post.server_time - this.tolerance) {
        official_time = post.server_time - this.tolerance;
      } else {
        official_time = post.client_time;
      }

      // Compute official tick
      const official_tick = this.time_to_tick(official_time);

      // Add post to timeline
      if (!timeline.has(official_tick)) {
        timeline.set(official_tick, []);
      }
      timeline.get(official_tick)!.push(post);
    }

    // Sort posts within each tick by index
    for (const posts of timeline.values()) {
      posts.sort((a, b) => a.index - b.index);
    }

    // Compute state from initial tick to requested tick
    let state = this.init;

    for (let tick = initial_tick; tick <= at_tick; tick++) {
      // Apply on_tick
      state = this.on_tick(state);

      // Apply all posts for this tick
      const posts = timeline.get(tick) || [];
      for (const post of posts) {
        state = this.on_post(post.data, state);
      }
    }

    return state;
  }
}
