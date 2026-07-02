// VibiNet is a deterministic multiplayer networking library. Games are two
// pure functions (on_tick, on_post); VibiNet syncs INPUTS, not state: the
// server timestamps, orders, stores and broadcasts posts; every client folds
// the same post stream through the same pure functions and computes the same
// state. Local inputs apply instantly via prediction; late posts trigger an
// automatic rollback + replay.
//
// This file is the entire pure core: no IO, no timers, no clocks, no
// mutation of inputs. The shells own all side effects and call into here:
// - src/client.ts: WebSocket transport + the stateful VibiNet.game class.
// - src/server.ts: WebSocket server + append-only disk storage.
//
// ## Time model
//
// Every post lands on its official tick, computed from fields assigned by
// the server, so it is identical on every client:
//
//   post_time = max(client_time, server_time - tolerance)
//   post_tick = floor(post_time * tick_rate / 1000)
//
// Game state at tick T is a fold:
//
//   state(T) = posts at tick t applied after on_tick, for t = initial..T
//
// ## Finalization (the cache)
//
// The engine keeps ONE folded state instead of a snapshot ring:
//
//   [ base_state at base_tick ]  +  [ pending posts, ~1-2s ]  ->  state_at(T)
//
// The frontier (frontier_ms) is a proven bound: no unseen post can land
// before it. It advances only by `server_time - tolerance` of contiguously
// received posts and of server checkpoints. (Never by post_time: that is
// not monotone in post index, since client_time may exceed server_time.)
// Everything strictly below the frontier tick is folded into base_state and
// discarded. A post landing below base is impossible by construction:
// server_time is monotone in index, delivery is contiguous, and
// post_time >= server_time - tolerance.
//
// ## Prediction
//
// Local posts apply immediately at their predicted tick and are replaced
// when the authoritative echo (matched by name) arrives. During replay a
// local post is clamped to >= base_tick + 1, which is exactly the earliest
// tick its echo could still land on.
//
// ## Checksums
//
// While folding, the engine records a hash of the finalized state every
// `check_stride` ticks (authoritative posts only, so it is identical on
// every client). Outgoing posts carry the newest hash; incoming posts'
// hashes are compared against the local ring. A mismatch sets `desync`.
//
// ## Costs
//
// engine_step: O(pending) per event (copy-on-write maps) plus ticks folded.
// engine_state_at: O(ticks since hint-or-base + pending). Rollback caused
// by a post at tick t inherently costs (now - t) ticks; deeper history
// could never help, because the post invalidates everything after t anyway.
//
// ## Wire format
//
// Values are encoded by a schema-driven bit packer (Packed): no field names
// on the wire, no padding, LSB-first bit order, little-endian bytes.
// Rooms are 64-bit ids, written as nicks ("JohnBear#15FF", see the Nick
// section); the wire carries the raw 64 bits.
// Protocol frames are a Packed Union (Message):
// - get_time: { nonce }                        client -> server
// - info_time: { nonce, time }                 server -> client
// - post: { room, time, name, check, payload } client -> server
// - info_post: { room, index, server_time, client_time, name, check, payload }
// - watch: { room, from }                      client -> server
// - unwatch: { room }                          client -> server
// - checkpoint: { room, latest_index, server_time }  server -> client

// Types
// -----

// Schema for the bit packer. Serialization, by variant:
// - Struct: each field in Object.keys(fields) order; names not encoded.
// - Tuple:  fields in array order; value must be an Array.
// - Vector: exactly `size` items, no length prefix.
// - List:   cons list; bit 1 + item per element, bit 0 terminates.
// - Map:    cons list of key/value pairs; accepts Map or plain object.
// - Union:  tag in ceil(log2(count)) bits (ids by sorted variant name),
//           then the payload. Struct variants encode the object itself;
//           non-Struct variants use { $: "tag", value: payload }.
// - String: UTF-8 bytes as a List of UInt8.
// - Nat:    unary; N bits 1 then bit 0 (N+1 bits total).
// - UInt:   unsigned, exactly `size` bits; number if size <= 53 else bigint.
// - Int:    two's complement, exactly `size` bits.
// - Hex:    exactly `size` bytes; the value is 2*size hex chars (lowercase
//           on decode; either case accepted on encode).
export type Packed =
  | { $: "Struct"; fields: Record<string, Packed> }
  | { $: "UInt"; size: number }
  | { $: "Int"; size: number }
  | { $: "Nat" }
  | { $: "Tuple"; fields: Array<Packed> }
  | { $: "List"; type: Packed }
  | { $: "Vector"; size: number; type: Packed }
  | { $: "Map"; key: Packed; value: Packed }
  | { $: "Union"; variants: Record<string, Packed> }
  | { $: "String" }
  | { $: "Hex"; size: number };

// Bit-level cursors over a byte buffer (builder objects: locally mutated,
// never shared).
type Writer = { buf: Uint8Array; pos: number };
type Reader = { buf: Uint8Array; pos: number; len: number };

// A (tick, hash) checksum of the finalized state, for desync detection.
export type Check = { tick: number; hash: number };

// Evidence of divergence: a peer's hash disagreed with ours at a tick.
export type Desync = { tick: number; ours: number; theirs: number };

// An optional Check as encoded on the wire.
export type WireCheck = { $: "none" } | { $: "some"; tick: number; hash: number };

// A protocol frame (payload as raw bytes; the wire carries a byte List).
export type Message =
  | { $: "get_time"; nonce: number }
  | { $: "info_time"; nonce: number; time: number }
  | { $: "post"; room: string; time: number; name: string; check: WireCheck; payload: Uint8Array }
  | { $: "info_post"; room: string; index: number; server_time: number; client_time: number;
      name: string; check: WireCheck; payload: Uint8Array }
  | { $: "watch"; room: string; from: number }
  | { $: "unwatch"; room: string }
  | { $: "checkpoint"; room: string; latest_index: number; server_time: number };

type WireMessage =
  | { $: "get_time"; nonce: number }
  | { $: "info_time"; nonce: number; time: number }
  | { $: "post"; room: bigint; time: number; name: string; check: WireCheck; payload: number[] }
  | { $: "info_post"; room: bigint; index: number; server_time: number; client_time: number;
      name: string; check: WireCheck; payload: number[] }
  | { $: "watch"; room: bigint; from: number }
  | { $: "unwatch"; room: bigint }
  | { $: "checkpoint"; room: bigint; latest_index: number; server_time: number };

// An authoritative post: the server-assigned envelope around user data P.
// `data` is undefined when the payload failed to decode under the room's
// schema: such posts still order and finalize (identically on every
// client), but never reach on_post. Without this, one junk payload would
// leave a permanent index gap and stall finalization forever.
export type Post<P> = {
  index: number;
  server_time: number;
  client_time: number;
  name?: string;
  check: Check | null;
  data: P | undefined;
};

// A local prediction, awaiting its authoritative echo (matched by name).
export type Local<P> = {
  name: string;
  client_time: number;
  data: P;
};

// Everything that can happen to an engine. Transports produce `post` and
// `checkpoint`; the client shell produces `local_post` when the user posts.
export type Event<P> =
  | { $: "post"; post: Post<P> }
  | { $: "local_post"; post: Local<P> }
  | { $: "checkpoint"; latest_index: number; server_time: number };

// The game definition plus network timing parameters.
export type Config<S, P> = {
  initial: S;
  on_tick: (state: S) => S;
  on_post: (post: P, state: S) => S;
  tick_rate: number;
  tolerance: number;
  check_stride?: number; // ticks between finalized-state checksums (default 64)
};

// The whole replay state. A pure value: engine_step returns a new one.
export type Engine<S, P> = {
  base_state: S;              // fold of all ticks <= base_tick (final)
  base_tick: number | null;   // null until post 0 anchors the room
  initial_tick: number | null;
  frontier_ms: number;        // no unseen post can land before this time
  next_index: number;         // indices < next_index all received
  max_index: number;
  posts: Map<number, Post<P>>;   // received, not yet folded
  locals: Map<string, Local<P>>; // predicted, awaiting echo
  checks: Check[];            // recent finalized-state hashes (ascending tick)
  desync: Desync | null;
};

// Posts (remote and local) that land on one tick, in application order.
type Bucket<P> = { remote: Post<P>[]; local: Local<P>[] };

// Writer
// ------

const MAX_SAFE_BITS = 53;

function writer_new(bits: number): Writer {
  return { buf: new Uint8Array((bits + 7) >>> 3), pos: 0 };
}

function writer_bit(w: Writer, bit: 0 | 1): void {
  if (bit) {
    w.buf[w.pos >>> 3] |= 1 << (w.pos & 7);
  }
  w.pos++;
}

function writer_uint(w: Writer, value: number | bigint, bits: number): void {
  if (bits === 0) {
    return;
  }
  if (typeof value === "number") {
    if (bits <= 32) {
      const aligned = (w.pos & 7) === 0 && (bits & 7) === 0;
      if (aligned) {
        let v = value >>> 0;
        let byte_index = w.pos >>> 3;
        for (let i = 0; i < bits; i += 8) {
          w.buf[byte_index++] = v & 0xff;
          v >>>= 8;
        }
        w.pos += bits;
        return;
      }
      let v = value >>> 0;
      for (let i = 0; i < bits; i++) {
        writer_bit(w, (v & 1) as 0 | 1);
        v >>>= 1;
      }
      return;
    }
    writer_uint_big(w, BigInt(value), bits);
    return;
  }
  writer_uint_big(w, value, bits);
}

function writer_uint_big(w: Writer, value: bigint, bits: number): void {
  if (bits === 0) {
    return;
  }
  const aligned = (w.pos & 7) === 0 && (bits & 7) === 0;
  if (aligned) {
    let v = value;
    let byte_index = w.pos >>> 3;
    for (let i = 0; i < bits; i += 8) {
      w.buf[byte_index++] = Number(v & 0xffn);
      v >>= 8n;
    }
    w.pos += bits;
    return;
  }
  let v = value;
  for (let i = 0; i < bits; i++) {
    writer_bit(w, (v & 1n) === 0n ? 0 : 1);
    v >>= 1n;
  }
}

function writer_utf8(w: Writer, value: string): void {
  if (typeof value !== "string") {
    throw new TypeError("String value must be a string");
  }
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code < 0x80) {
      writer_bit(w, 1);
      writer_uint(w, code, 8);
      continue;
    }
    if (code < 0x800) {
      writer_bit(w, 1);
      writer_uint(w, 0xc0 | (code >>> 6), 8);
      writer_bit(w, 1);
      writer_uint(w, 0x80 | (code & 0x3f), 8);
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        const cp = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        writer_bit(w, 1);
        writer_uint(w, 0xf0 | (cp >>> 18), 8);
        writer_bit(w, 1);
        writer_uint(w, 0x80 | ((cp >>> 12) & 0x3f), 8);
        writer_bit(w, 1);
        writer_uint(w, 0x80 | ((cp >>> 6) & 0x3f), 8);
        writer_bit(w, 1);
        writer_uint(w, 0x80 | (cp & 0x3f), 8);
        continue;
      }
      code = 0xfffd;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    writer_bit(w, 1);
    writer_uint(w, 0xe0 | (code >>> 12), 8);
    writer_bit(w, 1);
    writer_uint(w, 0x80 | ((code >>> 6) & 0x3f), 8);
    writer_bit(w, 1);
    writer_uint(w, 0x80 | (code & 0x3f), 8);
  }
  writer_bit(w, 0);
}

// Reader
// ------

const TEXT_DECODER = new TextDecoder();

function reader_new(buf: Uint8Array): Reader {
  return { buf, pos: 0, len: buf.length * 8 };
}

// Reading past the end must throw: otherwise a truncated or malicious
// buffer silently decodes as zero bits (garbage values, ended lists).
function reader_need(r: Reader, bits: number): void {
  if (r.pos + bits > r.len) {
    throw new RangeError("decode read past end of buffer");
  }
}

function reader_bit(r: Reader): 0 | 1 {
  reader_need(r, 1);
  const bit = (r.buf[r.pos >>> 3] >>> (r.pos & 7)) & 1;
  r.pos++;
  return bit as 0 | 1;
}

function reader_uint(r: Reader, bits: number): number | bigint {
  if (bits === 0) {
    return 0;
  }
  reader_need(r, bits);
  if (bits <= 32) {
    const aligned = (r.pos & 7) === 0 && (bits & 7) === 0;
    if (aligned) {
      let v = 0;
      let shift = 0;
      let byte_index = r.pos >>> 3;
      for (let i = 0; i < bits; i += 8) {
        v |= r.buf[byte_index++] << shift;
        shift += 8;
      }
      r.pos += bits;
      return v >>> 0;
    }
    let v = 0;
    for (let i = 0; i < bits; i++) {
      if (reader_bit(r)) {
        v |= 1 << i;
      }
    }
    return v >>> 0;
  }
  if (bits <= MAX_SAFE_BITS) {
    let v = 0;
    let pow = 1;
    for (let i = 0; i < bits; i++) {
      if (reader_bit(r)) {
        v += pow;
      }
      pow *= 2;
    }
    return v;
  }
  return reader_uint_big(r, bits);
}

function reader_uint_big(r: Reader, bits: number): bigint {
  if (bits === 0) {
    return 0n;
  }
  const aligned = (r.pos & 7) === 0 && (bits & 7) === 0;
  if (aligned) {
    let v = 0n;
    let shift = 0n;
    let byte_index = r.pos >>> 3;
    for (let i = 0; i < bits; i += 8) {
      v |= BigInt(r.buf[byte_index++]) << shift;
      shift += 8n;
    }
    r.pos += bits;
    return v;
  }
  let v = 0n;
  let pow = 1n;
  for (let i = 0; i < bits; i++) {
    if (reader_bit(r)) {
      v += pow;
    }
    pow <<= 1n;
  }
  return v;
}

function reader_utf8(r: Reader): string {
  let bytes = new Uint8Array(16);
  let len = 0;
  while (reader_bit(r)) {
    const byte = reader_uint(r, 8) as number;
    if (len === bytes.length) {
      const next = new Uint8Array(bytes.length * 2);
      next.set(bytes);
      bytes = next;
    }
    bytes[len++] = byte;
  }
  return TEXT_DECODER.decode(bytes.subarray(0, len));
}

// Utf8
// ----

function utf8_size(value: string): number {
  if (typeof value !== "string") {
    throw new TypeError("String value must be a string");
  }
  let len = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      len += 1;
    } else if (code < 0x800) {
      len += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        len += 4;
      } else {
        len += 3; // replacement char
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      len += 3; // replacement char
    } else {
      len += 3;
    }
  }
  return len;
}

// Value
// -----
//
// Runtime views over the untyped values fed to the packer.

function value_int(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
}

function value_array(val: any, label: string): any[] {
  if (!Array.isArray(val)) {
    throw new TypeError(`${label} value must be an Array`);
  }
  return val;
}

function value_field(val: any, key: string): any {
  if (val && typeof val === "object") {
    return (val as any)[key];
  }
  throw new TypeError("Struct value must be an object");
}

function value_list_each(val: any, fn: (item: any) => void): void {
  if (!Array.isArray(val)) {
    throw new TypeError("List value must be an Array");
  }
  for (let i = 0; i < val.length; i++) {
    fn(val[i]);
  }
}

function value_map_each(val: any, fn: (key: any, value: any) => void): void {
  if (val == null) {
    return;
  }
  if (val instanceof Map) {
    for (const [k, v] of val) {
      fn(k, v);
    }
    return;
  }
  if (typeof val === "object") {
    for (const key of Object.keys(val)) {
      fn(key, val[key]);
    }
    return;
  }
  throw new TypeError("Map value must be a Map or object");
}

// Union
// -----

type UnionInfo = { keys: string[]; index_by_tag: Map<string, number>; tag_bits: number };

const UNION_CACHE = new WeakMap<object, UnionInfo>();
const STRUCT_CACHE = new WeakMap<object, string[]>();

function union_info(type: { $: "Union"; variants: Record<string, Packed> }): UnionInfo {
  const cached = UNION_CACHE.get(type as any);
  if (cached) {
    return cached;
  }
  const keys = Object.keys(type.variants).sort();
  if (keys.length === 0) {
    throw new RangeError("Union must have at least one variant");
  }
  const index_by_tag = new Map<string, number>();
  for (let i = 0; i < keys.length; i++) {
    index_by_tag.set(keys[i], i);
  }
  const tag_bits = keys.length <= 1 ? 0 : Math.ceil(Math.log2(keys.length));
  const info = { keys, index_by_tag, tag_bits };
  UNION_CACHE.set(type as any, info);
  return info;
}

function union_tag(val: any): string {
  if (!val || typeof val !== "object") {
    throw new TypeError("Union value must be an object with a $ tag");
  }
  const tag = (val as any).$;
  if (typeof tag !== "string") {
    throw new TypeError("Union value must have a string $ tag");
  }
  return tag;
}

function union_payload(val: any, variant_type: Packed): any {
  const is_boxed =
    variant_type.$ !== "Struct" &&
    val &&
    typeof val === "object" &&
    Object.prototype.hasOwnProperty.call(val, "value");
  if (is_boxed) {
    return (val as any).value;
  }
  return val;
}

function struct_keys(fields: Record<string, Packed>): string[] {
  const cached = STRUCT_CACHE.get(fields as any);
  if (cached) {
    return cached;
  }
  const keys = Object.keys(fields);
  STRUCT_CACHE.set(fields as any, keys);
  return keys;
}

// Packed
// ------

function packed_assert_size(size: number): void {
  value_int(size, "size");
  if (size < 0) {
    throw new RangeError("size must be >= 0");
  }
}

// Exact bit length of `val` encoded under `type`.
function packed_size(type: Packed, val: any): number {
  switch (type.$) {
    case "UInt":
    case "Int": {
      packed_assert_size(type.size);
      return type.size;
    }
    case "Nat": {
      if (typeof val === "bigint") {
        if (val < 0n) {
          throw new RangeError("Nat must be >= 0");
        }
        if (val > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new RangeError("Nat too large to size");
        }
        return Number(val) + 1;
      }
      value_int(val, "Nat");
      if (val < 0) {
        throw new RangeError("Nat must be >= 0");
      }
      return val + 1;
    }
    case "Tuple": {
      const fields = type.fields;
      const arr = value_array(val, "Tuple");
      let bits = 0;
      for (let i = 0; i < fields.length; i++) {
        bits += packed_size(fields[i], arr[i]);
      }
      return bits;
    }
    case "Vector": {
      packed_assert_size(type.size);
      const arr = value_array(val, "Vector");
      if (arr.length !== type.size) {
        throw new RangeError(`vector size mismatch: expected ${type.size}, got ${arr.length}`);
      }
      let bits = 0;
      for (let i = 0; i < type.size; i++) {
        bits += packed_size(type.type, arr[i]);
      }
      return bits;
    }
    case "Struct": {
      let bits = 0;
      const keys = struct_keys(type.fields);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        bits += packed_size(type.fields[key], value_field(val, key));
      }
      return bits;
    }
    case "List": {
      let bits = 1; // Nil terminator
      value_list_each(val, (item) => {
        bits += 1; // Cons tag
        bits += packed_size(type.type, item);
      });
      return bits;
    }
    case "Map": {
      let bits = 1; // Nil terminator
      value_map_each(val, (k, v) => {
        bits += 1; // Cons tag
        bits += packed_size(type.key, k);
        bits += packed_size(type.value, v);
      });
      return bits;
    }
    case "Union": {
      const info = union_info(type);
      const tag = union_tag(val);
      const variant_type = type.variants[tag];
      if (!variant_type) {
        throw new RangeError(`Unknown union variant: ${tag}`);
      }
      const payload = union_payload(val, variant_type);
      return info.tag_bits + packed_size(variant_type, payload);
    }
    case "String": {
      return 1 + utf8_size(val) * 9; // Cons bit + 8 bits per byte, plus Nil
    }
    case "Hex": {
      packed_assert_size(type.size);
      return type.size * 8;
    }
  }
}

function packed_write(w: Writer, type: Packed, val: any): void {
  switch (type.$) {
    case "UInt": {
      packed_assert_size(type.size);
      if (type.size === 0) {
        if (val === 0 || val === 0n) {
          return;
        }
        throw new RangeError("UInt out of range");
      }
      if (typeof val === "bigint") {
        if (val < 0n) {
          throw new RangeError("UInt must be >= 0");
        }
        const max = 1n << BigInt(type.size);
        if (val >= max) {
          throw new RangeError("UInt out of range");
        }
        writer_uint(w, val, type.size);
        return;
      }
      value_int(val, "UInt");
      if (val < 0) {
        throw new RangeError("UInt must be >= 0");
      }
      if (type.size > MAX_SAFE_BITS) {
        throw new RangeError("UInt too large for number; use bigint");
      }
      if (val >= 2 ** type.size) {
        throw new RangeError("UInt out of range");
      }
      writer_uint(w, val, type.size);
      return;
    }
    case "Int": {
      packed_assert_size(type.size);
      if (type.size === 0) {
        if (val === 0 || val === 0n) {
          return;
        }
        throw new RangeError("Int out of range");
      }
      if (typeof val === "bigint") {
        const size = BigInt(type.size);
        const min = -(1n << (size - 1n));
        const max = (1n << (size - 1n)) - 1n;
        if (val < min || val > max) {
          throw new RangeError("Int out of range");
        }
        let unsigned = val;
        if (val < 0n) {
          unsigned = (1n << size) + val;
        }
        writer_uint(w, unsigned, type.size);
        return;
      }
      value_int(val, "Int");
      if (type.size > MAX_SAFE_BITS) {
        throw new RangeError("Int too large for number; use bigint");
      }
      const min = -(2 ** (type.size - 1));
      const max = 2 ** (type.size - 1) - 1;
      if (val < min || val > max) {
        throw new RangeError("Int out of range");
      }
      let unsigned = val;
      if (val < 0) {
        unsigned = (2 ** type.size) + val;
      }
      writer_uint(w, unsigned, type.size);
      return;
    }
    case "Nat": {
      if (typeof val === "bigint") {
        if (val < 0n) {
          throw new RangeError("Nat must be >= 0");
        }
        let n = val;
        while (n > 0n) {
          writer_bit(w, 1);
          n -= 1n;
        }
        writer_bit(w, 0);
        return;
      }
      value_int(val, "Nat");
      if (val < 0) {
        throw new RangeError("Nat must be >= 0");
      }
      for (let i = 0; i < val; i++) {
        writer_bit(w, 1);
      }
      writer_bit(w, 0);
      return;
    }
    case "Tuple": {
      const fields = type.fields;
      const arr = value_array(val, "Tuple");
      for (let i = 0; i < fields.length; i++) {
        packed_write(w, fields[i], arr[i]);
      }
      return;
    }
    case "Vector": {
      packed_assert_size(type.size);
      const arr = value_array(val, "Vector");
      if (arr.length !== type.size) {
        throw new RangeError(`vector size mismatch: expected ${type.size}, got ${arr.length}`);
      }
      for (let i = 0; i < type.size; i++) {
        packed_write(w, type.type, arr[i]);
      }
      return;
    }
    case "Struct": {
      const keys = struct_keys(type.fields);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        packed_write(w, type.fields[key], value_field(val, key));
      }
      return;
    }
    case "List": {
      value_list_each(val, (item) => {
        writer_bit(w, 1);
        packed_write(w, type.type, item);
      });
      writer_bit(w, 0);
      return;
    }
    case "Map": {
      value_map_each(val, (k, v) => {
        writer_bit(w, 1);
        packed_write(w, type.key, k);
        packed_write(w, type.value, v);
      });
      writer_bit(w, 0);
      return;
    }
    case "Union": {
      const info = union_info(type);
      const tag = union_tag(val);
      const index = info.index_by_tag.get(tag);
      if (index === undefined) {
        throw new RangeError(`Unknown union variant: ${tag}`);
      }
      if (info.tag_bits > 0) {
        writer_uint(w, index, info.tag_bits);
      }
      const variant_type = type.variants[tag];
      packed_write(w, variant_type, union_payload(val, variant_type));
      return;
    }
    case "String": {
      writer_utf8(w, val);
      return;
    }
    case "Hex": {
      packed_assert_size(type.size);
      if (typeof val !== "string" || val.length !== type.size * 2 || !HEX_RE.test(val)) {
        throw new TypeError(`Hex value must be ${type.size * 2} hex chars`);
      }
      for (let i = 0; i < type.size; i++) {
        writer_uint(w, parseInt(val.slice(i * 2, i * 2 + 2), 16), 8);
      }
      return;
    }
  }
}

function packed_read(r: Reader, type: Packed): any {
  switch (type.$) {
    case "UInt": {
      packed_assert_size(type.size);
      return reader_uint(r, type.size);
    }
    case "Int": {
      packed_assert_size(type.size);
      if (type.size === 0) {
        return 0;
      }
      const unsigned = reader_uint(r, type.size);
      if (typeof unsigned === "bigint") {
        const sign_bit = 1n << BigInt(type.size - 1);
        if (unsigned & sign_bit) {
          return unsigned - (1n << BigInt(type.size));
        }
        return unsigned;
      }
      const sign_bit = 2 ** (type.size - 1);
      if (unsigned >= sign_bit) {
        return unsigned - 2 ** type.size;
      }
      return unsigned;
    }
    case "Nat": {
      let n = 0;
      let big: bigint | null = null;
      while (reader_bit(r)) {
        if (big !== null) {
          big += 1n;
        } else if (n === Number.MAX_SAFE_INTEGER) {
          big = BigInt(n) + 1n;
        } else {
          n++;
        }
      }
      return big ?? n;
    }
    case "Tuple": {
      const out = new Array(type.fields.length);
      for (let i = 0; i < type.fields.length; i++) {
        out[i] = packed_read(r, type.fields[i]);
      }
      return out;
    }
    case "Vector": {
      const out = new Array(type.size);
      for (let i = 0; i < type.size; i++) {
        out[i] = packed_read(r, type.type);
      }
      return out;
    }
    case "Struct": {
      const out: Record<string, any> = {};
      const keys = struct_keys(type.fields);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        out[key] = packed_read(r, type.fields[key]);
      }
      return out;
    }
    case "List": {
      const out: any[] = [];
      while (reader_bit(r)) {
        out.push(packed_read(r, type.type));
      }
      return out;
    }
    case "Map": {
      const out = new Map<any, any>();
      while (reader_bit(r)) {
        const key = packed_read(r, type.key);
        const value = packed_read(r, type.value);
        out.set(key, value);
      }
      return out;
    }
    case "Union": {
      const info = union_info(type);
      let raw_index: number | bigint = 0;
      if (info.tag_bits > 0) {
        raw_index = reader_uint(r, info.tag_bits);
      }
      const index = typeof raw_index === "bigint" ? Number(raw_index) : raw_index;
      if (index < 0 || index >= info.keys.length) {
        throw new RangeError("Union tag index out of range");
      }
      const tag = info.keys[index];
      const variant_type = type.variants[tag];
      const payload = packed_read(r, variant_type);
      if (variant_type.$ === "Struct" && payload && typeof payload === "object") {
        (payload as any).$ = tag;
        return payload;
      }
      return { $: tag, value: payload };
    }
    case "String": {
      return reader_utf8(r);
    }
    case "Hex": {
      packed_assert_size(type.size);
      let out = "";
      for (let i = 0; i < type.size; i++) {
        out += (reader_uint(r, 8) as number).toString(16).padStart(2, "0");
      }
      return out;
    }
  }
}

export function packed_encode<A>(type: Packed, val: A): Uint8Array {
  const w = writer_new(packed_size(type, val));
  packed_write(w, type, val);
  return w.buf;
}

export function packed_decode<A>(type: Packed, buf: Uint8Array): A {
  return packed_read(reader_new(buf), type) as A;
}

// Nick
// ----
//
// A nick is the text form of a 64-bit id: 8 chars in [_a-zA-Z0-9$] (6 bits
// each, '_' = 0), then '#', then 4 hex digits. Leading '_' are zero digits
// and are stripped when printing: "Bob#1234" == "_____Bob#1234". Rooms are
// addressed by nick everywhere; the wire carries the raw 64 bits. In URLs
// '#' becomes '.' (nick_link); parsing accepts both separators.

const NICK_CHARS = "_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$";
const NICK_RE = /^([_a-zA-Z0-9$]{0,8})[#.]([0-9a-fA-F]{4})$/;
const HEX_RE = /^[0-9a-fA-F]*$/;

// Parse a nick ('#' or '.' separated) into its 64-bit code.
export function nick_read(text: string): bigint | null {
  const match = NICK_RE.exec(text);
  if (!match) {
    return null;
  }
  const body = match[1].padStart(8, "_");
  let code = 0n;
  for (let i = 0; i < 8; i++) {
    code = (code << 6n) | BigInt(NICK_CHARS.indexOf(body[i]));
  }
  return (code << 16n) | BigInt(parseInt(match[2], 16));
}

// Print a 64-bit code as a canonical nick ("Bob#12AB").
export function nick_show(code: bigint): string {
  if (code < 0n || code > 0xffffffffffffffffn) {
    throw new RangeError("nick code out of u64 range");
  }
  let body = "";
  let rest = code >> 16n;
  for (let i = 0; i < 8; i++) {
    body = NICK_CHARS[Number(rest & 63n)] + body;
    rest >>= 6n;
  }
  const tail = (code & 0xffffn).toString(16).toUpperCase().padStart(4, "0");
  return body.replace(/^_+/, "") + "#" + tail;
}

// Canonicalize a nick's text form (null if invalid).
export function nick_norm(text: string): string | null {
  const code = nick_read(text);
  if (code === null) {
    return null;
  }
  return nick_show(code);
}

// URL-safe form: '#' -> '.' ("JohnBear.15FF").
export function nick_link(text: string): string {
  return text.replace("#", ".");
}

// The code as 16 hex digits (db file names; null if invalid).
export function nick_hex(text: string): string | null {
  const code = nick_read(text);
  if (code === null) {
    return null;
  }
  return code.toString(16).padStart(16, "0");
}

// Check
// -----

export function check_to_wire(check: Check | null): WireCheck {
  if (check === null) {
    return { $: "none" };
  }
  return { $: "some", tick: check.tick, hash: check.hash };
}

export function check_from_wire(wire: WireCheck): Check | null {
  if (wire.$ === "none") {
    return null;
  }
  return { tick: wire.tick, hash: wire.hash };
}

// Message
// -------

const TIME_BITS = 53; // times fit JS safe integers
const ROOM_BITS = 64; // rooms are 64-bit ids, addressed as nicks
const BYTES_PACKED: Packed = { $: "List", type: { $: "UInt", size: 8 } };

const CHECK_PACKED: Packed = {
  $: "Union",
  variants: {
    none: { $: "Struct", fields: {} },
    some: {
      $: "Struct",
      fields: {
        tick: { $: "UInt", size: 48 },
        hash: { $: "UInt", size: 32 },
      },
    },
  },
};

const MESSAGE_PACKED: Packed = {
  $: "Union",
  variants: {
    get_time: {
      $: "Struct",
      fields: {
        nonce: { $: "UInt", size: 32 },
      },
    },
    info_time: {
      $: "Struct",
      fields: {
        nonce: { $: "UInt", size: 32 },
        time: { $: "UInt", size: TIME_BITS },
      },
    },
    post: {
      $: "Struct",
      fields: {
        room: { $: "UInt", size: ROOM_BITS },
        time: { $: "UInt", size: TIME_BITS },
        name: { $: "String" },
        check: CHECK_PACKED,
        payload: BYTES_PACKED,
      },
    },
    info_post: {
      $: "Struct",
      fields: {
        room: { $: "UInt", size: ROOM_BITS },
        index: { $: "UInt", size: 32 },
        server_time: { $: "UInt", size: TIME_BITS },
        client_time: { $: "UInt", size: TIME_BITS },
        name: { $: "String" },
        check: CHECK_PACKED,
        payload: BYTES_PACKED,
      },
    },
    watch: {
      $: "Struct",
      fields: {
        room: { $: "UInt", size: ROOM_BITS },
        from: { $: "UInt", size: 32 },
      },
    },
    unwatch: {
      $: "Struct",
      fields: {
        room: { $: "UInt", size: ROOM_BITS },
      },
    },
    checkpoint: {
      $: "Struct",
      fields: {
        room: { $: "UInt", size: ROOM_BITS },
        latest_index: { $: "Int", size: 32 },
        server_time: { $: "UInt", size: TIME_BITS },
      },
    },
  },
};

function bytes_to_list(bytes: Uint8Array): number[] {
  const out = new Array<number>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i];
  }
  return out;
}

function list_to_bytes(list: number[]): Uint8Array {
  const out = new Uint8Array(list.length);
  for (let i = 0; i < list.length; i++) {
    out[i] = list[i] & 0xff;
  }
  return out;
}

// Rooms travel as their 64-bit code; text nicks exist only in code and UIs.
function room_to_wire(room: string): bigint {
  const code = nick_read(room);
  if (code === null) {
    throw new RangeError(`Invalid room nick: ${JSON.stringify(room)}`);
  }
  return code;
}

function message_to_wire(message: Message): WireMessage {
  switch (message.$) {
    case "get_time":
    case "info_time": {
      return message;
    }
    case "post":
    case "info_post": {
      return { ...message, room: room_to_wire(message.room), payload: bytes_to_list(message.payload) };
    }
    default: {
      return { ...message, room: room_to_wire(message.room) };
    }
  }
}

function message_from_wire(message: WireMessage): Message {
  switch (message.$) {
    case "get_time":
    case "info_time": {
      return message;
    }
    case "post":
    case "info_post": {
      return { ...message, room: nick_show(message.room), payload: list_to_bytes(message.payload) };
    }
    default: {
      return { ...message, room: nick_show(message.room) };
    }
  }
}

export function message_encode(message: Message): Uint8Array {
  return packed_encode(MESSAGE_PACKED, message_to_wire(message));
}

export function message_decode(buf: Uint8Array): Message {
  return message_from_wire(packed_decode<WireMessage>(MESSAGE_PACKED, buf));
}

// Time
// ----

export function time_to_tick(ms: number, tick_rate: number): number {
  return Math.floor((ms * tick_rate) / 1000);
}

// Post
// ----

// The server-authoritative time a post lands on. Identical on all clients.
export function post_time(
  post: { server_time: number; client_time: number },
  cfg: { tolerance: number }
): number {
  const floor = post.server_time - cfg.tolerance;
  if (post.client_time <= floor) {
    return floor;
  }
  return post.client_time;
}

export function post_tick(
  post: { server_time: number; client_time: number },
  cfg: { tolerance: number; tick_rate: number }
): number {
  return time_to_tick(post_time(post, cfg), cfg.tick_rate);
}

// State
// -----

// 32-bit FNV-1a over the canonical JSON of the state. Deterministic across
// clients because deterministic logic produces identical key order.
export function state_hash(state: unknown): number {
  const s = JSON.stringify(state);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Advance one tick: on_tick, then the tick's posts in index order.
function state_step<S, P>(state: S, bucket: Bucket<P> | undefined, cfg: Config<S, P>): S {
  let next = cfg.on_tick(state);
  if (bucket) {
    for (const post of bucket.remote) {
      if (post.data === undefined) {
        continue; // undecodable payload: ordered, but never applied
      }
      next = cfg.on_post(post.data, next);
    }
    for (const post of bucket.local) {
      next = cfg.on_post(post.data, next);
    }
  }
  return next;
}

// Engine
// ------

const CHECK_STRIDE = 64;
const CHECKS_KEPT = 4;
const LOCAL_TTL_MS = 5000; // drop locals whose echo never arrived

export function engine_new<S, P>(cfg: Config<S, P>): Engine<S, P> {
  return {
    base_state: cfg.initial,
    base_tick: null,
    initial_tick: null,
    frontier_ms: 0,
    next_index: 0,
    max_index: -1,
    posts: new Map(),
    locals: new Map(),
    checks: [],
    desync: null,
  };
}

// Apply one event. Pure: returns a new engine, never mutates the old one.
export function engine_step<S, P>(
  engine: Engine<S, P>,
  event: Event<P>,
  cfg: Config<S, P>
): Engine<S, P> {
  switch (event.$) {
    case "post": {
      return engine_post(engine, event.post, cfg);
    }
    case "local_post": {
      return engine_local(engine, event.post);
    }
    case "checkpoint": {
      return engine_checkpoint(engine, event, cfg);
    }
  }
}

// Compute state at a tick. `hint` is an optional previously computed state
// (must be consistent with this engine's posts; the shell tracks validity).
// Ticks below base are unanswerable and clamp to base_state.
export function engine_state_at<S, P>(
  engine: Engine<S, P>,
  tick: number,
  cfg: Config<S, P>,
  hint?: { tick: number; state: S }
): S {
  if (engine.base_tick === null || engine.initial_tick === null) {
    return cfg.initial;
  }
  if (tick < engine.initial_tick) {
    return cfg.initial;
  }
  let from = engine.base_tick;
  let state = engine.base_state;
  if (hint && hint.tick > from && hint.tick <= tick) {
    from = hint.tick;
    state = hint.state;
  }
  if (tick <= from) {
    return state; // tick at (or clamped to) the fold point
  }
  const buckets = engine_buckets(engine, from + 1, tick, true, cfg);
  for (let t = from + 1; t <= tick; t++) {
    state = state_step(state, buckets.get(t), cfg);
  }
  return state;
}

// The newest finalized-state checksum, to piggyback on outgoing posts.
export function engine_check<S, P>(engine: Engine<S, P>): Check | null {
  if (engine.checks.length === 0) {
    return null;
  }
  return engine.checks[engine.checks.length - 1];
}

function engine_post<S, P>(
  engine: Engine<S, P>,
  post: Post<P>,
  cfg: Config<S, P>
): Engine<S, P> {
  if (post.index < engine.next_index || engine.posts.has(post.index)) {
    return engine; // duplicate (already pending or already folded)
  }

  const posts = new Map(engine.posts);
  posts.set(post.index, post);

  // The authoritative echo replaces the local prediction.
  let locals = engine.locals;
  if (post.name !== undefined && locals.has(post.name)) {
    locals = new Map(locals);
    locals.delete(post.name);
  }

  // Advance the contiguous frontier over any newly gap-free indices.
  let next_index = engine.next_index;
  let frontier_ms = engine.frontier_ms;
  while (posts.has(next_index)) {
    const p = posts.get(next_index) as Post<P>;
    frontier_ms = Math.max(frontier_ms, p.server_time - cfg.tolerance);
    next_index += 1;
  }

  // Compare the sender's finalized-state hash against ours.
  let desync = engine.desync;
  if (desync === null && post.check !== null) {
    const mine = engine.checks.find((c) => c.tick === post.check!.tick);
    if (mine && mine.hash !== post.check.hash) {
      desync = { tick: mine.tick, ours: mine.hash, theirs: post.check.hash };
    }
  }

  // Post 0 anchors the room's tick origin.
  let initial_tick = engine.initial_tick;
  let base_tick = engine.base_tick;
  if (post.index === 0 && initial_tick === null) {
    initial_tick = post_tick(post, cfg);
    base_tick = initial_tick - 1;
  }

  return engine_finalize({
    ...engine,
    posts,
    locals,
    next_index,
    max_index: Math.max(engine.max_index, post.index),
    frontier_ms,
    initial_tick,
    base_tick,
    desync,
  }, cfg);
}

function engine_local<S, P>(engine: Engine<S, P>, post: Local<P>): Engine<S, P> {
  const locals = new Map(engine.locals);
  locals.set(post.name, post);
  return { ...engine, locals };
}

function engine_checkpoint<S, P>(
  engine: Engine<S, P>,
  event: { latest_index: number; server_time: number },
  cfg: Config<S, P>
): Engine<S, P> {
  // Only usable if we hold everything through latest_index: otherwise the
  // in-flight gap posts could have any (older) official time.
  if (event.latest_index >= engine.next_index) {
    return engine;
  }
  const frontier_ms = Math.max(engine.frontier_ms, event.server_time - cfg.tolerance);
  if (frontier_ms === engine.frontier_ms) {
    return engine;
  }
  return engine_finalize({ ...engine, frontier_ms }, cfg);
}

// Fold every tick strictly below the frontier tick into base_state, record
// checksums along the way, and discard the folded posts.
function engine_finalize<S, P>(engine: Engine<S, P>, cfg: Config<S, P>): Engine<S, P> {
  if (engine.base_tick === null || engine.initial_tick === null) {
    return engine_gc(engine);
  }
  const target = time_to_tick(engine.frontier_ms, cfg.tick_rate) - 1;
  if (target <= engine.base_tick) {
    return engine_gc(engine);
  }

  // Authoritative posts only: base and checksums must match on all clients.
  const buckets = engine_buckets(engine, engine.base_tick + 1, target, false, cfg);
  const stride = cfg.check_stride ?? CHECK_STRIDE;
  const check_from = target - stride * CHECKS_KEPT; // skip hashing deep history
  let state = engine.base_state;
  let checks = engine.checks;
  for (let t = engine.base_tick + 1; t <= target; t++) {
    state = state_step(state, buckets.get(t), cfg);
    if (t % stride === 0 && t > check_from) {
      checks = [...checks, { tick: t, hash: state_hash(state) }];
      if (checks.length > CHECKS_KEPT) {
        checks = checks.slice(checks.length - CHECKS_KEPT);
      }
    }
  }

  const posts = new Map<number, Post<P>>();
  for (const [index, post] of engine.posts) {
    if (Math.max(post_tick(post, cfg), engine.initial_tick) > target) {
      posts.set(index, post);
    }
  }

  return engine_gc({ ...engine, base_state: state, base_tick: target, posts, checks });
}

// Drop stale predictions whose echo never arrived (they can no longer take
// effect anywhere near their predicted time).
function engine_gc<S, P>(engine: Engine<S, P>): Engine<S, P> {
  let stale: string[] | null = null;
  for (const [name, local] of engine.locals) {
    if (local.client_time < engine.frontier_ms - LOCAL_TTL_MS) {
      (stale ??= []).push(name);
    }
  }
  if (stale === null) {
    return engine;
  }
  const locals = new Map(engine.locals);
  for (const name of stale) {
    locals.delete(name);
  }
  return { ...engine, locals };
}

// Group posts by landing tick within [from, to]; remotes clamp to the room
// anchor (so extreme backdating never loses input) and sort by index.
function engine_buckets<S, P>(
  engine: Engine<S, P>,
  from: number,
  to: number,
  include_locals: boolean,
  cfg: Config<S, P>
): Map<number, Bucket<P>> {
  const initial_tick = engine.initial_tick as number;
  const buckets = new Map<number, Bucket<P>>();
  const bucket_at = (tick: number): Bucket<P> => {
    let bucket = buckets.get(tick);
    if (!bucket) {
      bucket = { remote: [], local: [] };
      buckets.set(tick, bucket);
    }
    return bucket;
  };
  for (const post of engine.posts.values()) {
    const tick = Math.max(post_tick(post, cfg), initial_tick);
    if (tick >= from && tick <= to) {
      bucket_at(tick).remote.push(post);
    }
  }
  for (const bucket of buckets.values()) {
    bucket.remote.sort((a, b) => a.index - b.index);
  }
  if (include_locals) {
    for (const local of engine.locals.values()) {
      // Earliest tick the echo could still land on is base_tick + 1 = `from`.
      const tick = Math.max(time_to_tick(local.client_time, cfg.tick_rate), from);
      if (tick <= to) {
        bucket_at(tick).local.push(local);
      }
    }
  }
  return buckets;
}

