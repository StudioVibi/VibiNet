// Full-stack simulation: real VibiNet instances over the simulated network,
// checked against a from-scratch reference fold of the server's post log.

import { test, expect } from "bun:test";
import {
  create_rng,
  rand_between,
  rand_int,
  ClientProfile,
  SimClient,
  SimCheck,
  SimEvent,
  SimNetwork,
  SimPost,
} from "./sim_network.ts";
import {
  Post,
  State,
  packer,
  initial,
  on_post,
  on_tick,
  TICK_RATE,
  TOLERANCE,
} from "./walkers_game.ts";

const { VibiNet } = await import("../src/vibi.ts");

type PlayerSim = {
  id_char: string;
  id_code: number;
  vibi: VibiNet<State, Post>;
  client: SimClient<Post>;
  received_posts: SimPost<Post>[];
  sync_at: number;
  ready_at: number;
  keys: Record<"w" | "a" | "s" | "d", boolean>;
};

const ROOM = "sim-room";
const KEY_LIST: Array<"w" | "a" | "s" | "d"> = ["w", "a", "s", "d"];

function time_to_tick(ms: number): number {
  return Math.floor((ms * TICK_RATE) / 1000);
}

function official_time(post: { server_time: number; client_time: number }): number {
  const limit = post.server_time - TOLERANCE;
  if (post.client_time <= limit) {
    return limit;
  }
  return post.client_time;
}

function official_tick(post: { server_time: number; client_time: number }): number {
  return time_to_tick(official_time(post));
}

type LocalRef = { client_time: number; data: Post };

// Reference: fold every known post from scratch (posts landing before the
// room anchor clamp to it, like the engine).
function compute_reference_state(
  remote_posts: SimPost<Post>[],
  local_posts: LocalRef[],
  at_tick: number
): State {
  const seen = new Set<number>();
  let anchor: SimPost<Post> | null = null;
  const deduped: SimPost<Post>[] = [];
  for (const post of remote_posts) {
    if (seen.has(post.index)) {
      continue;
    }
    seen.add(post.index);
    deduped.push(post);
    if (post.index === 0) {
      anchor = post;
    }
  }
  if (!anchor) {
    return initial;
  }
  const initial_tick = official_tick(anchor);
  if (at_tick < initial_tick) {
    return initial;
  }

  const remote_buckets = new Map<number, SimPost<Post>[]>();
  for (const post of deduped) {
    const tick = Math.max(official_tick(post), initial_tick);
    const bucket = remote_buckets.get(tick) ?? [];
    bucket.push(post);
    remote_buckets.set(tick, bucket);
  }
  for (const bucket of remote_buckets.values()) {
    bucket.sort((a, b) => a.index - b.index);
  }
  const local_buckets = new Map<number, LocalRef[]>();
  for (const local of local_posts) {
    const tick = Math.max(time_to_tick(local.client_time), initial_tick);
    const bucket = local_buckets.get(tick) ?? [];
    bucket.push(local);
    local_buckets.set(tick, bucket);
  }

  let state = initial;
  for (let tick = initial_tick; tick <= at_tick; tick++) {
    state = on_tick(state);
    for (const post of remote_buckets.get(tick) ?? []) {
      state = on_post(post.data, state);
    }
    for (const local of local_buckets.get(tick) ?? []) {
      state = on_post(local.data, state);
    }
  }
  return state;
}

function make_smooth(player_char: string) {
  return (remote_state: State, local_state: State): State => {
    const local = local_state[player_char];
    if (!local) {
      return remote_state;
    }
    return { ...remote_state, [player_char]: local };
  };
}

function max_delivery_ms(profiles: ClientProfile[]): number {
  let max_uplink = 0;
  let max_downlink = 0;
  let max_jitter = 0;
  for (const profile of profiles) {
    max_uplink = Math.max(max_uplink, profile.uplink_ms);
    max_downlink = Math.max(max_downlink, profile.downlink_ms);
    max_jitter = Math.max(max_jitter, profile.jitter_ms);
  }
  return max_uplink + max_downlink + (2 * max_jitter);
}

// Wrap a SimClient in the ClientApi shape, recording delivered posts.
function create_recording_client(client: SimClient<Post>) {
  const received: SimPost<Post>[] = [];
  return {
    received,
    on_sync: (callback: () => void) => client.on_sync(callback),
    watch: (
      room: string,
      packed: any,
      handler?: (event: SimEvent<Post>) => void
    ) => {
      client.watch(room, packed, (event) => {
        if (event.$ === "post") {
          received.push(event.post);
        }
        if (handler) {
          handler(event);
        }
      });
    },
    post: (room: string, data: Post, packed: any, check?: SimCheck | null) =>
      client.post(room, data, packed, check ?? null),
    server_time: () => client.server_time(),
    ping: () => client.ping(),
    close: () => {},
  };
}

function schedule_spawn(
  network: SimNetwork<Post>,
  player: PlayerSim,
  spawn_at: number
): void {
  network.scheduler.schedule_at(spawn_at, () => {
    player.vibi.post({
      $: "spawn",
      pid: player.id_code,
      x: 200,
      y: 200,
    });
  });
}

function schedule_inputs(
  network: SimNetwork<Post>,
  player: PlayerSim,
  rng: () => number,
  end_ms: number,
  start_ms: number,
  min_delay_ms: number,
  max_delay_ms: number
): void {
  const scheduler = network.scheduler;
  const schedule_next = () => {
    if (min_delay_ms <= 0 || max_delay_ms <= 0) {
      return;
    }
    const delay = rand_between(rng, min_delay_ms, max_delay_ms);
    const next_time = scheduler.now + delay;
    if (next_time > end_ms) {
      return;
    }
    scheduler.schedule(delay, () => {
      const key = KEY_LIST[rand_int(rng, 0, KEY_LIST.length - 1)];
      const is_down = !player.keys[key];
      player.keys[key] = is_down;
      const action = is_down ? "down" : "up";
      player.vibi.post({ $: action, pid: player.id_code, key: { $: key } });
      schedule_next();
    });
  };
  scheduler.schedule_at(start_ms, schedule_next);
}

function local_posts_for(player: PlayerSim): LocalRef[] {
  const out: LocalRef[] = [];
  for (const local of player.vibi.engine.locals.values()) {
    out.push({ client_time: local.client_time, data: local.data });
  }
  return out;
}

function reference_render_state(player: PlayerSim): State {
  const vibi = player.vibi;
  const curr_tick = vibi.server_tick();
  const tick_ms = 1000 / vibi.tick_rate;
  const tol_ticks = Math.ceil(vibi.tolerance / tick_ms);
  const rtt_ms = vibi.client_api.ping();
  const half_rtt = isFinite(rtt_ms) ? Math.ceil((rtt_ms / 2) / tick_ms) : 0;
  const lag = Math.max(tol_ticks, half_rtt + 1);
  const base = vibi.finalized_tick() ?? 0;
  const remote_tick = Math.max(base, curr_tick - lag, 0);

  const locals = local_posts_for(player);
  const remote_state = compute_reference_state(player.received_posts, locals, remote_tick);
  const local_state = compute_reference_state(player.received_posts, locals, curr_tick);
  return vibi.smooth(remote_state, local_state);
}

// Every player must agree with a from-scratch fold of the server's log. The
// probe tick is clamped up to each player's finalized tick (states below it
// are folded away); posts at or below that tick are guaranteed delivered.
function assert_authoritative_sync(
  network: SimNetwork<Post>,
  players: PlayerSim[],
  at_tick: number
): void {
  const posts = network.server.get_posts(ROOM);
  for (const player of players) {
    const tick = Math.max(at_tick, player.vibi.finalized_tick() ?? at_tick);
    const state = player.vibi.compute_state_at(tick);
    const reference = compute_reference_state(posts, [], tick);
    expect(state).toEqual(reference);
  }
}

function assert_render_state(player: PlayerSim): void {
  const expected = reference_render_state(player);
  const rendered = player.vibi.compute_render_state();
  expect(rendered).toEqual(expected);
}

// All finalized-state checksums must agree across players at common ticks.
function assert_checksums_agree(players: PlayerSim[]): void {
  const by_tick = new Map<number, number>();
  for (const player of players) {
    expect(player.vibi.desync()).toBeNull();
    for (const check of player.vibi.engine.checks) {
      const prev = by_tick.get(check.tick);
      if (prev !== undefined) {
        expect(check.hash).toBe(prev);
      } else {
        by_tick.set(check.tick, check.hash);
      }
    }
  }
}

type Scenario = {
  seed: number;
  duration_ms: number;
  profiles: ClientProfile[];
  check_interval_ms: number;
  render_check_interval_ms: number;
  input_paces?: Array<{ min_ms: number; max_ms: number }>;
  spawn_delay_ms?: { min: number; max: number };
};

function run_scenario(s: Scenario): void {
  const rng = create_rng(s.seed);
  const network = new SimNetwork<Post>(rng);
  const players: PlayerSim[] = [];
  const tick_ms = 1000 / TICK_RATE;
  const max_delay = max_delivery_ms(s.profiles);
  const spawn_delay = s.spawn_delay_ms ?? { min: 120, max: 900 };
  const input_paces = s.input_paces ?? [
    { min_ms: 80, max_ms: 300 },
    { min_ms: 100, max_ms: 420 },
    { min_ms: 60, max_ms: 240 },
    { min_ms: 120, max_ms: 520 },
  ];

  for (let i = 0; i < s.profiles.length; i++) {
    const client_id = String.fromCharCode("A".charCodeAt(0) + i);
    const player_id = client_id.charCodeAt(0);
    const client = network.create_client(client_id, s.profiles[i]);
    const recording = create_recording_client(client);
    const smooth = make_smooth(client_id);
    const vibi = new VibiNet.game<State, Post>({
      room: ROOM,
      initial,
      on_tick,
      on_post,
      packer,
      tick_rate: TICK_RATE,
      tolerance: TOLERANCE,
      smooth,
      check_stride: 16,
      client: recording,
    });
    const sync_at = s.profiles[i].sync_delay_ms ?? 0;
    const ready_at = sync_at + max_delay + TOLERANCE + (2 * tick_ms);
    players.push({
      id_char: client_id,
      id_code: player_id,
      vibi,
      client,
      received_posts: recording.received,
      sync_at,
      ready_at,
      keys: { w: false, a: false, s: false, d: false },
    });
  }

  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    const spawn_at = player.sync_at +
      rand_between(rng, spawn_delay.min, spawn_delay.max);
    schedule_spawn(network, player, spawn_at);
    const pace = input_paces[Math.min(input_paces.length - 1, i)];
    const input_start = spawn_at + rand_between(rng, 100, 400);
    schedule_inputs(
      network,
      player,
      rng,
      s.duration_ms,
      input_start,
      pace.min_ms,
      pace.max_ms
    );
  }

  const check_end = s.duration_ms + max_delay + (2 * tick_ms);

  const schedule_authoritative_check = () => {
    const now = network.scheduler.now;
    if (now > check_end) {
      return;
    }
    const safe_time = now - max_delay - TOLERANCE - (2 * tick_ms);
    if (safe_time >= 0) {
      const tick = time_to_tick(safe_time);
      const ready_players = players.filter((p) => now >= p.ready_at);
      if (ready_players.length > 0) {
        assert_authoritative_sync(network, ready_players, tick);
      }
    }
    network.scheduler.schedule(
      s.check_interval_ms,
      schedule_authoritative_check
    );
  };

  const schedule_render_check = () => {
    const now = network.scheduler.now;
    if (now > check_end) {
      return;
    }
    const ready_players = players.filter((p) => now >= p.ready_at);
    for (const player of ready_players) {
      assert_render_state(player);
    }
    network.scheduler.schedule(
      s.render_check_interval_ms,
      schedule_render_check
    );
  };

  network.scheduler.schedule(s.check_interval_ms, schedule_authoritative_check);
  network.scheduler.schedule(s.render_check_interval_ms, schedule_render_check);
  network.scheduler.run_until(s.duration_ms);
  network.scheduler.run_until(check_end);

  const final_tick = time_to_tick(network.scheduler.now - max_delay);
  if (final_tick >= 0) {
    const ready_players = players.filter(
      (p) => network.scheduler.now >= p.ready_at
    );
    if (ready_players.length > 0) {
      assert_authoritative_sync(network, ready_players, final_tick);
    }
    for (const player of ready_players) {
      assert_render_state(player);
    }
    assert_checksums_agree(ready_players);
  }
}

const BASE_PROFILES: ClientProfile[] = [
  { uplink_ms: 60, downlink_ms: 80, jitter_ms: 20, clock_offset_ms: -12 },
  { uplink_ms: 90, downlink_ms: 110, jitter_ms: 35, clock_offset_ms: 18 },
  { uplink_ms: 40, downlink_ms: 50, jitter_ms: 15, clock_offset_ms: 5 },
  { uplink_ms: 120, downlink_ms: 140, jitter_ms: 45, clock_offset_ms: -20 },
];

test("walkers stays in sync under mixed latency", () => {
  run_scenario({
    seed: 123,
    duration_ms: 120_000,
    profiles: BASE_PROFILES,
    check_interval_ms: 500,
    render_check_interval_ms: 800,
  });
});

test("walkers stays in sync under heavy jitter", () => {
  const jitter_profiles: ClientProfile[] = [
    { uplink_ms: 80, downlink_ms: 80, jitter_ms: 60, clock_offset_ms: -30 },
    { uplink_ms: 100, downlink_ms: 120, jitter_ms: 75, clock_offset_ms: 25 },
    { uplink_ms: 70, downlink_ms: 90, jitter_ms: 50, clock_offset_ms: -10 },
    { uplink_ms: 110, downlink_ms: 130, jitter_ms: 90, clock_offset_ms: 15 },
  ];
  run_scenario({
    seed: 999,
    duration_ms: 90_000,
    profiles: jitter_profiles,
    check_interval_ms: 400,
    render_check_interval_ms: 650,
  });
});

test("late joiners with asymmetric links stay in sync", () => {
  const late_profiles: ClientProfile[] = [
    { uplink_ms: 60, downlink_ms: 130, jitter_ms: 40, clock_offset_ms: -15 },
    {
      uplink_ms: 200,
      downlink_ms: 70,
      jitter_ms: 30,
      clock_offset_ms: 25,
      sync_delay_ms: 3000,
    },
    {
      uplink_ms: 90,
      downlink_ms: 160,
      jitter_ms: 55,
      clock_offset_ms: -35,
      sync_delay_ms: 8000,
    },
    {
      uplink_ms: 140,
      downlink_ms: 220,
      jitter_ms: 65,
      clock_offset_ms: 10,
      sync_delay_ms: 15000,
    },
  ];
  run_scenario({
    seed: 2024,
    duration_ms: 150_000,
    profiles: late_profiles,
    check_interval_ms: 600,
    render_check_interval_ms: 900,
    spawn_delay_ms: { min: 800, max: 2200 },
  });
});

test("burst inputs stay in sync", () => {
  const fast_inputs = [
    { min_ms: 20, max_ms: 80 },
    { min_ms: 70, max_ms: 220 },
    { min_ms: 40, max_ms: 140 },
    { min_ms: 120, max_ms: 380 },
  ];
  run_scenario({
    seed: 777,
    duration_ms: 80_000,
    profiles: BASE_PROFILES,
    check_interval_ms: 400,
    render_check_interval_ms: 700,
    input_paces: fast_inputs,
  });
});

test("long run stays in sync and checksums agree", () => {
  run_scenario({
    seed: 4242,
    duration_ms: 300_000,
    profiles: BASE_PROFILES,
    check_interval_ms: 1000,
    render_check_interval_ms: 1500,
  });
});

test("duplicate deliveries stay in sync", () => {
  const dup_profiles: ClientProfile[] = [
    {
      uplink_ms: 70,
      downlink_ms: 90,
      jitter_ms: 35,
      clock_offset_ms: -10,
      duplicate_rate: 0.2,
      duplicate_delay_ms: { min: 40, max: 300 },
    },
    {
      uplink_ms: 100,
      downlink_ms: 140,
      jitter_ms: 50,
      clock_offset_ms: 20,
      duplicate_rate: 0.15,
      duplicate_delay_ms: { min: 60, max: 450 },
    },
    {
      uplink_ms: 50,
      downlink_ms: 80,
      jitter_ms: 25,
      clock_offset_ms: 5,
      duplicate_rate: 0.25,
      duplicate_delay_ms: { min: 30, max: 220 },
    },
    {
      uplink_ms: 130,
      downlink_ms: 170,
      jitter_ms: 45,
      clock_offset_ms: -25,
      duplicate_rate: 0.2,
      duplicate_delay_ms: { min: 80, max: 500 },
    },
  ];
  run_scenario({
    seed: 5555,
    duration_ms: 100_000,
    profiles: dup_profiles,
    check_interval_ms: 600,
    render_check_interval_ms: 900,
  });
});
