import { test, expect } from "bun:test";
import { client_new } from "../../vibinet-ts/src/client.ts";
import { message_decode, message_encode, Message } from "../../vibinet-ts/src/vibinet.ts";

type Listener = (event: any) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "arraybuffer";
  sent: Uint8Array[] = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  send(data: Uint8Array): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("socket not open");
    }
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code: 1000 });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  fail(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  message(msg: Message): void {
    const bytes = message_encode(msg);
    const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.emit("message", { data: view });
  }

  private emit(type: string, event: any): void {
    const set = this.listeners.get(type);
    if (!set) {
      return;
    }
    for (const listener of Array.from(set.values())) {
      listener(event);
    }
  }
}

function decode_sent(messages: Uint8Array[]): Message[] {
  return messages.map((bytes) => message_decode(bytes));
}

function last_time_nonce(socket: FakeWebSocket): number {
  const msgs = decode_sent(socket.sent);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg.$ === "get_time") {
      return msg.nonce;
    }
  }
  throw new Error("no get_time sent");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wait_until(
  predicate: () => boolean,
  timeout_ms = 3000,
  step_ms = 20
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() - start > timeout_ms) {
      throw new Error("wait_until timeout");
    }
    await sleep(step_ms);
  }
}

function with_fake_websocket(run: () => Promise<void> | void): Promise<void> {
  const previous = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = FakeWebSocket as any;
  FakeWebSocket.reset();

  const done = async () => {
    try {
      await run();
    } finally {
      (globalThis as any).WebSocket = previous;
      FakeWebSocket.reset();
    }
  };

  return done();
}

test("client ignores stale info_time replies (nonce mismatch)", async () => {
  await with_fake_websocket(async () => {
    const client = client_new<number>("wss://example.test");

    const socket1 = FakeWebSocket.instances[0];
    expect(socket1).toBeDefined();
    socket1.open();

    const nonce = last_time_nonce(socket1);

    // A stale reply (wrong nonce) must not establish sync or poison the clock.
    socket1.message({ $: "info_time", nonce: nonce + 1, time: 123456789 });
    expect(() => client.server_time()).toThrow();

    // The matching reply syncs normally.
    socket1.message({ $: "info_time", nonce, time: 123456789 });
    expect(() => client.server_time()).not.toThrow();

    client.close();
  });
});

test("client re-watches from its cursor after reconnect", async () => {
  await with_fake_websocket(async () => {
    const packer = { $: "UInt", size: 8 } as any;
    const client = client_new<number>("wss://example.test");

    const socket1 = FakeWebSocket.instances[0];
    expect(socket1).toBeDefined();
    socket1.open();

    client.watch("RoomD#0001", packer, () => {});
    const first_sent = decode_sent(socket1.sent);
    const first_watch = first_sent.find((msg) => msg.$ === "watch");
    expect(first_watch && first_watch.$ === "watch" && first_watch.from).toBe(0);

    // Deliver posts 0..2; client cursor should advance to 3.
    for (let i = 0; i < 3; i++) {
      socket1.message({
        $: "info_post",
        room: "RoomD#0001",
        index: i,
        server_time: 1000 + i,
        client_time: 1000 + i,
        name: `p${i}`,
        check: { $: "none" },
        payload: new Uint8Array([i]),
      });
    }

    socket1.fail(1006);
    await wait_until(() => FakeWebSocket.instances.length >= 2);
    const socket2 = FakeWebSocket.instances[1];
    socket2.open();

    const second_sent = decode_sent(socket2.sent);
    const second_watch = second_sent.find((msg) => msg.$ === "watch");
    expect(second_watch && second_watch.$ === "watch" && second_watch.from).toBe(3);

    client.close();
  });
});

test("client reconnects and re-watches tracked rooms", async () => {
  await with_fake_websocket(async () => {
    const packer = { $: "UInt", size: 8 } as any;
    const client = client_new<number>("wss://example.test");

    const socket1 = FakeWebSocket.instances[0];
    expect(socket1).toBeDefined();
    socket1.open();

    client.watch("RoomA#0001", packer);
    const first_sent = decode_sent(socket1.sent);
    expect(first_sent.some((msg) => msg.$ === "watch" && msg.room === "RoomA#0001")).toBeTrue();

    socket1.fail(1006);
    await wait_until(() => FakeWebSocket.instances.length >= 2);

    const socket2 = FakeWebSocket.instances[1];
    expect(socket2).toBeDefined();
    socket2.open();

    const second_sent = decode_sent(socket2.sent);
    expect(second_sent.some((msg) => msg.$ === "watch" && msg.room === "RoomA#0001")).toBeTrue();

    client.close();
  });
});

test("client queues posts during disconnect and flushes after reconnect", async () => {
  await with_fake_websocket(async () => {
    const packer = { $: "UInt", size: 8 } as any;
    const client = client_new<number>("wss://example.test");

    const socket1 = FakeWebSocket.instances[0];
    expect(socket1).toBeDefined();
    socket1.open();

    socket1.message({ $: "info_time", nonce: last_time_nonce(socket1), time: Date.now() });
    client.post("RoomB#0001", 7, packer);

    const first_sent = decode_sent(socket1.sent);
    expect(first_sent.some((msg) => msg.$ === "post" && msg.room === "RoomB#0001")).toBeTrue();

    socket1.fail(1006);
    expect(() => client.post("RoomB#0001", 9, packer)).not.toThrow();

    await wait_until(() => FakeWebSocket.instances.length >= 2);
    const socket2 = FakeWebSocket.instances[1];
    expect(socket2).toBeDefined();
    socket2.open();

    const second_sent = decode_sent(socket2.sent);
    const second_posts = second_sent.filter((msg) => msg.$ === "post" && msg.room === "RoomB#0001");
    expect(second_posts.length).toBe(1);

    client.close();
  });
});

test("client flushes all queued posts after reconnect", async () => {
  await with_fake_websocket(async () => {
    const packer = { $: "UInt", size: 8 } as any;
    const client = client_new<number>("wss://example.test");

    const socket1 = FakeWebSocket.instances[0];
    expect(socket1).toBeDefined();
    socket1.open();
    socket1.message({ $: "info_time", nonce: last_time_nonce(socket1), time: Date.now() });
    socket1.fail(1006);

    expect(() => client.post("RoomC#0001", 1, packer)).not.toThrow();
    expect(() => client.post("RoomC#0001", 2, packer)).not.toThrow();
    expect(() => client.post("RoomC#0001", 3, packer)).not.toThrow();

    await wait_until(() => FakeWebSocket.instances.length >= 2);
    const socket2 = FakeWebSocket.instances[1];
    expect(socket2).toBeDefined();
    socket2.open();

    const sent = decode_sent(socket2.sent);
    const posts = sent.filter((msg) => msg.$ === "post" && msg.room === "RoomC#0001");
    expect(posts.length).toBe(3);

    client.close();
  });
});
