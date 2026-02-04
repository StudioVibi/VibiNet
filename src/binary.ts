// binary.ts
//
// Small binary read/write helpers for network and storage payloads.
// All integers are little-endian. Strings are UTF-8 with a u32 length prefix.

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder();
const MAX_SAFE_U64 = BigInt(Number.MAX_SAFE_INTEGER);

export function utf8_bytes(value: string): Uint8Array {
  return text_encoder.encode(value);
}

export class BinaryWriter {
  private view: DataView;
  private buf: Uint8Array;
  private offset = 0;

  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  write_u8(value: number): void {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  write_u32(value: number): void {
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  write_u64(value: number): void {
    this.view.setBigUint64(this.offset, BigInt(value), true);
    this.offset += 8;
  }

  write_bytes(bytes: Uint8Array): void {
    this.write_u32(bytes.length);
    this.buf.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  write_string_bytes(bytes: Uint8Array): void {
    this.write_bytes(bytes);
  }

  finish(): Uint8Array {
    return this.buf;
  }
}

export class BinaryReader {
  private view: DataView;
  private buf: Uint8Array;
  private offset = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  read_u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  read_u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  read_u64(): number {
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    if (value > MAX_SAFE_U64) {
      throw new RangeError("u64 value exceeds Number.MAX_SAFE_INTEGER");
    }
    return Number(value);
  }

  read_bytes(): Uint8Array {
    const len = this.read_u32();
    const out = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  read_string(): string {
    const bytes = this.read_bytes();
    return text_decoder.decode(bytes);
  }
}
