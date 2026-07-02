// A client joining a room with a long history must fold the whole backlog
// and converge exactly to the reference state — no history may be lost while
// finalization races the download.

import { test, expect } from "bun:test";
import { SimNetwork, SimPost, create_rng } from "./sim_network.ts";
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

const ROOM = "late-join-room";
const PROFILE = {
  uplink_ms: 5,
  downlink_ms: 40,
  jitter_ms: 0,
  clock_offset_ms: 0,
};

function time_to_tick(ms: number): number {
  return Math.floor((ms * TICK_RATE) / 1000);
}

function official_tick(post: SimPost<Post>): number {
  const limit = post.server_time - TOLERANCE;
  const t = post.client_time <= limit ? limit : post.client_time;
  return time_to_tick(t);
}

function compute_reference_state(posts: SimPost<Post>[], at_tick: number): State {
  const anchor = posts.find((p) => p.index === 0);
  if (!anchor) {
    return initial;
  }
  const initial_tick = official_tick(anchor);
  if (at_tick < initial_tick) {
    return initial;
  }
  const buckets = new Map<number, SimPost<Post>[]>();
  for (const post of posts) {
    const tick = Math.max(official_tick(post), initial_tick);
    const bucket = buckets.get(tick) ?? [];
    bucket.push(post);
    buckets.set(tick, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.index - b.index);
  }
  let state = initial;
  for (let tick = initial_tick; tick <= at_tick; tick++) {
    state = on_tick(state);
    for (const post of buckets.get(tick) ?? []) {
      state = on_post(post.data, state);
    }
  }
  return state;
}

// 1500 posts over 150 seconds; a few pids spawn once and must survive in the
// final state (they only appear deep in the backlog).
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

test("late joiner with a long backlog converges to the reference state", () => {
  const network = new SimNetwork<Post>(create_rng(10101));
  preload_room(network);

  const client = network.create_client("N", PROFILE);
  const game = new VibiNet.game<State, Post>({
    room: ROOM,
    initial,
    on_tick,
    on_post,
    packer,
    tick_rate: TICK_RATE,
    tolerance: TOLERANCE,
    client: {
      on_sync: (cb: () => void) => client.on_sync(cb),
      watch: (room: string, packed: any, handler?: any) =>
        client.watch(room, packed, handler),
      post: (room: string, data: Post, packed: any, check?: any) =>
        client.post(room, data, packed, check ?? null),
      server_time: () => client.server_time(),
      ping: () => client.ping(),
      close: () => {},
    },
  });

  // Render continuously while the backlog downloads (this is what used to
  // race finalization against ingestion).
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

  expect(state).toEqual(reference);
  const keys = Object.keys(state).sort();
  expect(keys).toContain("x");
  expect(keys).toContain("y");
  expect(keys).toContain("l");
  expect(keys).toContain("f");
  expect(keys).toContain("j");
  expect(game.desync()).toBeNull();
  // Finalization must actually have caught up (bounded pending window).
  expect(game.finalized_tick()).not.toBeNull();
  expect((game.finalized_tick() as number)).toBeGreaterThan(tick - 4 * TICK_RATE);
});
