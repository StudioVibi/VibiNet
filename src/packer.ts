// packer.ts
//
// A minimal, schema-driven bit-level encoder/decoder for compact network payloads.
//
// What it is:
// - Given a runtime schema (Packed) and a value, it emits the most compact bitstream
//   that respects that schema (no field names on the wire, no padding unless required
//   by the type itself).
// - Decoding requires the same Packed; there is no self-describing metadata.
//
// How it works (high level):
// - First pass computes the exact bit length of the encoded value.
// - Second pass writes bits into a Uint8Array using little-endian bit order:
//   the first bit written is bit 0 (LSB) of byte 0.
// - Decoding reads bits in the same order.
//
// Usage:
//   const T: Packed = { $: "Struct", fields: {
//     x: { $: "UInt", size: 20 },
//     y: { $: "UInt", size: 20 },
//     dir: { $: "UInt", size: 2 },
//   }};
//   const buf = encode(T, { x: 5, y: 9, dir: 3 }); // 42 bits => 6 bytes
//   const val = decode<typeof obj>(T, buf);
//
// Serialization details (by Packed):
// - {$:"Struct", fields: Record<string, Packed>}
//   - Encodes each field value in Object.keys(fields) order.
//   - Field names are not encoded.
//   - Value must be an object; fields are read by name.
//
// - {$:"Tuple", fields: Packed[]}
//   - Encodes fields in array order.
//   - Value must be an Array with matching length.
//
// - {$:"Vector", size: number, type: Packed}
//   - Encodes exactly `size` items in sequence (no length).
//   - Value must be an Array of length `size`.
//
// - {$:"List", type: Packed}
//   - Encodes a cons list: for each item, write tag bit 1 then the item.
//   - Terminates with tag bit 0 (Nil).
//   - Value must be an Array.
//
// - {$:"Map", key: Packed, value: Packed}
//   - Encodes as a cons list of key/value pairs:
//     tag 1, key, value ... then tag 0.
//   - Accepts Map (iteration order preserved) or plain object (Object.keys order).
//
// - {$:"Union", variants: Record<string, Packed>}
//   - Encodes a tag using ceil(log2(variant_count)) bits, followed by the variant payload.
//   - Tag IDs are assigned by sorting the variant keys alphabetically.
//   - Value must be an object with a string `$` property naming the variant.
//   - For Struct variants, the object itself is encoded as the payload.
//   - For non-Struct variants, pass `{ $: \"tag\", value: payload }` and the
//     `value` field is encoded as the payload.
//
// - {$:"String"}
//   - UTF-8 bytes encoded as a List of UInt8:
//     for each byte: tag 1 + 8 bits; terminates with tag 0.
//   - No length prefix; decoding reads until Nil.
//
// - {$:"Nat"}
//   - Peano/unary encoding: N times bit 1, followed by bit 0.
//   - Efficient only for small N; size is N+1 bits.
//
// - {$:"UInt", size: N}
//   - Unsigned integer in exactly N bits, LSB-first.
//   - Accepts number for N <= 53, otherwise bigint is required.
//
// - {$:"Int", size: N}
//   - Two's complement signed integer in exactly N bits, LSB-first.
//   - Accepts number for N <= 53, otherwise bigint is required.
//
// Notes / constraints:
// - Bit order is LSB-first within each field; byte order is little-endian.
// - No alignment or padding is inserted between fields.
// - `encode` does not validate buffer length on decode; caller must supply
//   a buffer produced for the same Packed.
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
  | { $: "String" };

const MAX_SAFE_BITS = 53;

const text_decoder = new TextDecoder();
const union_cache = new WeakMap<object, { keys: string[]; index_by_tag: Map<string, number>; tag_bits: number }>();
const struct_cache = new WeakMap<object, string[]>();

class BitWriter {
  private buf: Uint8Array;
  private bit_pos: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.bit_pos = 0;
  }

  write_bit(bit: 0 | 1): void {
    const byte_index = this.bit_pos >>> 3;
    const bit_index = this.bit_pos & 7;
    if (bit) {
      this.buf[byte_index] |= 1 << bit_index;
    }
    this.bit_pos++;
  }

  write_bitsUnsigned(value: number | bigint, bits: number): void {
    if (bits === 0) return;

    if (typeof value === "number") {
      if (bits <= 32) {
        const aligned = (this.bit_pos & 7) === 0 && (bits & 7) === 0;
        if (aligned) {
          let v = value >>> 0;
          let byte_index = this.bit_pos >>> 3;
          for (let i = 0; i < bits; i += 8) {
            this.buf[byte_index++] = v & 0xff;
            v >>>= 8;
          }
          this.bit_pos += bits;
          return;
        }

        let v = value >>> 0;
        for (let i = 0; i < bits; i++) {
          this.write_bit((v & 1) as 0 | 1);
          v >>>= 1;
        }
        return;
      }

      // Fallback to BigInt for wider numbers
      this.write_bitsBigint(BigInt(value), bits);
      return;
    }

    this.write_bitsBigint(value, bits);
  }

  private write_bitsBigint(value: bigint, bits: number): void {
    if (bits === 0) return;

    const aligned = (this.bit_pos & 7) === 0 && (bits & 7) === 0;
    if (aligned) {
      let v = value;
      let byte_index = this.bit_pos >>> 3;
      for (let i = 0; i < bits; i += 8) {
        this.buf[byte_index++] = Number(v & 0xffn);
        v >>= 8n;
      }
      this.bit_pos += bits;
      return;
    }

    let v = value;
    for (let i = 0; i < bits; i++) {
      this.write_bit((v & 1n) === 0n ? 0 : 1);
      v >>= 1n;
    }
  }
}

class BitReader {
  private buf: Uint8Array;
  private bit_pos: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.bit_pos = 0;
  }

  read_bit(): 0 | 1 {
    const byte_index = this.bit_pos >>> 3;
    const bit_index = this.bit_pos & 7;
    const bit = (this.buf[byte_index] >>> bit_index) & 1;
    this.bit_pos++;
    return bit as 0 | 1;
  }

  read_bitsUnsigned(bits: number): number | bigint {
    if (bits === 0) return 0;

    if (bits <= 32) {
      const aligned = (this.bit_pos & 7) === 0 && (bits & 7) === 0;
      if (aligned) {
        let v = 0;
        let shift = 0;
        let byte_index = this.bit_pos >>> 3;
        for (let i = 0; i < bits; i += 8) {
          v |= this.buf[byte_index++] << shift;
          shift += 8;
        }
        this.bit_pos += bits;
        return v >>> 0;
      }

      let v = 0;
      for (let i = 0; i < bits; i++) {
        if (this.read_bit()) {
          v |= 1 << i;
        }
      }
      return v >>> 0;
    }

    if (bits <= MAX_SAFE_BITS) {
      let v = 0;
      let pow = 1;
      for (let i = 0; i < bits; i++) {
        if (this.read_bit()) {
          v += pow;
        }
        pow *= 2;
      }
      return v;
    }

    return this.read_bitsBigint(bits);
  }

  private read_bitsBigint(bits: number): bigint {
    if (bits === 0) return 0n;

    const aligned = (this.bit_pos & 7) === 0 && (bits & 7) === 0;
    if (aligned) {
      let v = 0n;
      let shift = 0n;
      let byte_index = this.bit_pos >>> 3;
      for (let i = 0; i < bits; i += 8) {
        v |= BigInt(this.buf[byte_index++]) << shift;
        shift += 8n;
      }
      this.bit_pos += bits;
      return v;
    }

    let v = 0n;
    let pow = 1n;
    for (let i = 0; i < bits; i++) {
      if (this.read_bit()) {
        v += pow;
      }
      pow <<= 1n;
    }
    return v;
  }
}

function assert_integer(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
}

function assert_size(size: number): void {
  assert_integer(size, "size");
  if (size < 0) throw new RangeError("size must be >= 0");
}

function assert_vector_size(expected: number, actual: number): void {
  if (actual !== expected) {
    throw new RangeError(`vector size mismatch: expected ${expected}, got ${actual}`);
  }
}

function size_bits(type: Packed, val: any): number {
  switch (type.$) {
    case "UInt":
    case "Int":
      assert_size(type.size);
      return type.size;
    case "Nat": {
      if (typeof val === "bigint") {
        if (val < 0n) throw new RangeError("Nat must be >= 0");
        if (val > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new RangeError("Nat too large to size");
        }
        return Number(val) + 1;
      }
      assert_integer(val, "Nat");
      if (val < 0) throw new RangeError("Nat must be >= 0");
      return val + 1;
    }
    case "Tuple": {
      const fields = type.fields;
      const arr = as_array(val, "Tuple");
      let bits = 0;
      for (let i = 0; i < fields.length; i++) {
        bits += size_bits(fields[i], arr[i]);
      }
      return bits;
    }
    case "Vector": {
      assert_size(type.size);
      const arr = as_array(val, "Vector");
      assert_vector_size(type.size, arr.length);
      let bits = 0;
      for (let i = 0; i < type.size; i++) {
        bits += size_bits(type.type, arr[i]);
      }
      return bits;
    }
    case "Struct": {
      let bits = 0;
      const keys = struct_keys(type.fields);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const v = get_struct_field(val, key);
        bits += size_bits(type.fields[key], v);
      }
      return bits;
    }
    case "List": {
      let bits = 1; // Nil terminator
      for_each_list(val, (item) => {
        bits += 1; // Cons tag
        bits += size_bits(type.type, item);
      });
      return bits;
    }
    case "Map": {
      let bits = 1; // Nil terminator
      for_each_map(val, (k, v) => {
        bits += 1; // Cons tag
        bits += size_bits(type.key, k);
        bits += size_bits(type.value, v);
      });
      return bits;
    }
    case "Union": {
      const info = union_info(type);
      const tag = get_union_tag(val);
      const variant_type = type.variants[tag];
      if (!variant_type) {
        throw new RangeError(`Unknown union variant: ${tag}`);
      }
      const payload = get_union_payload(val, variant_type);
      return info.tag_bits + size_bits(variant_type, payload);
    }
    case "String": {
      const byte_len = utf8_byte_length(val);
      return 1 + byte_len * 9; // Cons bit + 8 bits per byte, plus Nil
    }
  }
}

function encode_into(writer: BitWriter, type: Packed, val: any): void {
  switch (type.$) {
    case "UInt": {
      assert_size(type.size);
      if (type.size === 0) {
        if (val === 0 || val === 0n) return;
        throw new RangeError("UInt out of range");
      }
      if (typeof val === "bigint") {
        if (val < 0n) throw new RangeError("UInt must be >= 0");
        const max = 1n << BigInt(type.size);
        if (val >= max) throw new RangeError("UInt out of range");
        writer.write_bitsUnsigned(val, type.size);
        return;
      }
      assert_integer(val, "UInt");
      if (val < 0) throw new RangeError("UInt must be >= 0");
      if (type.size > MAX_SAFE_BITS) {
        throw new RangeError("UInt too large for number; use bigint");
      }
      const max = 2 ** type.size;
      if (val >= max) throw new RangeError("UInt out of range");
      writer.write_bitsUnsigned(val, type.size);
      return;
    }
    case "Int": {
      assert_size(type.size);
      if (type.size === 0) {
        if (val === 0 || val === 0n) return;
        throw new RangeError("Int out of range");
      }
      if (typeof val === "bigint") {
        const size = BigInt(type.size);
        const min = -(1n << (size - 1n));
        const max = (1n << (size - 1n)) - 1n;
        if (val < min || val > max) throw new RangeError("Int out of range");
        let unsigned = val;
        if (val < 0n) unsigned = (1n << size) + val;
        writer.write_bitsUnsigned(unsigned, type.size);
        return;
      }
      assert_integer(val, "Int");
      if (type.size > MAX_SAFE_BITS) {
        throw new RangeError("Int too large for number; use bigint");
      }
      const min = -(2 ** (type.size - 1));
      const max = 2 ** (type.size - 1) - 1;
      if (val < min || val > max) throw new RangeError("Int out of range");
      let unsigned = val;
      if (val < 0) unsigned = (2 ** type.size) + val;
      writer.write_bitsUnsigned(unsigned, type.size);
      return;
    }
    case "Nat": {
      if (typeof val === "bigint") {
        if (val < 0n) throw new RangeError("Nat must be >= 0");
        let n = val;
        while (n > 0n) {
          writer.write_bit(1);
          n -= 1n;
        }
        writer.write_bit(0);
        return;
      }
      assert_integer(val, "Nat");
      if (val < 0) throw new RangeError("Nat must be >= 0");
      for (let i = 0; i < val; i++) {
        writer.write_bit(1);
      }
      writer.write_bit(0);
      return;
    }
    case "Tuple": {
      const fields = type.fields;
      const arr = as_array(val, "Tuple");
      for (let i = 0; i < fields.length; i++) {
        encode_into(writer, fields[i], arr[i]);
      }
      return;
    }
    case "Vector": {
      assert_size(type.size);
      const arr = as_array(val, "Vector");
      assert_vector_size(type.size, arr.length);
      for (let i = 0; i < type.size; i++) {
        encode_into(writer, type.type, arr[i]);
      }
      return;
    }
    case "Struct": {
      const keys = struct_keys(type.fields);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        encode_into(writer, type.fields[key], get_struct_field(val, key));
      }
      return;
    }
    case "List": {
      for_each_list(val, (item) => {
        writer.write_bit(1);
        encode_into(writer, type.type, item);
      });
      writer.write_bit(0);
      return;
    }
    case "Map": {
      for_each_map(val, (k, v) => {
        writer.write_bit(1);
        encode_into(writer, type.key, k);
        encode_into(writer, type.value, v);
      });
      writer.write_bit(0);
      return;
    }
    case "Union": {
      const info = union_info(type);
      const tag = get_union_tag(val);
      const index = info.index_by_tag.get(tag);
      if (index === undefined) {
        throw new RangeError(`Unknown union variant: ${tag}`);
      }
      if (info.tag_bits > 0) {
        writer.write_bitsUnsigned(index, info.tag_bits);
      }
      const variant_type = type.variants[tag];
      const payload = get_union_payload(val, variant_type);
      encode_into(writer, variant_type, payload);
      return;
    }
    case "String": {
      write_utf8_list(writer, val);
      return;
    }
  }
}

function decode_from(reader: BitReader, type: Packed): any {
  switch (type.$) {
    case "UInt": {
      assert_size(type.size);
      return reader.read_bitsUnsigned(type.size);
    }
    case "Int": {
      assert_size(type.size);
      if (type.size === 0) return 0;
      const unsigned = reader.read_bitsUnsigned(type.size);
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
      while (reader.read_bit()) {
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
        out[i] = decode_from(reader, type.fields[i]);
      }
      return out;
    }
    case "Vector": {
      const out = new Array(type.size);
      for (let i = 0; i < type.size; i++) {
        out[i] = decode_from(reader, type.type);
      }
      return out;
    }
    case "Struct": {
      const out: Record<string, any> = {};
      const keys = struct_keys(type.fields);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        out[key] = decode_from(reader, type.fields[key]);
      }
      return out;
    }
    case "List": {
      const out: any[] = [];
      while (reader.read_bit()) {
        out.push(decode_from(reader, type.type));
      }
      return out;
    }
    case "Map": {
      const out = new Map<any, any>();
      while (reader.read_bit()) {
        const key = decode_from(reader, type.key);
        const value = decode_from(reader, type.value);
        out.set(key, value);
      }
      return out;
    }
    case "Union": {
      const info = union_info(type);
      let raw_index: number | bigint = 0;
      if (info.tag_bits > 0) {
        raw_index = reader.read_bitsUnsigned(info.tag_bits);
      }
      let index: number;
      if (typeof raw_index === "bigint") {
        if (raw_index > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new RangeError("Union tag index too large");
        }
        index = Number(raw_index);
      } else {
        index = raw_index;
      }
      if (index < 0 || index >= info.keys.length) {
        throw new RangeError("Union tag index out of range");
      }
      const tag = info.keys[index];
      const variant_type = type.variants[tag];
      const payload = decode_from(reader, variant_type);
      if (variant_type.$ === "Struct") {
        if (payload && typeof payload === "object") {
          (payload as any).$ = tag;
          return payload;
        }
      }
      return { $: tag, value: payload };
    }
    case "String": {
      return read_utf8_list(reader);
    }
  }
}

function as_array(val: any, label: string): any[] {
  if (!Array.isArray(val)) {
    throw new TypeError(`${label} value must be an Array`);
  }
  return val;
}

function get_struct_field(val: any, key: string): any {
  if (val && typeof val === "object") {
    return (val as any)[key];
  }
  throw new TypeError("Struct value must be an object");
}

function union_info(type: { $: "Union"; variants: Record<string, Packed> }): {
  keys: string[];
  index_by_tag: Map<string, number>;
  tag_bits: number;
} {
  const cached = union_cache.get(type as any);
  if (cached) return cached;

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
  union_cache.set(type as any, info);
  return info;
}

function struct_keys(fields: Record<string, Packed>): string[] {
  const cached = struct_cache.get(fields as any);
  if (cached) return cached;
  const keys = Object.keys(fields);
  struct_cache.set(fields as any, keys);
  return keys;
}

function get_union_tag(val: any): string {
  if (!val || typeof val !== "object") {
    throw new TypeError("Union value must be an object with a $ tag");
  }
  const tag = (val as any).$;
  if (typeof tag !== "string") {
    throw new TypeError("Union value must have a string $ tag");
  }
  return tag;
}

function get_union_payload(val: any, variant_type: Packed): any {
  if (
    variant_type.$ !== "Struct" &&
    val &&
    typeof val === "object" &&
    Object.prototype.hasOwnProperty.call(val, "value")
  ) {
    return (val as any).value;
  }
  return val;
}

function for_each_list(val: any, fn: (item: any) => void): void {
  if (!Array.isArray(val)) {
    throw new TypeError("List value must be an Array");
  }
  for (let i = 0; i < val.length; i++) {
    fn(val[i]);
  }
}

function for_each_map(val: any, fn: (key: any, value: any) => void): void {
  if (val == null) return;
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

function utf8_byte_length(value: string): number {
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

function write_utf8_list(writer: BitWriter, value: string): void {
  if (typeof value !== "string") {
    throw new TypeError("String value must be a string");
  }
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code < 0x80) {
      writer.write_bit(1);
      writer.write_bitsUnsigned(code, 8);
      continue;
    }
    if (code < 0x800) {
      writer.write_bit(1);
      writer.write_bitsUnsigned(0xc0 | (code >>> 6), 8);
      writer.write_bit(1);
      writer.write_bitsUnsigned(0x80 | (code & 0x3f), 8);
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        const cp = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        writer.write_bit(1);
        writer.write_bitsUnsigned(0xf0 | (cp >>> 18), 8);
        writer.write_bit(1);
        writer.write_bitsUnsigned(0x80 | ((cp >>> 12) & 0x3f), 8);
        writer.write_bit(1);
        writer.write_bitsUnsigned(0x80 | ((cp >>> 6) & 0x3f), 8);
        writer.write_bit(1);
        writer.write_bitsUnsigned(0x80 | (cp & 0x3f), 8);
        continue;
      }
      code = 0xfffd;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    writer.write_bit(1);
    writer.write_bitsUnsigned(0xe0 | (code >>> 12), 8);
    writer.write_bit(1);
    writer.write_bitsUnsigned(0x80 | ((code >>> 6) & 0x3f), 8);
    writer.write_bit(1);
    writer.write_bitsUnsigned(0x80 | (code & 0x3f), 8);
  }
  writer.write_bit(0);
}

function read_utf8_list(reader: BitReader): string {
  let bytes = new Uint8Array(16);
  let len = 0;
  while (reader.read_bit()) {
    const byte = reader.read_bitsUnsigned(8) as number;
    if (len === bytes.length) {
      const next = new Uint8Array(bytes.length * 2);
      next.set(bytes);
      bytes = next;
    }
    bytes[len++] = byte;
  }
  return text_decoder.decode(bytes.subarray(0, len));
}

export function encode<A>(type: Packed, val: A): Uint8Array {
  const bits = size_bits(type, val);
  const buf = new Uint8Array((bits + 7) >>> 3);
  const writer = new BitWriter(buf);
  encode_into(writer, type, val);
  return buf;
}

export function decode<A>(type: Packed, buf: Uint8Array): A {
  const reader = new BitReader(buf);
  return decode_from(reader, type) as A;
}
