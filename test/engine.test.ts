// Pure-core properties: the engine is a pure function of its event history,
// so we can test convergence, finalization, and prediction directly, with no
// scheduler or transport.

import { test, expect } from "bun:test";
import {
  Engine,
  EngineConfig,
  EngineEvent,
  RemotePost,
  new_engine,
  step,
  state_at,
  official_tick,
  latest_check,
  hash_state,
} from "../src/engine.ts";
import {
  Post,
  State,
  TICK_RATE,
  TOLERANCE,
  initial,
  on_post,
  on_tick,
} from "./walkers_game.ts";
import { create_rng, rand_int } from "./sim_network.ts";

const cfg: EngineConfig<State, Post> = {
  initial,
  on_tick,
  on_post,
  tick_rate: TICK_RATE,
  tolerance: TOLERANCE,
  check_stride: 16,
};

const T0 = 1_000_000; // room epoch (ms)

function spawn(pid: string, x: number, y: number): Post {
  return { $: "spawn", pid: pid.charCodeAt(0), x, y };
}

function key(action: "down" | "up", pid: string, k: "w" | "a" | "s" | "d"): Post {
  return { $: action, pid: pid.charCodeAt(0), key: { $: k } };
}

function make_posts(): RemotePost<Post>[] {
  const rng = create_rng(42);
  const posts: RemotePost<Post>[] = [];
  const specs: Post[] = [
    spawn("A", 100, 100),
    spawn("B", 300, 300),
    key("down", "A", "d"),
    key("down", "B", "s"),
    key("up", "A", "d"),
    key("down", "A", "w"),
    key("up", "B", "s"),
    key("up", "A", "w"),
  ];
  let server_time = T0;
  for (let i = 0; i < specs.length; i++) {
    server_time += rand_int(rng, 50, 400);
    // client_time wanders within [-tolerance*2, 0] of server_time: some posts
    // land in the past (within tolerance), some clamp at the tolerance floor.
    const client_time = server_time - rand_int(rng, 0, TOLERANCE * 2);
    posts.push({
      index: i,
      server_time,
      client_time,
      name: `p${i}`,
      check: null,
      data: specs[i],
    });
  }
  return posts;
}

// Fold everything from scratch: the trivially correct reference.
function reference_state(posts: RemotePost<Post>[], at_tick: number): State {
  const anchor = posts.find((p) => p.index === 0);
  if (!anchor) {
    return initial;
  }
  const initial_tick = official_tick(cfg, anchor);
  if (at_tick < initial_tick) {
    return initial;
  }
  const buckets = new Map<number, RemotePost<Post>[]>();
  for (const post of posts) {
    const tick = Math.max(official_tick(cfg, post), initial_tick);
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

function feed(events: EngineEvent<Post>[]): Engine<State, Post> {
  let engine = new_engine(cfg);
  for (const event of events) {
    engine = step(cfg, engine, event);
  }
  return engine;
}

function shuffled<A>(rng: () => number, xs: A[]): A[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand_int(rng, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test("delivery order does not matter (posts buffer until contiguous)", () => {
  const posts = make_posts();
  const last_time = posts[posts.length - 1].server_time;
  const final_checkpoint: EngineEvent<Post> = {
    $: "checkpoint",
    latest_index: posts.length - 1,
    server_time: last_time + 2000,
  };
  const in_order = feed([
    ...posts.map((post): EngineEvent<Post> => ({ $: "post", post })),
    final_checkpoint,
  ]);
  const probe = official_tick(cfg, posts[posts.length - 1]) + 10;

  const rng = create_rng(7);
  for (let round = 0; round < 20; round++) {
    const order = shuffled(rng, posts);
    // Duplicate a random post too.
    const dup = order[rand_int(rng, 0, order.length - 1)];
    const engine = feed([
      ...order.map((post): EngineEvent<Post> => ({ $: "post", post })),
      { $: "post", post: dup },
      final_checkpoint,
    ]);
    expect(engine.base_tick).toEqual(in_order.base_tick);
    expect(engine.base_state).toEqual(in_order.base_state);
    expect(state_at(cfg, engine, probe)).toEqual(state_at(cfg, in_order, probe));
    expect(engine.checks).toEqual(in_order.checks);
  }
});

test("finalized replay equals full replay from scratch", () => {
  const posts = make_posts();
  let engine = new_engine(cfg);
  let time = T0;
  for (const post of posts) {
    engine = step(cfg, engine, { $: "post", post });
    // Interleave checkpoints so finalization advances incrementally.
    time = post.server_time + 100;
    engine = step(cfg, engine, {
      $: "checkpoint",
      latest_index: post.index,
      server_time: time,
    });
  }
  expect(engine.base_tick).not.toBeNull();
  expect(engine.posts.size).toBeLessThan(posts.length); // folding happened

  const last_tick = official_tick(cfg, posts[posts.length - 1]);
  for (let tick = engine.base_tick as number; tick <= last_tick + 20; tick++) {
    expect(state_at(cfg, engine, tick)).toEqual(reference_state(posts, tick));
  }
});

test("checkpoints with unseen indices are ignored (gap safety)", () => {
  const posts = make_posts();
  let engine = new_engine(cfg);
  // Deliver posts 0..2, then a checkpoint claiming completeness through 7.
  for (const post of posts.slice(0, 3)) {
    engine = step(cfg, engine, { $: "post", post });
  }
  const bogus = step(cfg, engine, {
    $: "checkpoint",
    latest_index: 7,
    server_time: posts[7].server_time + 1000,
  });
  expect(bogus.frontier_ms).toBe(engine.frontier_ms);
});

test("local prediction applies instantly and is replaced by its echo", () => {
  const posts = make_posts();
  let engine = feed(posts.map((post): EngineEvent<Post> => ({ $: "post", post })));

  const last = posts[posts.length - 1];
  const t = last.server_time + 500;
  const move: Post = key("down", "A", "a");
  engine = step(cfg, engine, {
    $: "local_post",
    post: { name: "mine", client_time: t, data: move },
  });

  // Predicted: the key is down at the local tick.
  const tick = official_tick(cfg, { server_time: t, client_time: t });
  expect((state_at(cfg, engine, tick) as State)["A"].a).toBe(1);

  // Echo arrives: local removed, authoritative post takes over, same effect.
  engine = step(cfg, engine, {
    $: "post",
    post: {
      index: posts.length,
      server_time: t + 80,
      client_time: t,
      name: "mine",
      check: null,
      data: move,
    },
  });
  expect(engine.locals.size).toBe(0);
  expect((state_at(cfg, engine, tick) as State)["A"].a).toBe(1);
  expect(state_at(cfg, engine, tick)).toEqual(
    reference_state(
      [...posts, {
        index: posts.length,
        server_time: t + 80,
        client_time: t,
        name: "mine",
        check: null,
        data: move,
      }],
      tick
    )
  );
});

test("checksums match between identical clients and flag divergent ones", () => {
  const posts = make_posts();
  const last_time = posts[posts.length - 1].server_time;
  const events: EngineEvent<Post>[] = [
    ...posts.map((post): EngineEvent<Post> => ({ $: "post", post })),
    { $: "checkpoint", latest_index: posts.length - 1, server_time: last_time + 5000 },
  ];

  const a = feed(events);
  const b = feed(events);
  expect(a.checks.length).toBeGreaterThan(0);
  expect(a.checks).toEqual(b.checks);
  expect(a.desync).toBeNull();

  // A post carrying a matching checksum: no desync.
  const check = latest_check(a);
  const next_post = (check_hash: number): EngineEvent<Post> => ({
    $: "post",
    post: {
      index: posts.length,
      server_time: last_time + 6000,
      client_time: last_time + 6000,
      name: "x",
      check: { tick: (check as any).tick, hash: check_hash },
      data: key("down", "B", "w"),
    },
  });
  expect(step(cfg, a, next_post((check as any).hash)).desync).toBeNull();

  // A post carrying a different hash for the same tick: desync detected.
  const bad = step(cfg, a, next_post(((check as any).hash ^ 0xdeadbeef) >>> 0));
  expect(bad.desync).not.toBeNull();
  expect(bad.desync!.tick).toBe((check as any).tick);
});

test("step never mutates its input engine", () => {
  const posts = make_posts();
  const events: EngineEvent<Post>[] = posts.map((post) => ({ $: "post", post }));
  let engine = new_engine(cfg);
  for (const event of events) {
    const before = {
      base_tick: engine.base_tick,
      next_index: engine.next_index,
      posts: new Map(engine.posts),
      locals: new Map(engine.locals),
      hash: hash_state(engine.base_state),
    };
    const next = step(cfg, engine, event);
    expect(engine.base_tick).toBe(before.base_tick);
    expect(engine.next_index).toBe(before.next_index);
    expect(engine.posts).toEqual(before.posts);
    expect(engine.locals).toEqual(before.locals);
    expect(hash_state(engine.base_state)).toBe(before.hash);
    engine = next;
  }
});
