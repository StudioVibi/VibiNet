import { decode, encode, Packed } from "./packer.ts";
import { decode_message, encode_message } from "./protocol.ts";
import { OFFICIAL_SERVER_URL, normalize_ws_url } from "./server_url.ts";

export type ClientApi<P> = {
  on_sync: (callback: () => void) => void;
  watch: (room: string, packer: Packed, handler?: (post: any) => void) => void;
  load: (room: string, from: number, packer: Packed) => void;
  post: (room: string, data: P, packer: Packed) => string;
  server_time: () => number;
  ping: () => number;
  close: () => void;
};

type TimeSync = {
  clock_offset: number;
  lowest_ping: number;
  request_sent_at: number;
  last_ping: number;
};

type MessageHandler = (message: any) => void;
type RoomWatcher = { handler?: MessageHandler; packer: Packed };

function now(): number {
  return Math.floor(Date.now());
}

function default_ws_url(): string {
  return OFFICIAL_SERVER_URL;
}

export function gen_name(): string {
  const alphabet = "_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
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

export function create_client<P>(server?: string): ClientApi<P> {
  const time_sync: TimeSync = {
    clock_offset: Infinity,
    lowest_ping: Infinity,
    request_sent_at: 0,
    last_ping: Infinity,
  };

  const room_watchers = new Map<string, RoomWatcher>();
  let is_synced = false;
  const sync_listeners: Array<() => void> = [];

  const ws_url = normalize_ws_url(server ?? default_ws_url());
  const ws = new WebSocket(ws_url);
  ws.binaryType = "arraybuffer";

  function server_time(): number {
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

  function register_handler(room: string, packer: Packed, handler?: MessageHandler): void {
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
        const t = now();
        const ping = t - time_sync.request_sent_at;

        time_sync.last_ping = ping;

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
        const watcher = room_watchers.get(msg.room);
        if (watcher && watcher.handler) {
          const data = decode(watcher.packer, msg.payload);
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
      send(encode_message({ $: "watch", room }));
    },
    load: (room, from, packer) => {
      register_handler(room, packer);
      send(encode_message({ $: "load", room, from }));
    },
    post: (room, data, packer) => {
      const name = gen_name();
      const payload = encode(packer, data);
      send(encode_message({ $: "post", room, time: server_time(), name, payload }));
      return name;
    },
    server_time,
    ping: () => time_sync.last_ping,
    close: () => ws.close(),
  };
}
