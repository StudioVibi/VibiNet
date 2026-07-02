// The client side of VibiNet, and the package entry point. Everything
// impure that runs on a player's machine lives here:
// - client_new: the WebSocket transport (reconnect, time sync, post queue).
// - VibiNet:    the stateful game shell around the pure engine (vibinet.ts).
//
// The shell owns three pieces of mutable state: the transport, the current
// engine value, and a small memo of computed states. All game semantics are
// pure functions in vibinet.ts.

import {
  Check,
  Config,
  Desync,
  Engine,
  Event,
  Packed,
  check_from_wire,
  check_to_wire,
  engine_check,
  engine_new,
  engine_state_at,
  engine_step,
  message_decode,
  message_encode,
  packed_decode,
  packed_encode,
  post_tick,
  time_to_tick,
} from "./vibinet.ts";

export * from "./vibinet.ts";

// Types
// -----

// The transport seen by the shell. Injectable, for tests and simulation.
export type ClientApi<P> = {
  on_sync: (callback: () => void) => void;
  watch: (room: string, packer: Packed, handler?: (event: Event<P>) => void) => void;
  post: (room: string, data: P, packer: Packed, check?: Check | null) => string;
  server_time: () => number;
  ping: () => number;
  close: () => void;
  debug_dump?: () => unknown;
};

export type Options<S, P> = {
  server?: string;
  room: string;
  initial: S;
  on_tick: (state: S) => S;
  on_post: (post: P, state: S) => S;
  packer: Packed;
  tick_rate: number;
  tolerance: number;
  smooth?: (remote: S, local: S) => S;
  check_stride?: number;
  on_desync?: (info: Desync) => void;
  client?: ClientApi<P>;
};

type TimeSync = {
  clock_offset: number;
  lowest_ping: number;
  request_sent_at: number;
  request_nonce: number;
  last_ping: number;
  avg_ping: number;
};

type Watcher = { handler?: (event: Event<any>) => void; packer: Packed };

// Name
// ----

// Random 8-char id (post names, room names).
export function name_gen(): string {
  // Exactly 64 chars so `% 64` maps uniformly.
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  const bytes = new Uint8Array(8);
  const can_crypto = typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function";
  if (can_crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 8; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % 64];
  }
  return out;
}

// Url
// ---

export const OFFICIAL_SERVER_URL = "wss://net.studiovibi.com";

export function url_normalize(raw_url: string): string {
  let ws_url = raw_url;

  try {
    const url = new URL(raw_url);
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    }
    ws_url = url.toString();
  } catch {
    ws_url = raw_url;
  }

  const is_https_page =
    typeof window !== "undefined" && window.location.protocol === "https:";
  if (is_https_page && ws_url.startsWith("ws://")) {
    const upgraded = `wss://${ws_url.slice("ws://".length)}`;
    console.warn(
      `[VibiNet] Upgrading insecure WebSocket URL "${ws_url}" to "${upgraded}" because the page is HTTPS.`
    );
    return upgraded;
  }

  return ws_url;
}

// Client
// ------

// Monotonic local clock. Wall clocks (Date.now) can step backwards or jump
// on NTP adjustments and sleep/wake, which would poison the clock offset.
function client_now(): number {
  return Math.floor(performance.now());
}

export function client_new<P>(server?: string): ClientApi<P> {
  const time_sync: TimeSync = {
    clock_offset: Infinity,
    lowest_ping: Infinity,
    request_sent_at: 0,
    request_nonce: 0,
    last_ping: Infinity,
    avg_ping: Infinity,
  };

  const room_watchers = new Map<string, Watcher>();
  const watched_rooms = new Set<string>();
  // Next contiguous index expected per room; on reconnect we re-watch from
  // here so the server only re-sends what we haven't seen.
  const room_cursors = new Map<string, number>();
  let is_synced = false;
  const sync_listeners: Array<() => void> = [];
  let heartbeat_id: ReturnType<typeof setInterval> | null = null;
  let reconnect_timer_id: ReturnType<typeof setTimeout> | null = null;
  let reconnect_attempt = 0;
  let manual_close = false;
  let ws: WebSocket | null = null;
  const pending_posts: Uint8Array[] = [];

  const ws_url = url_normalize(server ?? OFFICIAL_SERVER_URL);

  function server_time(): number {
    if (!isFinite(time_sync.clock_offset)) {
      throw new Error("server_time() called before initial sync");
    }
    return Math.floor(client_now() + time_sync.clock_offset);
  }

  function clear_heartbeat(): void {
    if (heartbeat_id !== null) {
      clearInterval(heartbeat_id);
      heartbeat_id = null;
    }
  }

  function clear_reconnect_timer(): void {
    if (reconnect_timer_id !== null) {
      clearTimeout(reconnect_timer_id);
      reconnect_timer_id = null;
    }
  }

  function reconnect_delay_ms(): number {
    const base = 500;
    const cap = 8000;
    const expo = Math.min(cap, base * Math.pow(2, reconnect_attempt));
    const jitter = Math.floor(Math.random() * 250);
    return expo + jitter;
  }

  function flush_pending_posts_if_open(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    while (pending_posts.length > 0) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const next = pending_posts[0];
      try {
        ws.send(next);
        pending_posts.shift();
      } catch {
        connect();
        return;
      }
    }
  }

  function send_time_request_if_open(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    time_sync.request_nonce = (time_sync.request_nonce + 1) >>> 0;
    time_sync.request_sent_at = client_now();
    ws.send(message_encode({ $: "get_time", nonce: time_sync.request_nonce }));
  }

  function watch_message(room: string): Uint8Array {
    return message_encode({
      $: "watch",
      room,
      from: room_cursors.get(room) ?? 0,
    });
  }

  function try_send(buf: Uint8Array): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      ws.send(buf);
      return true;
    } catch {
      return false;
    }
  }

  function send_or_reconnect(buf: Uint8Array): void {
    if (try_send(buf)) {
      return;
    }
    connect();
  }

  function queue_post(buf: Uint8Array): void {
    pending_posts.push(buf);
    connect();
  }

  function register_handler(
    room: string,
    packer: Packed,
    handler?: (event: Event<any>) => void
  ): void {
    const existing = room_watchers.get(room);
    if (existing) {
      if (existing.packer !== packer) {
        throw new Error(`Packed schema already registered for room: ${room}`);
      }
      if (handler) {
        existing.handler = handler;
      }
      return;
    }
    room_watchers.set(room, { handler, packer });
  }

  function schedule_reconnect(): void {
    if (manual_close || reconnect_timer_id !== null) {
      return;
    }
    const delay = reconnect_delay_ms();
    reconnect_timer_id = setTimeout(() => {
      reconnect_timer_id = null;
      reconnect_attempt += 1;
      connect();
    }, delay);
  }

  function connect(): void {
    if (manual_close) {
      return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    clear_reconnect_timer();
    const socket = new WebSocket(ws_url);
    ws = socket;
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      if (ws !== socket) {
        return;
      }
      reconnect_attempt = 0;
      console.log("[WS] Connected");
      // The network path may have changed; let fresh samples re-lock the
      // clock offset instead of trusting a stale lowest-ping estimate.
      time_sync.lowest_ping = Infinity;
      send_time_request_if_open();
      clear_heartbeat();
      for (const room of watched_rooms.values()) {
        socket.send(watch_message(room));
      }
      flush_pending_posts_if_open();
      heartbeat_id = setInterval(send_time_request_if_open, 2000);
    });

    socket.addEventListener("message", (event) => {
      const data =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : new Uint8Array(event.data);
      const msg = message_decode(data);

      switch (msg.$) {
        case "info_time": {
          // Only accept the reply to the most recent request. Without this,
          // a late reply matched against a newer request computes a bogus
          // tiny ping and permanently locks a wrong clock offset.
          if (msg.nonce !== time_sync.request_nonce) {
            break;
          }
          const t = client_now();
          const ping = t - time_sync.request_sent_at;

          time_sync.last_ping = ping;
          time_sync.avg_ping = isFinite(time_sync.avg_ping)
            ? (0.8 * time_sync.avg_ping) + (0.2 * ping)
            : ping;

          if (ping < time_sync.lowest_ping) {
            const local_avg = Math.floor((time_sync.request_sent_at + t) / 2);
            time_sync.clock_offset = msg.time - local_avg;
            time_sync.lowest_ping = ping;
          }

          if (!is_synced) {
            is_synced = true;
            for (const cb of sync_listeners) {
              cb();
            }
            sync_listeners.length = 0;
          }
          break;
        }

        case "info_post": {
          const cursor = room_cursors.get(msg.room) ?? 0;
          if (msg.index >= cursor) {
            room_cursors.set(msg.room, msg.index + 1);
          }
          const watcher = room_watchers.get(msg.room);
          if (watcher && watcher.handler) {
            watcher.handler({
              $: "post",
              post: {
                index: msg.index,
                server_time: msg.server_time,
                client_time: msg.client_time,
                name: msg.name,
                check: check_from_wire(msg.check),
                data: packed_decode(watcher.packer, msg.payload),
              },
            });
          }
          break;
        }

        case "checkpoint": {
          const watcher = room_watchers.get(msg.room);
          if (watcher && watcher.handler) {
            watcher.handler({
              $: "checkpoint",
              latest_index: msg.latest_index,
              server_time: msg.server_time,
            });
          }
          break;
        }
      }
    });

    socket.addEventListener("close", (event) => {
      if (ws !== socket) {
        return;
      }
      clear_heartbeat();
      ws = null;
      if (manual_close) {
        return;
      }
      console.warn(`[WS] Disconnected (code=${event.code}); reconnecting...`);
      schedule_reconnect();
    });

    socket.addEventListener("error", () => {
      // Let close/reconnect handle transport failures.
    });
  }

  connect();

  return {
    on_sync: (callback) => {
      if (is_synced) {
        callback();
        return;
      }
      sync_listeners.push(callback);
    },
    watch: (room, packer, handler) => {
      register_handler(room, packer, handler);
      watched_rooms.add(room);
      send_or_reconnect(watch_message(room));
    },
    post: (room, data, packer, check) => {
      const name = name_gen();
      const message = message_encode({
        $: "post",
        room,
        time: server_time(),
        name,
        check: check_to_wire(check ?? null),
        payload: packed_encode(packer, data),
      });
      if (pending_posts.length > 0) {
        flush_pending_posts_if_open();
      }
      if (!try_send(message)) {
        queue_post(message);
      }
      return name;
    },
    server_time,
    // Smoothed RTT: raw samples jitter, and the render lag derived from
    // ping would jump around frame to frame otherwise.
    ping: () => time_sync.avg_ping,
    close: () => {
      manual_close = true;
      clear_reconnect_timer();
      clear_heartbeat();
      if (ws && ws.readyState === WebSocket.OPEN) {
        for (const room of watched_rooms.values()) {
          try {
            ws.send(message_encode({ $: "unwatch", room }));
          } catch {
            break;
          }
        }
      }
      if (ws) {
        ws.close();
      }
      ws = null;
    },
    debug_dump: () => ({
      ws_url,
      ws_ready_state: ws ? ws.readyState : WebSocket.CLOSED,
      is_synced,
      reconnect_attempt,
      reconnect_scheduled: reconnect_timer_id !== null,
      pending_post_count: pending_posts.length,
      watched_rooms: Array.from(watched_rooms.values()),
      room_cursors: Object.fromEntries(room_cursors.entries()),
      room_watchers: Array.from(room_watchers.keys()),
      sync_listener_count: sync_listeners.length,
      time_sync: { ...time_sync },
    }),
  };
}

// VibiNet
// -------
//
// The game object. Rendering uses two states per frame:
// - local_state:  current tick, including local predictions (instant input).
// - remote_state: a stable past tick, `max(tolerance, half_rtt + 1 tick)`
//   behind, where rollbacks are not expected.
// `smooth(remote, local)` blends them; the default returns remote. Games
// typically keep the local player from `local` and everyone else from
// `remote`.

const MEMO_SLOTS = 4;

export class VibiNet<S, P> {
  static game = VibiNet;

  room:       string;
  packer:     Packed;
  tick_rate:  number;
  tolerance:  number;
  smooth:     (remote: S, local: S) => S;
  cfg:        Config<S, P>;
  engine:     Engine<S, P>;
  client_api: ClientApi<P>;

  private memos: Array<{ tick: number; state: S }>;
  private on_desync_cb: ((info: Desync) => void) | null;
  private desync_fired: boolean;

  constructor(options: Options<S, P>) {
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
    this.engine        = engine_new(this.cfg);
    this.client_api    = options.client ?? client_new<P>(options.server);
    this.memos         = [];
    this.on_desync_cb  = options.on_desync ?? null;
    this.desync_fired  = false;

    this.client_api.on_sync(() => {
      this.client_api.watch(this.room, this.packer, (event) => {
        this.on_event(event);
      });
    });
  }

  // Send an input. It applies locally right away (prediction) and is
  // replaced by the server echo. Throws if called before on_sync.
  post(data: P): void {
    const check = engine_check(this.engine);
    const name  = this.client_api.post(this.room, data, this.packer, check);
    const t     = this.server_time();
    this.engine = engine_step(this.engine, {
      $: "local_post",
      post: { name, client_time: t, data },
    }, this.cfg);
    this.invalidate(this.time_to_tick(t));
  }

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
    const state = engine_state_at(this.engine, tick, this.cfg, hint);
    this.remember(tick, state);
    return state;
  }

  time_to_tick(ms: number): number {
    return time_to_tick(ms, this.tick_rate);
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

  static name_gen(): string {
    return name_gen();
  }

  private on_event(event: Event<P>): void {
    if (event.$ === "post") {
      // The post invalidates computed states from its tick on; if it echoes
      // a local prediction, from the prediction's tick on.
      let dirty = post_tick(event.post, this.cfg);
      const name = event.post.name;
      if (name !== undefined) {
        const local = this.engine.locals.get(name);
        if (local) {
          dirty = Math.min(dirty, this.time_to_tick(local.client_time));
        }
      }
      this.engine = engine_step(this.engine, event, this.cfg);
      this.invalidate(dirty);
      this.report_desync();
    } else {
      // Checkpoints only advance finalization; past states stay valid.
      this.engine = engine_step(this.engine, event, this.cfg);
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

type PackedAlias = Packed;
type OptionsAlias<S, P> = Options<S, P>;

export namespace VibiNet {
  export type Packed = PackedAlias;
  export type Options<S, P> = OptionsAlias<S, P>;
}
