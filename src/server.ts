import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { readFile as read_file } from "fs/promises";
import { decode_message, encode_message } from "./protocol.ts";
import { append_post, ensure_db_dir, get_post, get_post_count } from "./storage.ts";

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
    let path = url.pathname;
    if (path === "/") path = "/index.html";

    let filesystem_path: string;
    filesystem_path = path.startsWith("/dist/") ? `walkers${path}` : `walkers${path}`;

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

const wss = new WebSocketServer({ server });
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

function now(): number {
  return Math.floor(Date.now());
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

setInterval(() => {
  console.log("Server time:", now());
}, 1000);

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

function send_info_post(
  ws: WebSocket,
  room: string,
  index: number,
  post: {
    server_time: number;
    client_time: number;
    name: string;
    payload: Uint8Array;
  }
): void {
  ws.send(
    encode_message({
      $: "info_post",
      room,
      index,
      server_time: post.server_time,
      client_time: post.client_time,
      name: post.name,
      payload: post.payload,
    })
  );
}

function drain_room(
  ws: WebSocket,
  room: string,
  state: RoomStreamState,
  max_index_exclusive?: number
): void {
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
      const limit = max_index_exclusive === undefined
        ? count
        : Math.min(count, max_index_exclusive);
      if (next >= limit) {
        break;
      }
      const post = get_post(room, next);
      if (!post) {
        break;
      }
      send_info_post(ws, room, next, post);
      state.next_to_send = next + 1;
    }
  } finally {
    state.drain_active = false;
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (buffer) => {
    const message = decode_message(as_uint8_array(buffer));
    switch (message.$) {
      case "get_time":
        ws.send(encode_message({ $: "info_time", time: now() }));
        break;
      case "post": {
        const server_time = now();
        const client_time = Math.floor(message.time);
        const room = message.room;
        const name = message.name;
        const payload = message.payload;

        const index = append_post(room, {
          server_time,
          client_time,
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
      case "load": {
        const room = message.room;
        const from = Math.max(0, message.from || 0);
        const stream = get_room_stream_state(ws, room);
        // Never rewind already-sent indices; preserve contiguous delivery.
        stream.next_to_send = Math.max(stream.next_to_send, from);
        const one_shot_limit = stream.watching ? undefined : get_post_count(room);
        drain_room(ws, room, stream, one_shot_limit);
        break;
      }
      case "watch": {
        const room = message.room;
        const stream = get_room_stream_state(ws, room);
        stream.watching = true;
        add_watcher(ws, room);
        drain_room(ws, room, stream);
        console.log("Watching:", { room });
        break;
      }
      case "unwatch": {
        const room = message.room;
        const stream = get_room_stream_state(ws, room);
        stream.watching = false;
        remove_watcher(ws, room);
        console.log("Unwatching:", { room });
        break;
      }
      case "get_latest_post_index": {
        const room = message.room;
        ws.send(
          encode_message({
            $: "info_latest_post_index",
            room,
            latest_index: get_post_count(room) - 1,
            server_time: now(),
          })
        );
        break;
      }
    }
  });

  ws.on("close", () => {
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

server.listen(port, host, () => {
  console.log(`Server running at http://${host}:${port} (HTTP + WebSocket)`);
});
