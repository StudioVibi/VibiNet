import { test, expect } from "bun:test";
import { SimClient, SimNetwork, SimPost, create_rng } from "./sim_network.ts";
import {
  Post,
  State,
  TICK_RATE,
  TOLERANCE,
  initial,
  on_post,
  on_tick,
  packer,
} from "./walkers_game.ts";

const { VibiNet } = await import("../src/vibi.ts");

const ROOM = "desync-regression-room";
const PROFILE = {
  uplink_ms: 5,
  downlink_ms: 40,
  jitter_ms: 0,
  clock_offset_ms: 0,
};

function time_to_tick(ms: number): number {
  return Math.floor((ms * TICK_RATE) / 1000);
}

function official_time(post: SimPost<Post>): number {
  const limit = post.server_time - TOLERANCE;
  if (post.client_time <= limit) {
    return limit;
  }
  return post.client_time;
}

function official_tick(post: SimPost<Post>): number {
  return time_to_tick(official_time(post));
}

function compute_reference_state(posts: SimPost<Post>[], at_tick: number): State {
  const timeline = new Map<number, SimPost<Post>[]>();
  let index0: SimPost<Post> | null = null;
  const seen = new Set<number>();

  for (const post of posts) {
    if (seen.has(post.index)) {
      continue;
    }
    seen.add(post.index);
    if (post.index === 0) {
      index0 = post;
    }
    const tick = official_tick(post);
    let bucket = timeline.get(tick);
    if (!bucket) {
      bucket = [];
      timeline.set(tick, bucket);
    }
    bucket.push(post);
  }

  if (!index0) {
    return initial;
  }

  for (const bucket of timeline.values()) {
    bucket.sort((a, b) => a.index - b.index);
  }

  const start_tick = official_tick(index0);
  if (at_tick < start_tick) {
    return initial;
  }

  let state = initial;
  for (let tick = start_tick; tick <= at_tick; tick++) {
    state = on_tick(state);
    const bucket = timeline.get(tick);
    if (!bucket) {
      continue;
    }
    for (const post of bucket) {
      state = on_post(post.data, state);
    }
  }
  return state;
}

function create_recording_client(client: SimClient<Post>) {
  const received: SimPost<Post>[] = [];
  return {
    received,
    on_sync: (callback: () => void) => client.on_sync(callback),
    watch: (
      room: string,
      packed: any,
      handler?: (post: SimPost<Post>) => void
    ) => {
      client.watch(room, packed, (post) => {
        received.push(post);
        if (handler) {
          handler(post);
        }
      });
    },
    load: (
      room: string,
      from: number,
      packed: any,
      handler?: (post: SimPost<Post>) => void
    ) => {
      if (handler) {
        client.handlers.set(room, handler);
      }
      client.load(room, from, packed);
    },
    get_latest_post_index: (room: string) => client.get_latest_post_index(room),
    on_latest_post_index: (
      callback: (info: { room: string; latest_index: number; server_time: number }) => void
    ) => client.on_latest_post_index(callback),
    post: (room: string, data: Post, packed: any) => client.post(room, data, packed),
    server_time: () => client.server_time(),
    ping: () => client.ping(),
    close: () => {},
  };
}

function preload_room(network: SimNetwork<Post>): void {
  const x = "x".charCodeAt(0);
  const y = "y".charCodeAt(0);
  const l = "l".charCodeAt(0);
  const f = "f".charCodeAt(0);
  const j = "j".charCodeAt(0);
  const r = "r".charCodeAt(0);

  for (let i = 0; i < 1500; i++) {
    network.scheduler.run_until(i * 100);
    let pid = r;
    if (i === 0) pid = x;
    if (i === 10) pid = y;
    if (i === 20) pid = l;
    if (i === 1200) pid = f;
    if (i === 1300) pid = j;

    const post: Post = { $: "spawn", pid, x: i % 500, y: Math.floor(i / 2) % 500 };
    network.server.receive_post(ROOM, `seed-${i}`, post, network.scheduler.now);
  }
}

function run_long_backlog_join(): {
  state: State;
  reference: State;
  state_keys: string[];
  reference_keys: string[];
  debug: any;
} {
  const network = new SimNetwork<Post>(create_rng(10101));
  preload_room(network);

  const client = network.create_client("N", PROFILE);
  const recording = create_recording_client(client);

  const game = new VibiNet.game<State, Post>({
    room: ROOM,
    initial,
    on_tick,
    on_post,
    packer,
    tick_rate: TICK_RATE,
    tolerance: TOLERANCE,
    cache: true,
    snapshot_stride: 8,
    snapshot_count: 256,
    client: recording,
  });

  const start = network.scheduler.now;
  const end = start + 90_000;
  const render_step = Math.floor(1000 / TICK_RATE);
  for (let t = start; t <= end; t += render_step) {
    network.scheduler.schedule_at(t, () => {
      game.compute_render_state();
    });
  }
  network.scheduler.run_until(end);

  const tick = game.server_tick();
  const state = game.compute_state_at(tick);
  const reference = compute_reference_state(network.server.get_posts(ROOM), tick);
  const state_keys = Object.keys(state).sort();
  const reference_keys = Object.keys(reference).sort();

  return {
    state,
    reference,
    state_keys,
    reference_keys,
    debug: game.debug_dump(),
  };
}

function simulate_legacy_unsafe_drop(posts: SimPost<Post>[]): {
  state: State;
  reference: State;
  state_keys: string[];
  reference_keys: string[];
} {
  const join_time = posts[posts.length - 1]?.server_time ?? 0;
  const downlink_ms = PROFILE.downlink_ms;
  const render_step = Math.floor(1000 / TICK_RATE);
  const end_time = join_time + 90_000;

  let snapshot_start_tick: number | null = null;
  let initial_tick: number | null = null;
  const kept: SimPost<Post>[] = [];
  let cursor = 0;

  const cache_window_ticks = 8 * 256;

  for (let now = join_time; now <= end_time; now += render_step) {
    while (cursor < posts.length) {
      const post = posts[cursor];
      const delivery_time = join_time + ((cursor + 1) * downlink_ms);
      if (delivery_time > now) {
        break;
      }
      const tick = official_tick(post);
      const before_window =
        snapshot_start_tick !== null &&
        tick < snapshot_start_tick;
      if (!before_window) {
        kept.push(post);
        if (post.index === 0 && initial_tick === null) {
          initial_tick = tick;
        }
      }
      cursor += 1;
    }

    if (initial_tick === null) {
      continue;
    }

    const curr_tick = time_to_tick(now);
    if (snapshot_start_tick === null) {
      snapshot_start_tick = initial_tick;
    }
    const candidate = curr_tick - cache_window_ticks;
    if (candidate > snapshot_start_tick) {
      snapshot_start_tick = candidate;
    }
  }

  const final_tick = time_to_tick(end_time);
  const state = compute_reference_state(kept, final_tick);
  const reference = compute_reference_state(posts, final_tick);

  return {
    state,
    reference,
    state_keys: Object.keys(state).sort(),
    reference_keys: Object.keys(reference).sort(),
  };
}

test("legacy unsafe prune/drop model reproduces the desync pattern", () => {
  const network = new SimNetwork<Post>(create_rng(10101));
  preload_room(network);
  const posts = network.server.get_posts(ROOM);
  const result = simulate_legacy_unsafe_drop(posts);

  expect(result.state).not.toEqual(result.reference);
  expect(result.state_keys).not.toEqual(result.reference_keys);
  expect(result.state_keys).not.toContain("y");
  expect(result.state_keys).not.toContain("l");
  expect(result.reference_keys).toContain("x");
  expect(result.reference_keys).toContain("y");
  expect(result.reference_keys).toContain("l");
});

test("safe compute frontier prevents long-backlog state loss", () => {
  const result = run_long_backlog_join();

  expect(result.state).toEqual(result.reference);
  expect(result.state_keys).toEqual(result.reference_keys);
  expect(result.debug.cache_drop_guard_hits).toBe(0);
  expect(result.state_keys).toContain("x");
  expect(result.state_keys).toContain("y");
  expect(result.state_keys).toContain("l");
});
