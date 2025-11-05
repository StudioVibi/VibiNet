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

// Auto-detect server hostname (works for both localhost and remote)
const ws = new WebSocket(`ws://${window.location.hostname}:8080`);

// Room watchers with callbacks
type MessageHandler = (message: any) => void;
const room_watchers = new Map<string, MessageHandler>();

// Connection + time sync state
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

// Ensure socket is open
function ensure_open(): void {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket not open");
  }
}

// Unified send wrapper (exported for external users)
export function send(obj: any): void {
  ensure_open();
  ws.send(JSON.stringify(obj));
}

// Register optional per-room handler without duplication
function register_handler(room: string, handler?: MessageHandler): void {
  if (!handler) return;
  if (room_watchers.has(room)) {
    throw new Error(`Handler already registered for room: ${room}`);
  }
  room_watchers.set(room, handler);
}

// Setup time sync
ws.addEventListener("open", () => {
  console.log("[WS] Connected");
  // Immediate time sync request to reduce wait
  time_sync.request_sent_at = now();
  ws.send(JSON.stringify({ $: "get_time" }));
  // Periodic sync every 2s
  setInterval(() => {
    time_sync.request_sent_at = now();
    ws.send(JSON.stringify({ $: "get_time" }));
  }, 2000);
});

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);

  switch (message.$) {
    case "info_time": {
      const time = now();
      const ping = time - time_sync.request_sent_at;
      time_sync.last_ping = ping;
      if (ping < time_sync.lowest_ping) {
        const local_avg_time   = Math.floor((time_sync.request_sent_at + time) / 2);
        time_sync.clock_offset = message.time - local_avg_time;
        time_sync.lowest_ping  = ping;
      }
      if (!is_synced) {
        is_synced = true;
        for (const cb of sync_listeners) cb();
        sync_listeners.length = 0;
      }
      break;
    }
    case "info_post": {
      // Notify room-specific handler
      const handler = room_watchers.get(message.room);
      if (handler) {
        handler(message);
      }
      break;
    }
  }
});

// API Functions

// Generate 8-char name (48-bit) using base64url-like alphabet [_a-zA-Z0-9-]
function gen_name(): string {
  const alphabet = "_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let idx = 0; idx < 8; idx++) bytes[idx] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let idx = 0; idx < 8; idx++) {
    out += alphabet[bytes[idx] % 64];
  }
  return out;
}

export function post(room: string, data: any): string {
  const name = gen_name();
  send({$: "post", room, time: server_time(), name, data});
  return name;
}

export function load(room: string, from: number = 0, handler?: MessageHandler): void {
  register_handler(room, handler);
  send({$: "load", room, from});
}

export function watch(room: string, handler?: MessageHandler): void {
  register_handler(room, handler);
  send({$: "watch", room});
}

export function unwatch(room: string): void {
  room_watchers.delete(room);
  send({$: "unwatch", room});
}

export function close(): void {
  ws.close();
}

// Register a callback that fires once, on first successful time sync
export function on_sync(callback: () => void): void {
  if (is_synced) {
    callback();
    return;
  }
  sync_listeners.push(callback);
}

// Current measured RTT (ms); Infinity if not yet measured
export function ping(): number {
  return time_sync.last_ping;
}
