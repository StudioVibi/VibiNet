// Pure-core properties: the engine is a pure function of its event history,
// so we can test convergence, finalization, and prediction directly, with no
// scheduler or transport.

import { test, expect } from "bun:test";
import {
  Engine,
  Config,
  Event,
  Post as NetPost,
  engine_new,
  engine_step,
  engine_state_at,
  engine_check,
  post_tick,
  state_hash,
} from "../../vibinet-ts/src/vibinet.ts";
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

const cfg: Config<State, Post> = {
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

function make_posts(): NetPost<Post>[] {
  const rng = create_rng(42);
  const posts: NetPost<Post>[] = [];
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
function reference_state(posts: NetPost<Post>[], at_tick: number): State {
  const anchor = posts.find((p) => p.index === 0);
  if (!anchor) {
    return initial;
  }
  const initial_tick = post_tick(anchor, cfg);
  if (at_tick < initial_tick) {
    return initial;
  }
  const buckets = new Map<number, NetPost<Post>[]>();
  for (const post of posts) {
    const tick = Math.max(post_tick(post, cfg), initial_tick);
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

function feed(events: Event<Post>[]): Engine<State, Post> {
  let engine = engine_new(cfg);
  for (const event of events) {
    engine = engine_step(engine, event, cfg);
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
  const final_checkpoint: Event<Post> = {
    $: "checkpoint",
    latest_index: posts.length - 1,
    server_time: last_time + 2000,
  };
  const in_order = feed([
    ...posts.map((post): Event<Post> => ({ $: "post", post })),
    final_checkpoint,
  ]);
  const probe = post_tick(posts[posts.length - 1], cfg) + 10;

  const rng = create_rng(7);
  for (let round = 0; round < 20; round++) {
    const order = shuffled(rng, posts);
    // Duplicate a random post too.
    const dup = order[rand_int(rng, 0, order.length - 1)];
    const engine = feed([
      ...order.map((post): Event<Post> => ({ $: "post", post })),
      { $: "post", post: dup },
      final_checkpoint,
    ]);
    expect(engine.base_tick).toEqual(in_order.base_tick);
    expect(engine.base_state).toEqual(in_order.base_state);
    expect(engine_state_at(engine, probe, cfg)).toEqual(engine_state_at(in_order, probe, cfg));
    expect(engine.checks).toEqual(in_order.checks);
  }
});

test("finalized replay equals full replay from scratch", () => {
  const posts = make_posts();
  let engine = engine_new(cfg);
  let time = T0;
  for (const post of posts) {
    engine = engine_step(engine, { $: "post", post }, cfg);
    // Interleave checkpoints so finalization advances incrementally.
    time = post.server_time + 100;
    engine = engine_step(engine, {
      $: "checkpoint",
      latest_index: post.index,
      server_time: time,
    }, cfg);
  }
  expect(engine.base_tick).not.toBeNull();
  expect(engine.posts.size).toBeLessThan(posts.length); // folding happened

  const last_tick = post_tick(posts[posts.length - 1], cfg);
  for (let tick = engine.base_tick as number; tick <= last_tick + 20; tick++) {
    expect(engine_state_at(engine, tick, cfg)).toEqual(reference_state(posts, tick));
  }
});

test("checkpoints with unseen indices are ignored (gap safety)", () => {
  const posts = make_posts();
  let engine = engine_new(cfg);
  // Deliver posts 0..2, then a checkpoint claiming completeness through 7.
  for (const post of posts.slice(0, 3)) {
    engine = engine_step(engine, { $: "post", post }, cfg);
  }
  const bogus = engine_step(engine, {
    $: "checkpoint",
    latest_index: 7,
    server_time: posts[7].server_time + 1000,
  }, cfg);
  expect(bogus.frontier_ms).toBe(engine.frontier_ms);
});

test("local prediction applies instantly and is replaced by its echo", () => {
  const posts = make_posts();
  let engine = feed(posts.map((post): Event<Post> => ({ $: "post", post })));

  const last = posts[posts.length - 1];
  const t = last.server_time + 500;
  const move: Post = key("down", "A", "a");
  engine = engine_step(engine, {
    $: "local_post",
    post: { name: "mine", client_time: t, data: move },
  }, cfg);

  // Predicted: the key is down at the local tick.
  const tick = post_tick({ server_time: t, client_time: t }, cfg);
  expect((engine_state_at(engine, tick, cfg) as State)["A"].a).toBe(1);

  // Echo arrives: local removed, authoritative post takes over, same effect.
  engine = engine_step(engine, {
    $: "post",
    post: {
      index: posts.length,
      server_time: t + 80,
      client_time: t,
      name: "mine",
      check: null,
      data: move,
    },
  }, cfg);
  expect(engine.locals.size).toBe(0);
  expect((engine_state_at(engine, tick, cfg) as State)["A"].a).toBe(1);
  expect(engine_state_at(engine, tick, cfg)).toEqual(
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
  const events: Event<Post>[] = [
    ...posts.map((post): Event<Post> => ({ $: "post", post })),
    { $: "checkpoint", latest_index: posts.length - 1, server_time: last_time + 5000 },
  ];

  const a = feed(events);
  const b = feed(events);
  expect(a.checks.length).toBeGreaterThan(0);
  expect(a.checks).toEqual(b.checks);
  expect(a.desync).toBeNull();

  // A post carrying a matching checksum: no desync.
  const check = engine_check(a);
  const next_post = (check_hash: number): Event<Post> => ({
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
  expect(engine_step(a, next_post((check as any).hash), cfg).desync).toBeNull();

  // A post carrying a different hash for the same tick: desync detected.
  const bad = engine_step(a, next_post(((check as any).hash ^ 0xdeadbeef) >>> 0), cfg);
  expect(bad.desync).not.toBeNull();
  expect(bad.desync!.tick).toBe((check as any).tick);
});

test("step never mutates its input engine", () => {
  const posts = make_posts();
  const events: Event<Post>[] = posts.map((post) => ({ $: "post", post }));
  let engine = engine_new(cfg);
  for (const event of events) {
    const before = {
      base_tick: engine.base_tick,
      next_index: engine.next_index,
      posts: new Map(engine.posts),
      locals: new Map(engine.locals),
      hash: state_hash(engine.base_state),
    };
    const next = engine_step(engine, event, cfg);
    expect(engine.base_tick).toBe(before.base_tick);
    expect(engine.next_index).toBe(before.next_index);
    expect(engine.posts).toEqual(before.posts);
    expect(engine.locals).toEqual(before.locals);
    expect(state_hash(engine.base_state)).toBe(before.hash);
    engine = next;
  }
});

test("pending locals apply once across hint replays (no phantom re-application)", () => {
  // A memoized state used as a replay hint ALREADY contains the pending
  // locals below it. Locals must not be pulled up to the replay start: that
  // re-applied them once per render until the echo arrived (a local spawn
  // teleported back; a local jump post re-fired mid-air as a double jump).
  const t0 = T0;
  const anchor: NetPost<Post> = {
    index: 0, server_time: t0, client_time: t0, name: "a0", check: null,
    data: spawn("A", 100, 100),
  };
  let engine = feed([{ $: "post", post: anchor }]);
  const walk_ms = t0 + 200;
  engine = engine_step(engine, {
    $: "local_post",
    post: { name: "l0", client_time: walk_ms, data: spawn("B", 500, 500) },
  }, cfg);
  engine = engine_step(engine, {
    $: "local_post",
    post: { name: "l1", client_time: walk_ms, data: key("down", "B", "d") },
  }, cfg);

  const walk_tick = post_tick({ server_time: walk_ms, client_time: walk_ms }, cfg);
  const mid_tick = walk_tick + 10;
  const end_tick = walk_tick + 20;

  const flat = engine_state_at(engine, end_tick, cfg);
  const mid = engine_state_at(engine, mid_tick, cfg);
  const hinted = engine_state_at(engine, end_tick, cfg, { tick: mid_tick, state: mid });

  // Same history, so the hinted replay must agree with the flat one. With
  // the phantom re-application, spawn("B") re-fired at mid_tick + 1 and B
  // snapped back toward x = 500.
  expect(hinted).toEqual(flat);
  expect(hinted["B"].x).toBe(flat["B"].x);
});
