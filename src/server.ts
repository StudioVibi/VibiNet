import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { readFile as read_file } from "fs/promises";
import { resolve as resolve_path, sep as path_sep } from "path";
import { decode_message, encode_message } from "./protocol.ts";
import { append_post, ensure_db_dir, get_post_count, is_valid_room, read_posts } from "./storage.ts";

declare const Bun: any;

// Build walkers bundle on startup (idempotent)
async function build_walkers() {
  try {
    const r1 = Bun.spawnSync({ cmd: ["bun", "build", "src/client.ts", "--outdir", "walkers/dist", "--target=browser", "--format=esm"] });
    const r2 = Bun.spawnSync({ cmd: ["bun", "build", "src/vibi.ts", "--outdir", "walkers/dist", "--target=browser", "--format=esm"] });
    const r3 = Bun.spawnSync({ cmd: ["bun", "build", "walkers/index.ts", "--outdir", "walkers/dist", "--target=browser", "--format=esm"] });
    if (!r1.success || !r2.success || !r3.success) {
      console.error("[BUILD] walkers build failed", { r1: r1.success, r2: r2.success, r3: r3.success });
    } else {
      console.log("[BUILD] walkers bundle ready");
    }
  } catch (e) {
    console.error("[BUILD] error while building walkers:", e);
  }
}

await build_walkers();

// Simple static server + WebSocket on the same port
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";

    // Only serve files strictly inside the walkers directory.
    const walkers_root = resolve_path("walkers");
    const filesystem_path = resolve_path(`walkers${path}`);
    if (!filesystem_path.startsWith(walkers_root + path_sep)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    let ct = "application/octet-stream";
    if (path.endsWith(".html")) {
      ct = "text/html";
    } else if (path.endsWith(".js")) {
      ct = "application/javascript";
    } else if (path.endsWith(".css")) {
      ct = "text/css";
    } else if (path.endsWith(".map")) {
      ct = "application/json";
    }

    const data = await read_file(filesystem_path);
    res.writeHead(200, { "Content-Type": ct });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

// Posts are tiny inputs; cap frames to keep memory bounded.
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

// Monotone server clock. Post server_times MUST be non-decreasing in index
// (the client replay-safety frontier depends on it), so never let a wall
// clock step backwards leak into assigned times.
let last_now = 0;
function now(): number {
  last_now = Math.max(last_now, Math.floor(Date.now()));
  return last_now;
}

type RoomStreamState = {
  watching: boolean;
  next_to_send: number;
  drain_active: boolean;
};

type ConnectionState = {
  rooms: Map<string, RoomStreamState>;
};

const watchers = new Map<string, Set<WebSocket>>();
const connection_states = new WeakMap<WebSocket, ConnectionState>();
const connection_liveness = new WeakMap<WebSocket, boolean>();

const ws_heartbeat_interval_id = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) {
      continue;
    }
    const is_alive = connection_liveness.get(ws);
    if (is_alive === false) {
      ws.terminate();
      continue;
    }
    connection_liveness.set(ws, false);
    ws.ping();
  }
}, 30000);

function checkpoint_message(room: string): Uint8Array {
  return encode_message({
    $: "checkpoint",
    room,
    latest_index: get_post_count(room) - 1,
    server_time: now(),
  });
}

// Periodically prove stream completeness to watchers so client-side
// finalization keeps advancing even in quiet rooms.
const CHECKPOINT_MS = Number(process.env.CHECKPOINT_MS ?? 1000);
const checkpoint_interval_id = setInterval(() => {
  for (const [room, room_watchers] of watchers.entries()) {
    const message = checkpoint_message(room);
    for (const ws of room_watchers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }
}, CHECKPOINT_MS);

ensure_db_dir();

function as_uint8_array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  return new Uint8Array(data as ArrayBufferLike);
}

function get_connection_state(ws: WebSocket): ConnectionState {
  let state = connection_states.get(ws);
  if (state) {
    return state;
  }
  state = { rooms: new Map() };
  connection_states.set(ws, state);
  return state;
}

function get_room_stream_state(ws: WebSocket, room: string): RoomStreamState {
  const conn = get_connection_state(ws);
  let room_state = conn.rooms.get(room);
  if (room_state) {
    return room_state;
  }
  room_state = {
    watching: false,
    next_to_send: 0,
    drain_active: false,
  };
  conn.rooms.set(room, room_state);
  return room_state;
}

function remove_watcher(ws: WebSocket, room: string): void {
  const set = watchers.get(room);
  if (!set) {
    return;
  }
  set.delete(ws);
  if (set.size === 0) {
    watchers.delete(room);
  }
}

function add_watcher(ws: WebSocket, room: string): void {
  let set = watchers.get(room);
  if (!set) {
    set = new Set();
    watchers.set(room, set);
  }
  set.add(ws);
}

function drain_room(ws: WebSocket, room: string, state: RoomStreamState): void {
  if (state.drain_active) {
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  state.drain_active = true;
  try {
    for (;;) {
      const next = state.next_to_send;
      const count = get_post_count(room);
      if (next >= count) {
        break;
      }
      // Read in batches with a single file descriptor.
      const batch = read_posts(room, next, 256);
      if (batch.length === 0) {
        break;
      }
      for (let i = 0; i < batch.length; i++) {
        const post = batch[i];
        ws.send(
          encode_message({
            $: "info_post",
            room,
            index: next + i,
            server_time: post.server_time,
            client_time: post.client_time,
            name: post.name,
            check: post.check_tick > 0
              ? { $: "some", tick: post.check_tick, hash: post.check_hash }
              : { $: "none" },
            payload: post.payload,
          })
        );
      }
      state.next_to_send = next + batch.length;
    }
  } finally {
    state.drain_active = false;
  }
}

wss.on("connection", (ws) => {
  connection_liveness.set(ws, true);
  ws.on("pong", () => {
    connection_liveness.set(ws, true);
  });

  ws.on("message", (buffer) => {
    // Never let a malformed or malicious frame crash the process.
    let message;
    try {
      message = decode_message(as_uint8_array(buffer));
    } catch {
      return;
    }
    if ("room" in message && !is_valid_room(message.room)) {
      return;
    }
    switch (message.$) {
      case "get_time":
        ws.send(encode_message({ $: "info_time", nonce: message.nonce, time: now() }));
        break;
      case "post": {
        const server_time = now();
        // Clamp client_time to the past: official_time already clamps the
        // past side with `tolerance`; clamping the future side here keeps
        // posts from being scheduled at arbitrary future ticks (cheat and
        // frontier-corruption vector). Stored once, so replay stays
        // deterministic for every client.
        const client_time = Math.min(Math.floor(message.time), server_time);
        const room = message.room;
        const name = message.name;
        const payload = message.payload;

        const check = message.check;
        const index = append_post(room, {
          server_time,
          client_time,
          check_tick: check.$ === "some" ? check.tick : 0,
          check_hash: check.$ === "some" ? check.hash : 0,
          name,
          payload,
        });

        const room_watchers = watchers.get(room);
        if (room_watchers) {
          for (const watcher of room_watchers) {
            const stream = get_room_stream_state(watcher, room);
            drain_room(watcher, room, stream);
          }
        }
        break;
      }
      case "watch": {
        const room = message.room;
        const from = Math.max(0, Math.floor(message.from || 0));
        const stream = get_room_stream_state(ws, room);
        // Never rewind already-sent indices; preserve contiguous delivery.
        stream.next_to_send = Math.max(stream.next_to_send, from);
        stream.watching = true;
        add_watcher(ws, room);
        drain_room(ws, room, stream);
        // Immediate checkpoint so a fresh watcher can finalize right away.
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(checkpoint_message(room));
        }
        break;
      }
      case "unwatch": {
        const room = message.room;
        const stream = get_room_stream_state(ws, room);
        stream.watching = false;
        remove_watcher(ws, room);
        break;
      }
    }
  });

  ws.on("close", () => {
    connection_liveness.delete(ws);
    const conn = connection_states.get(ws);
    if (!conn) {
      return;
    }
    for (const [room, stream] of conn.rooms.entries()) {
      if (stream.watching) {
        remove_watcher(ws, room);
      }
    }
    connection_states.delete(ws);
  });
});

server.on("close", () => {
  clearInterval(ws_heartbeat_interval_id);
  clearInterval(checkpoint_interval_id);
});

server.listen(port, host, () => {
  console.log(`Server running at http://${host}:${port} (HTTP + WebSocket)`);
});
