// packer.ts
//
// A minimal, schema-driven bit-level encoder/decoder for compact network payloads.
//
// What it is:
// - Given a runtime schema (Type) and a value, it emits the most compact bitstream
//   that respects that schema (no field names on the wire, no padding unless required
//   by the type itself).
// - Decoding requires the same Type; there is no self-describing metadata.
//
// How it works (high level):
// - First pass computes the exact bit length of the encoded value.
// - Second pass writes bits into a Uint8Array using little-endian bit order:
//   the first bit written is bit 0 (LSB) of byte 0.
// - Decoding reads bits in the same order.
//
// Usage:
//   const T: Type = { $: "Struct", fields: new Map([
//     ["x", { $: "UInt", size: 20 }],
//     ["y", { $: "UInt", size: 20 }],
//     ["dir", { $: "UInt", size: 2  }],
//   ])};
//   const buf = encode(T, { x: 5, y: 9, dir: 3 }); // 42 bits => 6 bytes
//   const val = decode<typeof obj>(T, buf);
//
// Serialization details (by Type):
// - {$:"Struct", fields: Map<string, Type>}
//   - Encodes each field value in iteration order of the Map.
//   - Field names are not encoded.
//   - Value can be an object or Map; for objects, fields are read by name.
//
// - {$:"Tuple", fields: Type[]}
//   - Encodes fields in array order.
//   - Value must be an Array with matching length.
//
// - {$:"Vector", size: number, type: Type}
//   - Encodes exactly `size` items in sequence (no length).
//   - Value must be an Array of length `size`.
//
// - {$:"List", type: Type}
//   - Encodes a cons list: for each item, write tag bit 1 then the item.
//   - Terminates with tag bit 0 (Nil).
//   - Value must be an Array.
//
// - {$:"Map", key: Type, value: Type}
//   - Encodes as a cons list of key/value pairs:
//     tag 1, key, value ... then tag 0.
//   - Accepts Map (iteration order preserved) or plain object (Object.keys order).
//
// - {$:"Union", variants: Map<string, Type>}
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
//   a buffer produced for the same Type.
export type Type =
  | { $: "Struct"; fields: Map<string, Type> }
  | { $: "UInt"; size: number }
  | { $: "Int"; size: number }
  | { $: "Nat" }
  | { $: "Tuple"; fields: Array<Type> }
  | { $: "List"; type: Type }
  | { $: "Vector"; size: number; type: Type }
  | { $: "Map"; key: Type; value: Type }
  | { $: "Union"; variants: Map<string, Type> }
  | { $: "String" };

const MAX_SAFE_BITS = 53;

const textDecoder = new TextDecoder();
const unionCache = new WeakMap<object, { keys: string[]; indexByTag: Map<string, number>; tagBits: number }>();

class BitWriter {
  private buf: Uint8Array;
  private bitPos: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.bitPos = 0;
  }

  writeBit(bit: 0 | 1): void {
    const byteIndex = this.bitPos >>> 3;
    const bitIndex = this.bitPos & 7;
    if (bit) {
      this.buf[byteIndex] |= 1 << bitIndex;
    }
    this.bitPos++;
  }

  writeBitsUnsigned(value: number | bigint, bits: number): void {
    if (bits === 0) return;

    if (typeof value === "number") {
      if (bits <= 32) {
        const aligned = (this.bitPos & 7) === 0 && (bits & 7) === 0;
        if (aligned) {
          let v = value >>> 0;
          let byteIndex = this.bitPos >>> 3;
          for (let i = 0; i < bits; i += 8) {
            this.buf[byteIndex++] = v & 0xff;
            v >>>= 8;
          }
          this.bitPos += bits;
          return;
        }

        let v = value >>> 0;
        for (let i = 0; i < bits; i++) {
          this.writeBit((v & 1) as 0 | 1);
          v >>>= 1;
        }
        return;
      }

      // Fallback to BigInt for wider numbers
      this.writeBitsBigint(BigInt(value), bits);
      return;
    }

    this.writeBitsBigint(value, bits);
  }

  private writeBitsBigint(value: bigint, bits: number): void {
    if (bits === 0) return;

    const aligned = (this.bitPos & 7) === 0 && (bits & 7) === 0;
    if (aligned) {
      let v = value;
      let byteIndex = this.bitPos >>> 3;
      for (let i = 0; i < bits; i += 8) {
        this.buf[byteIndex++] = Number(v & 0xffn);
        v >>= 8n;
      }
      this.bitPos += bits;
      return;
    }

    let v = value;
    for (let i = 0; i < bits; i++) {
      this.writeBit((v & 1n) === 0n ? 0 : 1);
      v >>= 1n;
    }
  }
}

class BitReader {
  private buf: Uint8Array;
  private bitPos: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.bitPos = 0;
  }

  readBit(): 0 | 1 {
    const byteIndex = this.bitPos >>> 3;
    const bitIndex = this.bitPos & 7;
    const bit = (this.buf[byteIndex] >>> bitIndex) & 1;
    this.bitPos++;
    return bit as 0 | 1;
  }

  readBitsUnsigned(bits: number): number | bigint {
    if (bits === 0) return 0;

    if (bits <= 32) {
      const aligned = (this.bitPos & 7) === 0 && (bits & 7) === 0;
      if (aligned) {
        let v = 0;
        let shift = 0;
        let byteIndex = this.bitPos >>> 3;
        for (let i = 0; i < bits; i += 8) {
          v |= this.buf[byteIndex++] << shift;
          shift += 8;
        }
        this.bitPos += bits;
        return v >>> 0;
      }

      let v = 0;
      for (let i = 0; i < bits; i++) {
        if (this.readBit()) {
          v |= 1 << i;
        }
      }
      return v >>> 0;
    }

    if (bits <= MAX_SAFE_BITS) {
      let v = 0;
      let pow = 1;
      for (let i = 0; i < bits; i++) {
        if (this.readBit()) {
          v += pow;
        }
        pow *= 2;
      }
      return v;
    }

    return this.readBitsBigint(bits);
  }

  private readBitsBigint(bits: number): bigint {
    if (bits === 0) return 0n;

    const aligned = (this.bitPos & 7) === 0 && (bits & 7) === 0;
    if (aligned) {
      let v = 0n;
      let shift = 0n;
      let byteIndex = this.bitPos >>> 3;
      for (let i = 0; i < bits; i += 8) {
        v |= BigInt(this.buf[byteIndex++]) << shift;
        shift += 8n;
      }
      this.bitPos += bits;
      return v;
    }

    let v = 0n;
    let pow = 1n;
    for (let i = 0; i < bits; i++) {
      if (this.readBit()) {
        v += pow;
      }
      pow <<= 1n;
    }
    return v;
  }
}

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
}

function assertSize(size: number): void {
  assertInteger(size, "size");
  if (size < 0) throw new RangeError("size must be >= 0");
}

function assertVectorSize(expected: number, actual: number): void {
  if (actual !== expected) {
    throw new RangeError(`vector size mismatch: expected ${expected}, got ${actual}`);
  }
}

function sizeBits(type: Type, val: any): number {
  switch (type.$) {
    case "UInt":
    case "Int":
      assertSize(type.size);
      return type.size;
    case "Nat": {
      if (typeof val === "bigint") {
        if (val < 0n) throw new RangeError("Nat must be >= 0");
        if (val > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new RangeError("Nat too large to size");
        }
        return Number(val) + 1;
      }
      assertInteger(val, "Nat");
      if (val < 0) throw new RangeError("Nat must be >= 0");
      return val + 1;
    }
    case "Tuple": {
      const fields = type.fields;
      const arr = asArray(val, "Tuple");
      let bits = 0;
      for (let i = 0; i < fields.length; i++) {
        bits += sizeBits(fields[i], arr[i]);
      }
      return bits;
    }
    case "Vector": {
      assertSize(type.size);
      const arr = asArray(val, "Vector");
      assertVectorSize(type.size, arr.length);
      let bits = 0;
      for (let i = 0; i < type.size; i++) {
        bits += sizeBits(type.type, arr[i]);
      }
      return bits;
    }
    case "Struct": {
      const fields = type.fields;
      let bits = 0;
      for (const [key, fieldType] of fields) {
        const v = getStructField(val, key);
        bits += sizeBits(fieldType, v);
      }
      return bits;
    }
    case "List": {
      let bits = 1; // Nil terminator
      forEachList(val, (item) => {
        bits += 1; // Cons tag
        bits += sizeBits(type.type, item);
      });
      return bits;
    }
    case "Map": {
      let bits = 1; // Nil terminator
      forEachMap(val, (k, v) => {
        bits += 1; // Cons tag
        bits += sizeBits(type.key, k);
        bits += sizeBits(type.value, v);
      });
      return bits;
    }
    case "Union": {
      const info = unionInfo(type);
      const tag = getUnionTag(val);
      const variantType = type.variants.get(tag);
      if (!variantType) {
        throw new RangeError(`Unknown union variant: ${tag}`);
      }
      const payload = getUnionPayload(val, variantType);
      return info.tagBits + sizeBits(variantType, payload);
    }
    case "String": {
      const byteLen = utf8ByteLength(val);
      return 1 + byteLen * 9; // Cons bit + 8 bits per byte, plus Nil
    }
  }
}

function encodeInto(writer: BitWriter, type: Type, val: any): void {
  switch (type.$) {
    case "UInt": {
      assertSize(type.size);
      if (type.size === 0) {
        if (val === 0 || val === 0n) return;
        throw new RangeError("UInt out of range");
      }
      if (typeof val === "bigint") {
        if (val < 0n) throw new RangeError("UInt must be >= 0");
        const max = 1n << BigInt(type.size);
        if (val >= max) throw new RangeError("UInt out of range");
        writer.writeBitsUnsigned(val, type.size);
        return;
      }
      assertInteger(val, "UInt");
      if (val < 0) throw new RangeError("UInt must be >= 0");
      if (type.size > MAX_SAFE_BITS) {
        throw new RangeError("UInt too large for number; use bigint");
      }
      const max = 2 ** type.size;
      if (val >= max) throw new RangeError("UInt out of range");
      writer.writeBitsUnsigned(val, type.size);
      return;
    }
    case "Int": {
      assertSize(type.size);
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
        writer.writeBitsUnsigned(unsigned, type.size);
        return;
      }
      assertInteger(val, "Int");
      if (type.size > MAX_SAFE_BITS) {
        throw new RangeError("Int too large for number; use bigint");
      }
      const min = -(2 ** (type.size - 1));
      const max = 2 ** (type.size - 1) - 1;
      if (val < min || val > max) throw new RangeError("Int out of range");
      let unsigned = val;
      if (val < 0) unsigned = (2 ** type.size) + val;
      writer.writeBitsUnsigned(unsigned, type.size);
      return;
    }
    case "Nat": {
      if (typeof val === "bigint") {
        if (val < 0n) throw new RangeError("Nat must be >= 0");
        let n = val;
        while (n > 0n) {
          writer.writeBit(1);
          n -= 1n;
        }
        writer.writeBit(0);
        return;
      }
      assertInteger(val, "Nat");
      if (val < 0) throw new RangeError("Nat must be >= 0");
      for (let i = 0; i < val; i++) {
        writer.writeBit(1);
      }
      writer.writeBit(0);
      return;
    }
    case "Tuple": {
      const fields = type.fields;
      const arr = asArray(val, "Tuple");
      for (let i = 0; i < fields.length; i++) {
        encodeInto(writer, fields[i], arr[i]);
      }
      return;
    }
    case "Vector": {
      assertSize(type.size);
      const arr = asArray(val, "Vector");
      assertVectorSize(type.size, arr.length);
      for (let i = 0; i < type.size; i++) {
        encodeInto(writer, type.type, arr[i]);
      }
      return;
    }
    case "Struct": {
      for (const [key, fieldType] of type.fields) {
        encodeInto(writer, fieldType, getStructField(val, key));
      }
      return;
    }
    case "List": {
      forEachList(val, (item) => {
        writer.writeBit(1);
        encodeInto(writer, type.type, item);
      });
      writer.writeBit(0);
      return;
    }
    case "Map": {
      forEachMap(val, (k, v) => {
        writer.writeBit(1);
        encodeInto(writer, type.key, k);
        encodeInto(writer, type.value, v);
      });
      writer.writeBit(0);
      return;
    }
    case "Union": {
      const info = unionInfo(type);
      const tag = getUnionTag(val);
      const index = info.indexByTag.get(tag);
      if (index === undefined) {
        throw new RangeError(`Unknown union variant: ${tag}`);
      }
      if (info.tagBits > 0) {
        writer.writeBitsUnsigned(index, info.tagBits);
      }
      const variantType = type.variants.get(tag) as Type;
      const payload = getUnionPayload(val, variantType);
      encodeInto(writer, variantType, payload);
      return;
    }
    case "String": {
      writeUtf8List(writer, val);
      return;
    }
  }
}

function decodeFrom(reader: BitReader, type: Type): any {
  switch (type.$) {
    case "UInt": {
      assertSize(type.size);
      return reader.readBitsUnsigned(type.size);
    }
    case "Int": {
      assertSize(type.size);
      if (type.size === 0) return 0;
      const unsigned = reader.readBitsUnsigned(type.size);
      if (typeof unsigned === "bigint") {
        const signBit = 1n << BigInt(type.size - 1);
        if (unsigned & signBit) {
          return unsigned - (1n << BigInt(type.size));
        }
        return unsigned;
      }
      const signBit = 2 ** (type.size - 1);
      if (unsigned >= signBit) {
        return unsigned - 2 ** type.size;
      }
      return unsigned;
    }
    case "Nat": {
      let n = 0;
      let big: bigint | null = null;
      while (reader.readBit()) {
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
        out[i] = decodeFrom(reader, type.fields[i]);
      }
      return out;
    }
    case "Vector": {
      const out = new Array(type.size);
      for (let i = 0; i < type.size; i++) {
        out[i] = decodeFrom(reader, type.type);
      }
      return out;
    }
    case "Struct": {
      const out: Record<string, any> = {};
      for (const [key, fieldType] of type.fields) {
        out[key] = decodeFrom(reader, fieldType);
      }
      return out;
    }
    case "List": {
      const out: any[] = [];
      while (reader.readBit()) {
        out.push(decodeFrom(reader, type.type));
      }
      return out;
    }
    case "Map": {
      const out = new Map<any, any>();
      while (reader.readBit()) {
        const key = decodeFrom(reader, type.key);
        const value = decodeFrom(reader, type.value);
        out.set(key, value);
      }
      return out;
    }
    case "Union": {
      const info = unionInfo(type);
      let rawIndex: number | bigint = 0;
      if (info.tagBits > 0) {
        rawIndex = reader.readBitsUnsigned(info.tagBits);
      }
      let index: number;
      if (typeof rawIndex === "bigint") {
        if (rawIndex > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new RangeError("Union tag index too large");
        }
        index = Number(rawIndex);
      } else {
        index = rawIndex;
      }
      if (index < 0 || index >= info.keys.length) {
        throw new RangeError("Union tag index out of range");
      }
      const tag = info.keys[index];
      const variantType = type.variants.get(tag) as Type;
      const payload = decodeFrom(reader, variantType);
      if (variantType.$ === "Struct") {
        if (payload && typeof payload === "object") {
          (payload as any).$ = tag;
          return payload;
        }
      }
      return { $: tag, value: payload };
    }
    case "String": {
      return readUtf8List(reader);
    }
  }
}

function asArray(val: any, label: string): any[] {
  if (!Array.isArray(val)) {
    throw new TypeError(`${label} value must be an Array`);
  }
  return val;
}

function getStructField(val: any, key: string): any {
  if (val instanceof Map) {
    return val.get(key);
  }
  if (val && typeof val === "object") {
    return (val as any)[key];
  }
  throw new TypeError("Struct value must be an object or Map");
}

function unionInfo(type: { $: "Union"; variants: Map<string, Type> }): {
  keys: string[];
  indexByTag: Map<string, number>;
  tagBits: number;
} {
  const cached = unionCache.get(type as any);
  if (cached) return cached;

  const keys = Array.from(type.variants.keys()).sort();
  if (keys.length === 0) {
    throw new RangeError("Union must have at least one variant");
  }
  const indexByTag = new Map<string, number>();
  for (let i = 0; i < keys.length; i++) {
    indexByTag.set(keys[i], i);
  }
  const tagBits = keys.length <= 1 ? 0 : Math.ceil(Math.log2(keys.length));
  const info = { keys, indexByTag, tagBits };
  unionCache.set(type as any, info);
  return info;
}

function getUnionTag(val: any): string {
  if (!val || typeof val !== "object") {
    throw new TypeError("Union value must be an object with a $ tag");
  }
  const tag = (val as any).$;
  if (typeof tag !== "string") {
    throw new TypeError("Union value must have a string $ tag");
  }
  return tag;
}

function getUnionPayload(val: any, variantType: Type): any {
  if (
    variantType.$ !== "Struct" &&
    val &&
    typeof val === "object" &&
    Object.prototype.hasOwnProperty.call(val, "value")
  ) {
    return (val as any).value;
  }
  return val;
}

function forEachList(val: any, fn: (item: any) => void): void {
  if (!Array.isArray(val)) {
    throw new TypeError("List value must be an Array");
  }
  for (let i = 0; i < val.length; i++) {
    fn(val[i]);
  }
}

function forEachMap(val: any, fn: (key: any, value: any) => void): void {
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

function utf8ByteLength(value: string): number {
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

function writeUtf8List(writer: BitWriter, value: string): void {
  if (typeof value !== "string") {
    throw new TypeError("String value must be a string");
  }
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code < 0x80) {
      writer.writeBit(1);
      writer.writeBitsUnsigned(code, 8);
      continue;
    }
    if (code < 0x800) {
      writer.writeBit(1);
      writer.writeBitsUnsigned(0xc0 | (code >>> 6), 8);
      writer.writeBit(1);
      writer.writeBitsUnsigned(0x80 | (code & 0x3f), 8);
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        const cp = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        writer.writeBit(1);
        writer.writeBitsUnsigned(0xf0 | (cp >>> 18), 8);
        writer.writeBit(1);
        writer.writeBitsUnsigned(0x80 | ((cp >>> 12) & 0x3f), 8);
        writer.writeBit(1);
        writer.writeBitsUnsigned(0x80 | ((cp >>> 6) & 0x3f), 8);
        writer.writeBit(1);
        writer.writeBitsUnsigned(0x80 | (cp & 0x3f), 8);
        continue;
      }
      code = 0xfffd;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    writer.writeBit(1);
    writer.writeBitsUnsigned(0xe0 | (code >>> 12), 8);
    writer.writeBit(1);
    writer.writeBitsUnsigned(0x80 | ((code >>> 6) & 0x3f), 8);
    writer.writeBit(1);
    writer.writeBitsUnsigned(0x80 | (code & 0x3f), 8);
  }
  writer.writeBit(0);
}

function readUtf8List(reader: BitReader): string {
  let bytes = new Uint8Array(16);
  let len = 0;
  while (reader.readBit()) {
    const byte = reader.readBitsUnsigned(8) as number;
    if (len === bytes.length) {
      const next = new Uint8Array(bytes.length * 2);
      next.set(bytes);
      bytes = next;
    }
    bytes[len++] = byte;
  }
  return textDecoder.decode(bytes.subarray(0, len));
}

export function encode<A>(type: Type, val: A): Uint8Array {
  const bits = sizeBits(type, val);
  const buf = new Uint8Array((bits + 7) >>> 3);
  const writer = new BitWriter(buf);
  encodeInto(writer, type, val);
  return buf;
}

export function decode<A>(type: Type, buf: Uint8Array): A {
  const reader = new BitReader(buf);
  return decodeFrom(reader, type) as A;
}
