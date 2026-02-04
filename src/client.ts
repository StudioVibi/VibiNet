import { decode, encode, Packed } from "./packer.ts";
import { decode_message, encode_message } from "./protocol.ts";

type TimeSync = {
  clock_offset: number;     // difference between server clock and local clock
  lowest_ping: number;      // best round-trip time achieved so far
  request_sent_at: number;  // timestamp when last get_time request was sent
  last_ping: number;        // most recent measured RTT (ms)
};

const time_sync: TimeSync = {
  clock_offset: Infinity,
  lowest_ping: Infinity,
  request_sent_at: 0,
  last_ping: Infinity,
};

const ws = new WebSocket(`ws://${window.location.hostname}:8080`);
ws.binaryType = "arraybuffer";

type MessageHandler = (message: any) => void;
type RoomWatcher = { handler?: MessageHandler; packed: Packed };
const room_watchers = new Map<string, RoomWatcher>();

let is_synced = false;
const sync_listeners: Array<() => void> = [];

function now(): number {
  return Math.floor(Date.now());
}

export function server_time(): number {
  if (!isFinite(time_sync.clock_offset)) {
    throw new Error("server_time() called before initial sync");
  }
  return Math.floor(now() + time_sync.clock_offset);
}

function ensure_open(): void {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket not open");
  }
}

function send(buf: Uint8Array): void {
  ensure_open();
  ws.send(buf);
}

function register_handler(room: string, packed: Packed, handler?: MessageHandler): void {
  const existing = room_watchers.get(room);
  if (existing) {
    if (existing.packed !== packed) {
      throw new Error(`Packed schema already registered for room: ${room}`);
    }
    if (handler) {
      existing.handler = handler;
    }
    return;
  }
  room_watchers.set(room, { handler, packed });
}

ws.addEventListener("open", () => {
  console.log("[WS] Connected");
  time_sync.request_sent_at = now();
  send(encode_message({ $: "get_time" }));
  setInterval(() => {
    time_sync.request_sent_at = now();
    send(encode_message({ $: "get_time" }));
  }, 2000);
});

ws.addEventListener("message", (event) => {
  const data =
    event.data instanceof ArrayBuffer
      ? new Uint8Array(event.data)
      : new Uint8Array(event.data);
  const msg = decode_message(data);

  switch (msg.$) {
    case "info_time": {
      const t    = now();
      const ping = t - time_sync.request_sent_at;

      time_sync.last_ping = ping;

      if (ping < time_sync.lowest_ping) {
        const local_avg    = Math.floor((time_sync.request_sent_at + t) / 2);
        time_sync.clock_offset = msg.time - local_avg;
        time_sync.lowest_ping  = ping;
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
      const watcher = room_watchers.get(msg.room);
      if (watcher && watcher.handler) {
        const data = decode(watcher.packed, msg.payload);
        watcher.handler({
          $: "info_post",
          room: msg.room,
          index: msg.index,
          server_time: msg.server_time,
          client_time: msg.client_time,
          name: msg.name,
          data,
        });
      }
      break;
    }
  }
});

// API
export function gen_name(): string {
  const alphabet   = "_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
  const bytes      = new Uint8Array(8);
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

export function post(room: string, data: any, packed: Packed): string {
  const name = gen_name();
  const payload = encode(packed, data);
  send(encode_message({ $: "post", room, time: server_time(), name, payload }));
  return name;
}

export function load(
  room: string,
  from: number = 0,
  packed: Packed,
  handler?: MessageHandler
): void {
  register_handler(room, packed, handler);
  send(encode_message({ $: "load", room, from }));
}

export function watch(room: string, packed: Packed, handler?: MessageHandler): void {
  register_handler(room, packed, handler);
  send(encode_message({ $: "watch", room }));
}

export function unwatch(room: string): void {
  room_watchers.delete(room);
  send(encode_message({ $: "unwatch", room }));
}

export function close(): void {
  ws.close();
}

export function on_sync(callback: () => void): void {
  if (is_synced) {
    callback();
    return;
  }
  sync_listeners.push(callback);
}

export function ping(): number {
  return time_sync.last_ping;
}
