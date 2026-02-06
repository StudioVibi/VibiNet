import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { readFile as read_file } from "fs/promises";
import { decode_message, encode_message } from "./protocol.ts";
import { append_post, ensure_db_dir, for_each_post } from "./storage.ts";

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

const watchers = new Map<string, Set<WebSocket>>();

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
          const info = encode_message({
            $: "info_post",
            room,
            index,
            server_time,
            client_time,
            name,
            payload,
          });
          for (const watcher of room_watchers) {
            watcher.send(info);
          }
        }
        break;
      }
      case "load": {
        const room = message.room;
        const from = Math.max(0, message.from || 0);
        for_each_post(room, from, (index, post) => {
          const msg = encode_message({
            $: "info_post",
            room,
            index,
            server_time: post.server_time,
            client_time: post.client_time,
            name: post.name,
            payload: post.payload,
          });
          ws.send(msg);
        });
        break;
      }
      case "watch": {
        const room = message.room;
        if (!watchers.has(room)) {
          watchers.set(room, new Set());
        }
        watchers.get(room)!.add(ws);
        console.log("Watching:", { room });
        break;
      }
      case "unwatch": {
        const room = message.room;
        const set = watchers.get(room);
        if (set) {
          set.delete(ws);
          if (set.size === 0) {
            watchers.delete(room);
          }
        }
        console.log("Unwatching:", { room });
        break;
      }
    }
  });

  ws.on("close", () => {
    for (const [room, set] of watchers.entries()) {
      set.delete(ws);
      if (set.size === 0) watchers.delete(room);
    }
  });
});

server.listen(port, host, () => {
  console.log(`Server running at http://${host}:${port} (HTTP + WebSocket)`);
});
