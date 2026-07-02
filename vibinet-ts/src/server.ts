// The server side of VibiNet: a WebSocket + static HTTP server (entry
// point: `bun run vibinet-ts/src/server.ts`). Everything impure that runs
// on the server lives here:
// - Store: append-only disk storage of posts, one .dat/.idx pair per room
//          (files are named by the room's 64-bit code as 16 hex digits).
// - Net:   watcher bookkeeping, contiguous per-client streams, checkpoints.
// - Http:  static file serving for the walkers demo.
//
// The server is intentionally game-agnostic: it timestamps, stores, and
// redistributes opaque post payloads. All game semantics live client-side
// (see src/vibinet.ts).
//
// Environment:
// - PORT (default 8080), HOST (default 0.0.0.0)
// - CHECKPOINT_MS (default 1000): checkpoint broadcast period; lower values
//   shrink the clients' pending window.

import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { readFile as read_file } from "fs/promises";
import { resolve as resolve_path, sep as path_sep } from "path";
import { fileURLToPath as file_url_to_path } from "url";
import {
  appendFileSync as append_file_sync,
  existsSync as exists_sync,
  mkdirSync as mkdir_sync,
  openSync as open_sync,
  closeSync as close_sync,
  readFileSync as read_file_sync,
  readSync as read_sync,
  statSync as stat_sync,
  writeFileSync as write_file_sync,
} from "fs";
import { message_decode, message_encode, nick_hex } from "./vibinet.ts";

declare const Bun: any;

// Types
// -----

// One post as stored on disk. check_tick 0 means "no checksum" (tick 0
// predates any real room).
type StoredPost = {
  server_time: number;
  client_time: number;
  check_tick: number;
  check_hash: number;
  name: string;
  payload: Uint8Array;
};

// Per-room storage handle: .dat holds records, .idx holds u64 offsets.
type Store = {
  dat_path: string;
  idx_path: string;
  offsets: number[];
  dat_size: number;
  read_fd: number | null;
};

// Per-connection, per-room delivery stream (contiguous, gapless).
type Stream = {
  watching: boolean;
  next_to_send: number;
  drain_active: boolean;
};

type Conn = {
  rooms: Map<string, Stream>;
};

// Time
// ----

// Monotone server clock. Post server_times MUST be non-decreasing in index
// (the client replay-safety frontier depends on it), so never let a wall
// clock step backwards leak into assigned times.
let time_last = 0;

function time_now(): number {
  time_last = Math.max(time_last, Math.floor(Date.now()));
  return time_last;
}

// Record
// ------
//
// Record format (inside .dat), all little-endian, length prefix outside:
//   [u32 record_len][u64 server_time][u64 client_time]
//   [u64 check_tick][u32 check_hash][u32 name_len][name][u32 payload_len][payload]

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const MAX_SAFE_U64 = BigInt(Number.MAX_SAFE_INTEGER);

function record_encode(post: StoredPost): Uint8Array {
  const name = TEXT_ENCODER.encode(post.name);
  const size = 8 + 8 + 8 + 4 + 4 + name.length + 4 + post.payload.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, BigInt(post.server_time), true);
  view.setBigUint64(8, BigInt(post.client_time), true);
  view.setBigUint64(16, BigInt(post.check_tick), true);
  view.setUint32(24, post.check_hash >>> 0, true);
  view.setUint32(28, name.length, true);
  buf.set(name, 32);
  view.setUint32(32 + name.length, post.payload.length, true);
  buf.set(post.payload, 36 + name.length);
  return buf;
}

function record_u64(view: DataView, pos: number): number {
  const value = view.getBigUint64(pos, true);
  if (value > MAX_SAFE_U64) {
    throw new RangeError("u64 value exceeds Number.MAX_SAFE_INTEGER");
  }
  return Number(value);
}

function record_decode(buf: Uint8Array): StoredPost {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const server_time = record_u64(view, 0);
  const client_time = record_u64(view, 8);
  const check_tick = record_u64(view, 16);
  const check_hash = view.getUint32(24, true);
  const name_len = view.getUint32(28, true);
  const name = TEXT_DECODER.decode(buf.subarray(32, 32 + name_len));
  const payload_len = view.getUint32(32 + name_len, true);
  const payload = buf.subarray(36 + name_len, 36 + name_len + payload_len);
  return { server_time, client_time, check_tick, check_hash, name, payload };
}

// Store
// -----

// All paths are anchored to the repo root (this file lives at
// vibinet-ts/src/server.ts), so the server works from any cwd.
const ROOT_DIR = resolve_path(file_url_to_path(new URL("../..", import.meta.url)));
const DATA_DIR = `${ROOT_DIR}/data`;
const STORES = new Map<string, Store>();

function store_dir(): void {
  if (!exists_sync(DATA_DIR)) {
    mkdir_sync(DATA_DIR);
  }
}

function store_index_load(idx_path: string): number[] {
  if (!exists_sync(idx_path)) {
    return [];
  }
  const data = read_file_sync(idx_path);
  if (data.length % 8 !== 0) {
    throw new Error(`Corrupt index file: ${idx_path}`);
  }
  const count = data.length / 8;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const offsets = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const off = view.getBigUint64(i * 8, true);
    if (off > MAX_SAFE_U64) {
      throw new RangeError("Offset exceeds Number.MAX_SAFE_INTEGER");
    }
    offsets[i] = Number(off);
  }
  return offsets;
}

// Rebuild the .idx from the .dat by walking record length prefixes
// (recovers from a missing or deleted index).
function store_index_rebuild(dat_path: string, idx_path: string): { offsets: number[]; dat_size: number } {
  if (!exists_sync(dat_path)) {
    return { offsets: [], dat_size: 0 };
  }
  const size = stat_sync(dat_path).size;
  const fd = open_sync(dat_path, "r");
  const offsets: number[] = [];
  let offset = 0;
  const len_buf = Buffer.allocUnsafe(4);
  try {
    while (offset + 4 <= size) {
      read_sync(fd, len_buf, 0, 4, offset);
      const len = new DataView(len_buf.buffer, len_buf.byteOffset, len_buf.byteLength).getUint32(0, true);
      const next = offset + 4 + len;
      if (next > size) {
        break;
      }
      offsets.push(offset);
      offset = next;
    }
  } finally {
    close_sync(fd);
  }
  const idx_buf = Buffer.allocUnsafe(offsets.length * 8);
  const view = new DataView(idx_buf.buffer, idx_buf.byteOffset, idx_buf.byteLength);
  for (let i = 0; i < offsets.length; i++) {
    view.setBigUint64(i * 8, BigInt(offsets[i]), true);
  }
  write_file_sync(idx_path, idx_buf);
  return { offsets, dat_size: offset };
}

function store_get(room: string): Store {
  let store = STORES.get(room);
  if (store) {
    return store;
  }
  // Rooms are 64-bit ids; file names use the 16-hex-digit code, which is
  // filesystem-safe by construction (and case-collision-free on macOS).
  const hex = nick_hex(room);
  if (hex === null) {
    throw new Error(`Invalid room nick: ${JSON.stringify(room)}`);
  }
  const dat_path = `${DATA_DIR}/${hex}.dat`;
  const idx_path = `${DATA_DIR}/${hex}.idx`;
  let offsets: number[] = [];
  let dat_size = 0;
  if (exists_sync(idx_path)) {
    offsets = store_index_load(idx_path);
    dat_size = exists_sync(dat_path) ? stat_sync(dat_path).size : 0;
  } else if (exists_sync(dat_path)) {
    const rebuilt = store_index_rebuild(dat_path, idx_path);
    offsets = rebuilt.offsets;
    dat_size = rebuilt.dat_size;
  }
  store = { dat_path, idx_path, offsets, dat_size, read_fd: null };
  STORES.set(room, store);
  return store;
}

function store_fd(store: Store): number {
  if (store.read_fd === null) {
    store.read_fd = open_sync(store.dat_path, "r");
  }
  return store.read_fd;
}

function store_append(room: string, post: StoredPost): number {
  store_dir();
  const store = store_get(room);
  const record = record_encode(post);
  // Single write for [len][record]: fewer syscalls and no torn record if the
  // process dies between two appends.
  const rec_buf = Buffer.allocUnsafe(4 + record.length);
  new DataView(rec_buf.buffer, rec_buf.byteOffset, rec_buf.byteLength).setUint32(0, record.length, true);
  rec_buf.set(record, 4);

  const offset = store.dat_size;
  append_file_sync(store.dat_path, rec_buf);

  const idx_buf = Buffer.allocUnsafe(8);
  new DataView(idx_buf.buffer, idx_buf.byteOffset, idx_buf.byteLength).setBigUint64(0, BigInt(offset), true);
  append_file_sync(store.idx_path, idx_buf);

  store.offsets.push(offset);
  store.dat_size += 4 + record.length;
  return store.offsets.length - 1;
}

function store_count(room: string): number {
  return store_get(room).offsets.length;
}

// Read up to `max` posts starting at index `from`, reusing one fd per room.
function store_read(room: string, from: number, max: number): StoredPost[] {
  const store = store_get(room);
  const start = Math.max(0, from);
  const end = Math.min(store.offsets.length, start + Math.max(0, max));
  if (start >= end) {
    return [];
  }
  const fd = store_fd(store);
  const len_buf = Buffer.allocUnsafe(4);
  const out: StoredPost[] = [];
  for (let index = start; index < end; index++) {
    const offset = store.offsets[index];
    read_sync(fd, len_buf, 0, 4, offset);
    const len = new DataView(len_buf.buffer, len_buf.byteOffset, len_buf.byteLength).getUint32(0, true);
    const rec_buf = Buffer.allocUnsafe(len);
    read_sync(fd, rec_buf, 0, len, offset + 4);
    out.push(record_decode(rec_buf));
  }
  return out;
}

// Bytes
// -----

function bytes_of(data: unknown): Uint8Array {
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

// Conn
// ----

const WATCHERS = new Map<string, Set<WebSocket>>();
const CONNS = new WeakMap<WebSocket, Conn>();
const LIVENESS = new WeakMap<WebSocket, boolean>();

function conn_get(ws: WebSocket): Conn {
  let conn = CONNS.get(ws);
  if (conn) {
    return conn;
  }
  conn = { rooms: new Map() };
  CONNS.set(ws, conn);
  return conn;
}

function conn_stream(ws: WebSocket, room: string): Stream {
  const conn = conn_get(ws);
  let stream = conn.rooms.get(room);
  if (stream) {
    return stream;
  }
  stream = { watching: false, next_to_send: 0, drain_active: false };
  conn.rooms.set(room, stream);
  return stream;
}

// Watcher
// -------

function watcher_add(ws: WebSocket, room: string): void {
  let set = WATCHERS.get(room);
  if (!set) {
    set = new Set();
    WATCHERS.set(room, set);
  }
  set.add(ws);
}

function watcher_remove(ws: WebSocket, room: string): void {
  const set = WATCHERS.get(room);
  if (!set) {
    return;
  }
  set.delete(ws);
  if (set.size === 0) {
    WATCHERS.delete(room);
  }
}

// Stream
// ------

// Send every stored post the stream hasn't seen yet, in order, gapless.
function stream_drain(ws: WebSocket, room: string, stream: Stream): void {
  if (stream.drain_active) {
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  stream.drain_active = true;
  try {
    for (;;) {
      const next = stream.next_to_send;
      const count = store_count(room);
      if (next >= count) {
        break;
      }
      // Read in batches with a single file descriptor.
      const batch = store_read(room, next, 256);
      if (batch.length === 0) {
        break;
      }
      for (let i = 0; i < batch.length; i++) {
        const post = batch[i];
        ws.send(
          message_encode({
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
      stream.next_to_send = next + batch.length;
    }
  } finally {
    stream.drain_active = false;
  }
}

// Checkpoint
// ----------

function checkpoint_encode(room: string): Uint8Array {
  return message_encode({
    $: "checkpoint",
    room,
    latest_index: store_count(room) - 1,
    server_time: time_now(),
  });
}

// Socket
// ------

function socket_message(ws: WebSocket, buffer: unknown): void {
  // Never let a malformed or malicious frame crash the process.
  let message;
  try {
    message = message_decode(bytes_of(buffer));
  } catch {
    return;
  }
  switch (message.$) {
    case "get_time": {
      ws.send(message_encode({ $: "info_time", nonce: message.nonce, time: time_now() }));
      break;
    }
    case "post": {
      const server_time = time_now();
      // Clamp client_time to the past: post_time already clamps the past
      // side with `tolerance`; clamping the future side here keeps posts
      // from being scheduled at arbitrary future ticks (cheat and
      // frontier-corruption vector). Stored once, so replay stays
      // deterministic for every client.
      const client_time = Math.min(Math.floor(message.time), server_time);
      const check = message.check;
      store_append(message.room, {
        server_time,
        client_time,
        check_tick: check.$ === "some" ? check.tick : 0,
        check_hash: check.$ === "some" ? check.hash : 0,
        name: message.name,
        payload: message.payload,
      });

      const room_watchers = WATCHERS.get(message.room);
      if (room_watchers) {
        for (const watcher of room_watchers) {
          stream_drain(watcher, message.room, conn_stream(watcher, message.room));
        }
      }
      break;
    }
    case "watch": {
      const from = Math.max(0, Math.floor(message.from || 0));
      const stream = conn_stream(ws, message.room);
      // Never rewind already-sent indices; preserve contiguous delivery.
      stream.next_to_send = Math.max(stream.next_to_send, from);
      stream.watching = true;
      watcher_add(ws, message.room);
      stream_drain(ws, message.room, stream);
      // Immediate checkpoint so a fresh watcher can finalize right away.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(checkpoint_encode(message.room));
      }
      break;
    }
    case "unwatch": {
      const stream = conn_stream(ws, message.room);
      stream.watching = false;
      watcher_remove(ws, message.room);
      break;
    }
  }
}

function socket_close(ws: WebSocket): void {
  LIVENESS.delete(ws);
  const conn = CONNS.get(ws);
  if (!conn) {
    return;
  }
  for (const [room, stream] of conn.rooms.entries()) {
    if (stream.watching) {
      watcher_remove(ws, room);
    }
  }
  CONNS.delete(ws);
}

// Http
// ----

async function http_handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    let path = decodeURIComponent(url.pathname);
    if (path === "/") {
      path = "/index.html";
    }

    // Only serve files strictly inside the demo directory.
    const walkers_root = resolve_path(`${ROOT_DIR}/demo/walkers`);
    const filesystem_path = resolve_path(`${ROOT_DIR}/demo/walkers${path}`);
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
}

// Walkers
// -------

// Build the walkers demo bundle on startup (idempotent).
async function walkers_build(): Promise<void> {
  try {
    const result = Bun.spawnSync({
      cmd: ["bun", "build", `${ROOT_DIR}/demo/walkers/index.ts`, "--outdir", `${ROOT_DIR}/demo/walkers/dist`, "--target=browser", "--format=esm"],
    });
    if (!result.success) {
      console.error("[BUILD] walkers build failed");
    } else {
      console.log("[BUILD] walkers bundle ready");
    }
  } catch (e) {
    console.error("[BUILD] error while building walkers:", e);
  }
}

// Main
// ----

await walkers_build();
store_dir();

const server = http.createServer(http_handle);

// Posts are tiny inputs; cap frames to keep memory bounded.
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

const heartbeat_interval_id = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) {
      continue;
    }
    const is_alive = LIVENESS.get(ws);
    if (is_alive === false) {
      ws.terminate();
      continue;
    }
    LIVENESS.set(ws, false);
    ws.ping();
  }
}, 30000);

// Periodically prove stream completeness to watchers so client-side
// finalization keeps advancing even in quiet rooms.
const CHECKPOINT_MS = Number(process.env.CHECKPOINT_MS ?? 1000);
const checkpoint_interval_id = setInterval(() => {
  for (const [room, room_watchers] of WATCHERS.entries()) {
    const message = checkpoint_encode(room);
    for (const ws of room_watchers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }
}, CHECKPOINT_MS);

wss.on("connection", (ws) => {
  LIVENESS.set(ws, true);
  ws.on("pong", () => {
    LIVENESS.set(ws, true);
  });
  ws.on("message", (buffer) => {
    socket_message(ws, buffer);
  });
  ws.on("close", () => {
    socket_close(ws);
  });
});

server.on("close", () => {
  clearInterval(heartbeat_interval_id);
  clearInterval(checkpoint_interval_id);
});

server.listen(port, host, () => {
  console.log(`Server running at http://${host}:${port} (HTTP + WebSocket)`);
});
