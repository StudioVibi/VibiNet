import { decode, encode, Packed } from "./packer.ts";
import { decode_message, encode_message } from "./protocol.ts";
import { OFFICIAL_SERVER_URL, normalize_ws_url } from "./server_url.ts";

export type ClientApi<P> = {
  on_sync: (callback: () => void) => void;
  watch: (room: string, packer: Packed, handler?: (post: any) => void) => void;
  load: (
    room: string,
    from: number,
    packer: Packed,
    handler?: (post: any) => void
  ) => void;
  get_latest_post_index?: (room: string) => void;
  on_latest_post_index?: (
    callback: (info: { room: string; latest_index: number; server_time: number }) => void
  ) => void;
  post: (room: string, data: P, packer: Packed) => string;
  server_time: () => number;
  ping: () => number;
  close: () => void;
  debug_dump?: () => unknown;
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

function ws_state_name(ready_state: number): string {
  switch (ready_state) {
    case WebSocket.CONNECTING:
      return "CONNECTING";
    case WebSocket.OPEN:
      return "OPEN";
    case WebSocket.CLOSING:
      return "CLOSING";
    case WebSocket.CLOSED:
      return "CLOSED";
    default:
      return `UNKNOWN(${ready_state})`;
  }
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
  const latest_post_index_listeners: Array<
    (info: { room: string; latest_index: number; server_time: number }) => void
  > = [];
  let is_synced = false;
  const sync_listeners: Array<() => void> = [];
  let heartbeat_id: ReturnType<typeof setInterval> | null = null;

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

  function send_time_request_if_open(): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    time_sync.request_sent_at = now();
    ws.send(encode_message({ $: "get_time" }));
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
    send_time_request_if_open();
    if (heartbeat_id !== null) {
      clearInterval(heartbeat_id);
    }
    heartbeat_id = setInterval(send_time_request_if_open, 2000);
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
      case "info_latest_post_index": {
        for (const cb of latest_post_index_listeners) {
          cb({
            room: msg.room,
            latest_index: msg.latest_index,
            server_time: msg.server_time,
          });
        }
        break;
      }
    }
  });

  ws.addEventListener("close", () => {
    if (heartbeat_id !== null) {
      clearInterval(heartbeat_id);
      heartbeat_id = null;
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
    load: (room, from, packer, handler) => {
      register_handler(room, packer, handler);
      send(encode_message({ $: "load", room, from }));
    },
    get_latest_post_index: (room) => {
      send(encode_message({ $: "get_latest_post_index", room }));
    },
    on_latest_post_index: (callback) => {
      latest_post_index_listeners.push(callback);
    },
    post: (room, data, packer) => {
      const name = gen_name();
      const payload = encode(packer, data);
      send(encode_message({ $: "post", room, time: server_time(), name, payload }));
      return name;
    },
    server_time,
    ping: () => time_sync.last_ping,
    close: () => {
      if (heartbeat_id !== null) {
        clearInterval(heartbeat_id);
        heartbeat_id = null;
      }
      ws.close();
    },
    debug_dump: () => ({
      ws_url,
      ws_ready_state: ws.readyState,
      ws_ready_state_name: ws_state_name(ws.readyState),
      is_synced,
      room_watchers: Array.from(room_watchers.keys()),
      room_watcher_count: room_watchers.size,
      latest_post_index_listener_count: latest_post_index_listeners.length,
      sync_listener_count: sync_listeners.length,
      time_sync: {
        clock_offset: time_sync.clock_offset,
        lowest_ping: time_sync.lowest_ping,
        request_sent_at: time_sync.request_sent_at,
        last_ping: time_sync.last_ping,
      },
    }),
  };
}
