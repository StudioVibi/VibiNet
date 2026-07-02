// The client side of VibiNet, and the package entry point. Everything that
// runs on a player's machine and is not the pure core (vibinet.ts) lives
// here:
// - client_new: the WebSocket transport (reconnect, time sync, post queue).
// - VibiNet:    the stateful game shell around the pure engine.
// - Identity:   Ethereum-style users, signatures, reveal chains, and name
//               claims (User/Sig/Chain/Auth/Claim sections). These are pure
//               functions (they live here, not in vibinet.ts, only because
//               they depend on the noble crypto libraries).
//
// ## Identity (the server knows none of this)
//
// A user is a secp256k1 keypair; their Ethereum address is their identity
// and its last 8 bytes are their auto-nick ("JohnBear#15FF"). Auth is a
// client-side protocol folded deterministically by every client; the
// server just orders and stores opaque payloads, as always.
//
// Per-room auth rides inside post payloads (Envelope = { auth, body }):
// - Join: ONE Ethereum signature binds the sender's address to a fresh
//   reveal chain (head = H^n(seed), 16-byte links, H = sha256/16).
// - Pass: each later post reveals the next preimage; verifying costs one
//   sha256. The server-assigned total order makes "first reveal wins"
//   identical on every client, so stolen or replayed links verify false.
// - Join replays are rejected by the signed strictly-increasing time.
// The fold enriches each post with $user (address) and $nick, or null when
// anonymous/invalid; games decide what anonymous posts may do.
//
// Threat model: malicious *clients* (impersonation, replay, theft). The
// server is trusted for ordering and transport runs over TLS, exactly as
// the rest of VibiNet already assumes.
//
// Names are display-only decoration, never identity: a user claims a name
// by posting a signed Claim to their auto-nick room (the room IS the
// registry; last valid claim by signed time wins). Names are not unique;
// apps should render name + nick, and must never fold another room's name
// into game state.
//
// The shell owns three pieces of mutable state: the transport, the current
// engine value, and a small memo of computed states. All game semantics are
// pure functions in vibinet.ts.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex as bytes_to_hex, hexToBytes as hex_to_bytes } from "@noble/hashes/utils.js";
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
  nick_norm,
  nick_show,
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
  // Fold the Auth envelope. This is part of the room's protocol (like the
  // packer): every client of the room must agree on it. With auth on,
  // posts reaching on_post carry $user/$nick (see Meta) and must be
  // objects.
  auth?: boolean;
  // Identity used to sign/reveal outgoing posts (requires auth: true).
  // Absent = post anonymously while still folding everyone else's auth.
  user?: User;
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

// A user identity: a secp256k1 secret key (64 hex chars). The address is
// derived (user_addr), never stored.
export type User = { key: string };

// An Ethereum address: "0x" + 40 lowercase hex chars.
export type Address = string;

// An Ethereum signature over an EIP-191 personal message: r(32) + s(32) +
// v(1) as 130 lowercase hex chars, v in {27, 28} (MetaMask-compatible).
export type Signature = string;

// A reveal chain: list[k] = H^k(seed) with 16-byte links (H = sha256/16).
// The last entry is the head (anchored by a Join signature); links are
// revealed backwards, one per post. A pure value: chain_pass returns a new
// chain.
export type Chain = { list: string[]; next: number };

// The auth tag carried by every post in an auth room (inside Envelope).
export type Auth =
  | { $: "Anon" }
  | { $: "Join"; sign: Signature; head: string; time: number }
  | { $: "Pass"; link: string };

// What auth rooms actually post: the app's post wrapped with its auth tag.
export type Envelope<P> = { auth: Auth; body: P };

// One user's live session inside the auth fold.
export type Login = { head: string; time: number };

// The deterministic auth fold state (the `auth` half of engine state).
export type AuthState = { users: Record<Address, Login> };

// The identity fields the auth fold attaches to each post before it
// reaches on_post. Null = anonymous (or failed verification, which is
// deliberately indistinguishable: a forger could just post Anon anyway).
export type Meta = { $user: Address | null; $nick: string | null };

// A signed name claim, posted to the claimer's auto-nick room.
export type Claim = { sign: Signature; name: string; time: number };

// Bytes
// -----

// Random bytes (crypto when available).
function bytes_random(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const can_crypto = typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function";
  if (can_crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < size; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

// Name
// ----

// Random 8-char id (post names, for echo matching).
export function name_gen(): string {
  // Exactly 64 chars so `% 64` maps uniformly.
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  const bytes = bytes_random(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % 64];
  }
  return out;
}

// Nick
// ----

// Random 64-bit nick (fresh room ids: one per match).
export function nick_gen(): string {
  const bytes = bytes_random(8);
  let code = 0n;
  for (let i = 0; i < 8; i++) {
    code = (code << 8n) | BigInt(bytes[i]);
  }
  return nick_show(code);
}

// User
// ----
//
// Identity is an Ethereum keypair. The address (not the nick) is what auth
// compares; the auto-nick is just its printable 64-bit tail, and also
// names the user's claim room. Two addresses may share an auto-nick room:
// harmless, since every claim is checked against the full address.

const USER_STORAGE_KEY = "vibinet_user";

// Fresh random identity.
export function user_new(): User {
  return { key: bytes_to_hex(secp256k1.utils.randomSecretKey()) };
}

// The user's Ethereum address: keccak256(pubkey)[12..], "0x" + 40 hex.
export function user_addr(user: User): Address {
  return addr_from_pub(secp256k1.getPublicKey(hex_to_bytes(user.key), false));
}

// The user's auto-nick (the address' last 8 bytes, printed).
export function user_nick(user: User): string {
  return addr_nick(user_addr(user));
}

// Persist to localStorage (browser sessions).
export function user_save(user: User): void {
  if (typeof localStorage === "undefined") {
    throw new Error("user_save requires localStorage");
  }
  localStorage.setItem(USER_STORAGE_KEY, user.key);
}

// Load from localStorage (null if absent or unavailable).
export function user_load(): User | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  const key = localStorage.getItem(USER_STORAGE_KEY);
  if (key === null || !/^[0-9a-f]{64}$/.test(key)) {
    return null;
  }
  return { key };
}

// The stored identity, creating and saving one on first run.
export function user_init(): User {
  const found = user_load();
  if (found !== null) {
    return found;
  }
  const user = user_new();
  user_save(user);
  return user;
}

// Addr
// ----

function addr_from_pub(pub: Uint8Array): Address {
  // Uncompressed pubkey without the 0x04 prefix byte.
  return "0x" + bytes_to_hex(keccak_256(pub.subarray(1)).subarray(12));
}

// An address' auto-nick: its last 8 bytes as a nick ("JohnBear#15FF").
export function addr_nick(addr: Address): string {
  return nick_show(BigInt("0x" + addr.slice(-16)));
}

// Sig
// ---
//
// EIP-191 personal messages (what MetaMask's personal_sign produces), so a
// wallet can replace the local key later without protocol changes. The
// address is recovered from the signature: no pubkey travels, and identity
// is proven rather than claimed.

function sig_hash(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${bytes.length}`);
  const both = new Uint8Array(prefix.length + bytes.length);
  both.set(prefix, 0);
  both.set(bytes, prefix.length);
  return keccak_256(both);
}

// Sign a personal message (deterministic, RFC 6979).
export function sig_make(user: User, text: string): Signature {
  const priv = hex_to_bytes(user.key);
  const raw = secp256k1.sign(sig_hash(text), priv, { format: "recovered", prehash: false }) as Uint8Array;
  // noble layout is v || r || s; Ethereum is r || s || v with v in {27,28}.
  const out = new Uint8Array(65);
  out.set(raw.subarray(1), 0);
  out[64] = 27 + raw[0];
  return bytes_to_hex(out);
}

// Recover the signer's address (null on any invalid input).
export function sig_addr(sign: Signature, text: string): Address | null {
  try {
    const bytes = hex_to_bytes(sign);
    if (bytes.length !== 65) {
      return null;
    }
    const v = bytes[64] >= 27 ? bytes[64] - 27 : bytes[64];
    if (v !== 0 && v !== 1) {
      return null;
    }
    const raw = new Uint8Array(65);
    raw[0] = v;
    raw.set(bytes.subarray(0, 64), 1);
    const sig = secp256k1.Signature.fromBytes(raw, "recovered");
    return addr_from_pub(sig.recoverPublicKey(sig_hash(text)).toBytes(false));
  } catch {
    return null;
  }
}

// Chain
// -----
//
// The per-post authenticator. One signature (Join) anchors the head
// H^n(seed); each post then reveals the next preimage, verified with one
// sha256. A revealed link is only public *after* the server ordered it, so
// peers can never use it first; replays hash to a link already consumed.

export const CHAIN_SIZE = 16384; // links per anchor (~256KB, ~10ms to build)

// One link step: sha256 truncated to 16 bytes, as hex.
export function chain_hash(link: string): string {
  return bytes_to_hex(sha256(hex_to_bytes(link)).subarray(0, 16));
}

// Build a chain from a random 16-byte seed (32 hex chars).
export function chain_new(seed: string, size: number): Chain {
  const list = new Array<string>(size + 1);
  list[0] = seed.toLowerCase();
  for (let i = 1; i <= size; i++) {
    list[i] = chain_hash(list[i - 1]);
  }
  return { list, next: size - 1 };
}

// The head to anchor with a Join signature.
export function chain_head(chain: Chain): string {
  return chain.list[chain.list.length - 1];
}

// Reveal the next link (null when exhausted: time to re-anchor).
export function chain_pass(chain: Chain): [string, Chain] | null {
  if (chain.next < 0) {
    return null;
  }
  return [chain.list[chain.next], { list: chain.list, next: chain.next - 1 }];
}

// Does `link` extend a chain whose current head is `head`?
export function chain_verify(head: string, link: string): boolean {
  return chain_hash(link) === head;
}

// Auth
// ----
//
// The pure fold that turns Auth tags into identities, and the Config
// wrapper that hides it: engine state becomes { auth, game }, on_post
// verifies the envelope, attaches $user/$nick to the body, and hands the
// app its own state back. All of it deterministic, so it finalizes and
// checksums like any other game logic.

const AUTH_PACKED: Packed = {
  $: "Union",
  variants: {
    Anon: { $: "Struct", fields: {} },
    Join: {
      $: "Struct",
      fields: {
        sign: { $: "Hex", size: 65 },
        head: { $: "Hex", size: 16 },
        time: { $: "UInt", size: 53 },
      },
    },
    Pass: {
      $: "Struct",
      fields: {
        link: { $: "Hex", size: 16 },
      },
    },
  },
};

// The wire schema of an auth room: the app's packer inside the envelope.
// Overhead: Anon 2 bits, Pass 16 bytes, Join 86 bytes.
export function auth_packed(body: Packed): Packed {
  return { $: "Struct", fields: { auth: AUTH_PACKED, body } };
}

// The canonical text a Join signs. Signing the room nick stops cross-room
// replay; the strictly-increasing time stops same-room replay.
export function auth_text(room: string, head: string, time: number): string {
  return `vibinet/join v1\nroom: ${room}\nhead: ${head}\ntime: ${time}`;
}

export function auth_new(): AuthState {
  return { users: {} };
}

// Fold one auth tag: the new state, plus who (if anyone) it authenticates.
export function auth_step(room: string, state: AuthState, auth: Auth): [AuthState, Address | null] {
  switch (auth.$) {
    case "Anon": {
      return [state, null];
    }
    case "Join": {
      const addr = sig_addr(auth.sign, auth_text(room, auth.head, auth.time));
      if (addr === null) {
        return [state, null];
      }
      const prev = state.users[addr];
      if (prev !== undefined && auth.time <= prev.time) {
        return [state, null]; // replayed or stale anchor
      }
      const users = { ...state.users, [addr]: { head: auth.head, time: auth.time } };
      return [{ users }, addr];
    }
    case "Pass": {
      // First reveal wins: consuming the link moves the head, so any later
      // reuse hashes to a stale head and lands here as null.
      for (const addr of Object.keys(state.users)) {
        if (chain_verify(state.users[addr].head, auth.link)) {
          const login = { head: auth.link, time: state.users[addr].time };
          const users = { ...state.users, [addr]: login };
          return [{ users }, addr];
        }
      }
      return [state, null];
    }
  }
}

// Engine state of an auth room: the auth fold beside the app's state.
export type Authed<S> = { auth: AuthState; game: S };

// Wrap a game Config into its auth-folding equivalent.
export function auth_config<S, P>(room: string, cfg: Config<S, P>): Config<Authed<S>, Envelope<P>> {
  return {
    initial: { auth: auth_new(), game: cfg.initial },
    on_tick: (state) => ({ auth: state.auth, game: cfg.on_tick(state.game) }),
    on_post: (env, state) => {
      const [auth, addr] = auth_step(room, state.auth, env.auth);
      const meta: Meta = { $user: addr, $nick: addr === null ? null : addr_nick(addr) };
      const body = { ...(env.body as object), ...meta } as P;
      return { auth, game: cfg.on_post(body, state.game) };
    },
    tick_rate: cfg.tick_rate,
    tolerance: cfg.tolerance,
    check_stride: cfg.check_stride,
  };
}

// Claim
// -----
//
// Display names. A claim is valid only if its signature recovers the exact
// address whose auto-nick room it sits in; among valid claims the highest
// signed time wins (renames allowed, replays can never win). Names are for
// rendering only: game state must never depend on another room.

const CLAIM_PACKED: Packed = {
  $: "Struct",
  fields: {
    sign: { $: "Hex", size: 65 },
    name: { $: "String" },
    time: { $: "UInt", size: 53 },
  },
};

const NAME_RE = /^[A-Za-z0-9_]{1,32}$/;

export function name_valid(name: string): boolean {
  return NAME_RE.test(name);
}

// The canonical text a claim signs.
export function claim_text(nick: string, name: string, time: number): string {
  return `vibinet/name v1\nnick: ${nick}\nname: ${name}\ntime: ${time}`;
}

// Sign a claim for the user's own auto-nick room.
export function claim_make(user: User, name: string, time: number): Claim {
  if (!name_valid(name)) {
    throw new Error(`Invalid name: ${JSON.stringify(name)}`);
  }
  return { sign: sig_make(user, claim_text(user_nick(user), name, time)), name, time };
}

// Who signed this claim, given the room it was posted in (null = invalid).
export function claim_addr(nick: string, claim: Claim): Address | null {
  if (typeof claim.name !== "string" || !name_valid(claim.name)) {
    return null;
  }
  if (typeof claim.time !== "number" || !Number.isInteger(claim.time)) {
    return null;
  }
  return sig_addr(claim.sign, claim_text(nick, claim.name, claim.time));
}

// Fold claims (in post order) down to `addr`'s current name.
export function claim_fold(addr: Address, claims: Claim[]): string | null {
  const nick = addr_nick(addr);
  let best: Claim | null = null;
  for (const claim of claims) {
    if ((best === null || claim.time > best.time) && claim_addr(nick, claim) === addr) {
      best = claim;
    }
  }
  return best === null ? null : best.name;
}

// Publish a name: sign and post a claim to the user's auto-nick room.
export function name_set(user: User, name: string, server?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const client = client_new<Claim>(server);
      client.on_sync(() => {
        try {
          const claim = claim_make(user, name, client.server_time());
          client.post(user_nick(user), claim, CLAIM_PACKED, null);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          client.close();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

// Read an address' current display name (null = none). One-shot: reads the
// auto-nick room up to the server's checkpoint, folds, disconnects. Cache
// the result for rendering; names are decoration and may change.
export function name_get(addr: Address, server?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const room = addr_nick(addr);
    const client = client_new<Claim>(server);
    const claims: Claim[] = [];
    let target = Infinity;
    let max_index = -1;
    let done = false;

    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      client.close();
      resolve(claim_fold(addr, claims));
    };
    // Never hang the caller on a dead connection; fold what we have.
    const timer = setTimeout(finish, 10000);

    client.on_sync(() => {
      client.watch(room, CLAIM_PACKED, (event) => {
        if (event.$ === "post") {
          max_index = Math.max(max_index, event.post.index);
          if (event.post.data !== undefined) {
            claims.push(event.post.data);
          }
        } else if (event.$ === "checkpoint") {
          target = Math.min(target, event.latest_index);
        }
        if (max_index >= target || target < 0) {
          finish();
        }
      });
    });
  });
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
            // A payload that fails to decode still becomes a post (data:
            // undefined): it must occupy its index, or the gap would stall
            // finalization forever. The engine orders it but never applies it.
            let data: any = undefined;
            try {
              data = packed_decode(watcher.packer, msg.payload);
            } catch {
              console.warn(`[VIBI] Undecodable payload in ${msg.room} at index ${msg.index}; skipped.`);
            }
            watcher.handler({
              $: "post",
              post: {
                index: msg.index,
                server_time: msg.server_time,
                client_time: msg.client_time,
                name: msg.name,
                check: check_from_wire(msg.check),
                data,
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
  cfg:        Config<any, any>;
  engine:     Engine<any, any>;
  client_api: ClientApi<any>;
  user:       User | null;

  private memos: Array<{ tick: number; state: any }>;
  private unwrap: (state: any) => S;
  private auth_on: boolean;
  private chain: Chain | null;
  private join_ms: number; // last signed Join time (0 = not joined yet)
  private on_desync_cb: ((info: Desync) => void) | null;
  private desync_fired: boolean;

  constructor(options: Options<S, P>) {
    const room = nick_norm(options.room);
    if (room === null) {
      throw new Error(`Invalid room nick: ${JSON.stringify(options.room)}`);
    }
    this.room       = room;
    this.tick_rate  = options.tick_rate;
    this.tolerance  = options.tolerance;
    this.smooth     = options.smooth ?? ((remote: S, _local: S) => remote);
    const base_cfg: Config<S, P> = {
      initial:      options.initial,
      on_tick:      options.on_tick,
      on_post:      options.on_post,
      tick_rate:    options.tick_rate,
      tolerance:    options.tolerance,
      check_stride: options.check_stride,
    };
    this.auth_on = options.auth ?? false;
    this.user    = options.user ?? null;
    this.chain   = null;
    this.join_ms = 0;
    if (this.user !== null && !this.auth_on) {
      throw new Error("`user` requires `auth: true`");
    }
    if (this.auth_on) {
      this.cfg    = auth_config<S, P>(room, base_cfg);
      this.packer = auth_packed(options.packer);
      this.unwrap = (state) => (state as Authed<S>).game;
      if (this.user !== null) {
        // Pre-warm the first chain so the first post signs instantly.
        this.chain = chain_new(bytes_to_hex(bytes_random(16)), CHAIN_SIZE);
      }
    } else {
      this.cfg    = base_cfg;
      this.packer = options.packer;
      this.unwrap = (state) => state as S;
    }
    this.engine        = engine_new(this.cfg);
    this.client_api    = options.client ?? client_new<any>(options.server);
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
  // In auth rooms the input is wrapped in its envelope: a signed Join on
  // the first post (and on chain exhaustion), a chain reveal afterwards.
  post(data: P): void {
    const wrapped: any = this.auth_on ? { auth: this.auth_next(), body: data } : data;
    const check = engine_check(this.engine);
    const name  = this.client_api.post(this.room, wrapped, this.packer, check);
    const t     = this.server_time();
    this.engine = engine_step(this.engine, {
      $: "local_post",
      post: { name, client_time: t, data: wrapped },
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
    let hint: { tick: number; state: any } | undefined;
    for (const memo of this.memos) {
      if (memo.tick <= tick && (!hint || memo.tick > hint.tick)) {
        hint = memo;
      }
    }
    const state = engine_state_at(this.engine, tick, this.cfg, hint);
    this.remember(tick, state);
    return this.unwrap(state);
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
      auth: this.auth_on ? {
        user: this.user === null ? null : user_addr(this.user),
        joined: this.join_ms > 0,
        links_left: this.chain === null ? 0 : this.chain.next + 1,
      } : null,
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

  static nick_gen(): string {
    return nick_gen();
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

  // Next outgoing auth tag (mutates the shell's chain/join session).
  private auth_next(): Auth {
    if (this.user === null) {
      return { $: "Anon" };
    }
    if (this.chain !== null && this.join_ms > 0) {
      const passed = chain_pass(this.chain);
      if (passed !== null) {
        this.chain = passed[1];
        return { $: "Pass", link: passed[0] };
      }
      this.chain = null; // exhausted: re-anchor below
    }
    if (this.chain === null) {
      this.chain = chain_new(bytes_to_hex(bytes_random(16)), CHAIN_SIZE);
    }
    // Strictly increasing, so a replayed Join can never beat this one.
    const time = Math.max(this.server_time(), this.join_ms + 1);
    this.join_ms = time;
    const head = chain_head(this.chain);
    return { $: "Join", sign: sig_make(this.user, auth_text(this.room, head, time)), head, time };
  }

  private remember(tick: number, state: any): void {
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
