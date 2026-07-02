// vibi.ts
//
// The stateful shell around the pure engine (src/engine.ts). This class owns
// every side effect: the network client, the current engine value, and a
// small memo of computed states. All game semantics live in the engine.
//
// Rendering uses two states per frame:
// - local_state:  current tick, including local predictions (instant input).
// - remote_state: a stable past tick, `max(tolerance, half_rtt + 1 tick)`
//   behind, where rollbacks are not expected.
// `smooth(remote, local)` blends them; the default returns remote. Games
// typically keep the local player from `local` and everyone else from
// `remote`.

import { create_client, ClientApi, NetEvent, gen_name as gen_name_impl } from "./client.ts";
import type { Packed as PackedType } from "./packer.ts";
import {
  Engine,
  EngineConfig,
  Desync,
  new_engine,
  step,
  state_at,
  official_tick,
  time_to_tick,
  latest_check,
} from "./engine.ts";

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
  check_stride?: number;
  on_desync?: (info: Desync) => void;
  client?: ClientApi<P>;
};

const MEMO_SLOTS = 4;

export class VibiNet<S, P> {
  static game = VibiNet;

  room:       string;
  packer:     PackedType;
  tick_rate:  number;
  tolerance:  number;
  smooth:     (remote: S, local: S) => S;
  cfg:        EngineConfig<S, P>;
  engine:     Engine<S, P>;
  client_api: ClientApi<P>;

  private memos: Array<{ tick: number; state: S }>;
  private on_desync_cb: ((info: Desync) => void) | null;
  private desync_fired: boolean;

  constructor(options: VibiNetOptions<S, P>) {
    this.room       = options.room;
    this.packer     = options.packer;
    this.tick_rate  = options.tick_rate;
    this.tolerance  = options.tolerance;
    this.smooth     = options.smooth ?? ((remote: S, _local: S) => remote);
    this.cfg        = {
      initial:      options.initial,
      on_tick:      options.on_tick,
      on_post:      options.on_post,
      tick_rate:    options.tick_rate,
      tolerance:    options.tolerance,
      check_stride: options.check_stride,
    };
    this.engine        = new_engine(this.cfg);
    this.client_api    = options.client ?? create_client<P>(options.server);
    this.memos         = [];
    this.on_desync_cb  = options.on_desync ?? null;
    this.desync_fired  = false;

    this.client_api.on_sync(() => {
      this.client_api.watch(this.room, this.packer, (event) => {
        this.on_net_event(event);
      });
    });
  }

  // --------------------------------------------------------------------------
  // Inputs
  // --------------------------------------------------------------------------

  // Send an input. It applies locally right away (prediction) and is
  // replaced by the server echo. Throws if called before on_sync.
  post(data: P): void {
    const check = latest_check(this.engine);
    const name  = this.client_api.post(this.room, data, this.packer, check);
    const t     = this.server_time();
    this.engine = step(this.cfg, this.engine, {
      $: "local_post",
      post: { name, client_time: t, data },
    });
    this.invalidate(time_to_tick(this.cfg, t));
  }

  // --------------------------------------------------------------------------
  // State queries
  // --------------------------------------------------------------------------

  // State to draw this frame: smooth(stable past, predicted present).
  compute_render_state(): S {
    const curr_tick = this.server_tick();
    const tick_ms   = 1000 / this.tick_rate;
    const tol_ticks = Math.ceil(this.tolerance / tick_ms);
    const rtt_ms    = this.client_api.ping();
    const half_rtt  = isFinite(rtt_ms) ? Math.ceil((rtt_ms / 2) / tick_ms) : 0;
    const lag       = Math.max(tol_ticks, half_rtt + 1);
    const base      = this.finalized_tick() ?? 0;
    const remote_tick = Math.max(base, curr_tick - lag, 0);

    const remote_state = this.compute_state_at(remote_tick);
    const local_state  = this.compute_state_at(curr_tick);
    return this.smooth(remote_state, local_state);
  }

  // State at the current server tick (with local prediction).
  compute_current_state(): S {
    return this.compute_state_at(this.server_tick());
  }

  // State at an arbitrary tick >= finalized_tick() (earlier ticks clamp to
  // the finalized state; their history has been folded away).
  compute_state_at(tick: number): S {
    let hint: { tick: number; state: S } | undefined;
    for (const memo of this.memos) {
      if (memo.tick <= tick && (!hint || memo.tick > hint.tick)) {
        hint = memo;
      }
    }
    const state = state_at(this.cfg, this.engine, tick, hint);
    this.remember(tick, state);
    return state;
  }

  // --------------------------------------------------------------------------
  // Info
  // --------------------------------------------------------------------------

  time_to_tick(ms: number): number {
    return time_to_tick(this.cfg, ms);
  }

  server_time(): number {
    return this.client_api.server_time();
  }

  server_tick(): number {
    return this.time_to_tick(this.server_time());
  }

  // Newest tick whose history is final (never rolls back). Null before the
  // room's first post is known.
  finalized_tick(): number | null {
    return this.engine.base_tick;
  }

  // Tick of the room's first post (null if none seen yet).
  initial_tick(): number | null {
    return this.engine.initial_tick;
  }

  post_count(): number {
    return this.engine.max_index + 1;
  }

  ping(): number {
    return this.client_api.ping();
  }

  desync(): Desync | null {
    return this.engine.desync;
  }

  on_sync(callback: () => void): void {
    this.client_api.on_sync(callback);
  }

  close(): void {
    this.client_api.close();
  }

  debug_dump(): unknown {
    let server_time: number | null = null;
    try {
      server_time = this.server_time();
    } catch {
      server_time = null;
    }
    return {
      room: this.room,
      tick_rate: this.tick_rate,
      tolerance: this.tolerance,
      server_time,
      server_tick: server_time === null ? null : this.time_to_tick(server_time),
      ping: this.ping(),
      engine: {
        base_tick: this.engine.base_tick,
        initial_tick: this.engine.initial_tick,
        frontier_ms: this.engine.frontier_ms,
        next_index: this.engine.next_index,
        max_index: this.engine.max_index,
        pending_posts: this.engine.posts.size,
        pending_locals: this.engine.locals.size,
        checks: this.engine.checks,
        desync: this.engine.desync,
      },
      memo_ticks: this.memos.map((memo) => memo.tick),
      client_debug: this.client_api.debug_dump?.() ?? null,
    };
  }

  static gen_name(): string {
    return gen_name_impl();
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private on_net_event(event: NetEvent<P>): void {
    if (event.$ === "post") {
      // The post invalidates computed states from its tick on; if it echoes
      // a local prediction, from the prediction's tick on.
      let dirty = official_tick(this.cfg, event.post);
      const name = event.post.name;
      if (name !== undefined) {
        const local = this.engine.locals.get(name);
        if (local) {
          dirty = Math.min(dirty, this.time_to_tick(local.client_time));
        }
      }
      this.engine = step(this.cfg, this.engine, { $: "post", post: event.post });
      this.invalidate(dirty);
      this.report_desync();
    } else {
      // Checkpoints only advance finalization; past states stay valid.
      this.engine = step(this.cfg, this.engine, event);
    }
  }

  private invalidate(from_tick: number): void {
    this.memos = this.memos.filter((memo) => memo.tick < from_tick);
  }

  private remember(tick: number, state: S): void {
    this.memos = this.memos.filter((memo) => memo.tick !== tick);
    this.memos.push({ tick, state });
    if (this.memos.length > MEMO_SLOTS) {
      this.memos.shift();
    }
  }

  private report_desync(): void {
    if (this.desync_fired || this.engine.desync === null) {
      return;
    }
    this.desync_fired = true;
    const info = this.engine.desync;
    console.error(
      `[VIBI] DESYNC at tick ${info.tick}: local hash ${info.ours} != remote hash ${info.theirs}`
    );
    if (this.on_desync_cb) {
      this.on_desync_cb(info);
    }
  }
}

export namespace VibiNet {
  export type Packed = PackedType;
  export type Options<S, P> = VibiNetOptions<S, P>;
}
