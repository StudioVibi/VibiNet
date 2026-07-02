// storage.ts
//
// Append-only binary storage for room posts.
//
// Files per room:
// - db/<room>.dat : append-only records
// - db/<room>.idx : u64 offsets into .dat (one per post)
//
// Record format (inside .dat):
//   [u32 record_len][u64 server_time][u64 client_time][string name][bytes payload]
//
// Strings are UTF-8 with a u32 length prefix. Payload bytes are length-prefixed.

import {
  appendFileSync as append_file_sync,
  existsSync as exists_sync,
  mkdirSync as mkdir_sync,
  openSync as open_sync,
  closeSync as close_sync,
  readFileSync as read_file_sync,
  readSync as read_sync,
  statSync as stat_sync,
  writeFileSync as write_file_sync,
} from "fs";
import { BinaryReader, BinaryWriter, utf8_bytes } from "./binary.ts";

export type StoredPost = {
  server_time: number;
  client_time: number;
  name: string;
  payload: Uint8Array;
};

type RoomStore = {
  dat_path: string;
  idx_path: string;
  offsets: number[];
  dat_size: number;
  read_fd: number | null;
};

const stores = new Map<string, RoomStore>();
const db_dir = "./db";

// Room names become filenames; restrict them to a safe charset so they can
// never traverse paths (e.g. "../../etc/passwd").
const ROOM_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function is_valid_room(room: string): boolean {
  return ROOM_NAME_RE.test(room);
}

export function ensure_db_dir(): void {
  if (!exists_sync(db_dir)) {
    mkdir_sync(db_dir);
  }
}

function encode_record(post: StoredPost): Uint8Array {
  const name_bytes = utf8_bytes(post.name);
  const payload = post.payload;
  const size = 8 + 8 + 4 + name_bytes.length + 4 + payload.length;
  const writer = new BinaryWriter(size);
  writer.write_u64(post.server_time);
  writer.write_u64(post.client_time);
  writer.write_string_bytes(name_bytes);
  writer.write_bytes(payload);
  return writer.finish();
}

function decode_record(buf: Uint8Array): StoredPost {
  const reader = new BinaryReader(buf);
  const server_time = reader.read_u64();
  const client_time = reader.read_u64();
  const name = reader.read_string();
  const payload = reader.read_bytes();
  return { server_time, client_time, name, payload };
}

function load_offsets(idx_path: string): number[] {
  if (!exists_sync(idx_path)) {
    return [];
  }
  const data = read_file_sync(idx_path);
  if (data.length % 8 !== 0) {
    throw new Error(`Corrupt index file: ${idx_path}`);
  }
  const count = data.length / 8;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const offsets = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const off = view.getBigUint64(i * 8, true);
    if (off > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("Offset exceeds Number.MAX_SAFE_INTEGER");
    }
    offsets[i] = Number(off);
  }
  return offsets;
}

function rebuild_index(dat_path: string, idx_path: string): { offsets: number[]; dat_size: number } {
  if (!exists_sync(dat_path)) {
    return { offsets: [], dat_size: 0 };
  }
  const size = stat_sync(dat_path).size;
  const fd = open_sync(dat_path, "r");
  const offsets: number[] = [];
  let offset = 0;
  const len_buf = Buffer.allocUnsafe(4);
  try {
    while (offset + 4 <= size) {
      read_sync(fd, len_buf, 0, 4, offset);
      const len = new DataView(len_buf.buffer, len_buf.byteOffset, len_buf.byteLength).getUint32(0, true);
      const next = offset + 4 + len;
      if (next > size) {
        break;
      }
      offsets.push(offset);
      offset = next;
    }
  } finally {
    close_sync(fd);
  }
  const idx_buf = Buffer.allocUnsafe(offsets.length * 8);
  const view = new DataView(idx_buf.buffer, idx_buf.byteOffset, idx_buf.byteLength);
  for (let i = 0; i < offsets.length; i++) {
    view.setBigUint64(i * 8, BigInt(offsets[i]), true);
  }
  write_file_sync(idx_path, idx_buf);
  return { offsets, dat_size: offset };
}

function get_room_store(room: string): RoomStore {
  let store = stores.get(room);
  if (store) return store;
  if (!is_valid_room(room)) {
    throw new Error(`Invalid room name: ${JSON.stringify(room)}`);
  }
  const dat_path = `${db_dir}/${room}.dat`;
  const idx_path = `${db_dir}/${room}.idx`;
  let offsets: number[] = [];
  let dat_size = 0;
  if (exists_sync(idx_path)) {
    offsets = load_offsets(idx_path);
    dat_size = exists_sync(dat_path) ? stat_sync(dat_path).size : 0;
  } else if (exists_sync(dat_path)) {
    const rebuilt = rebuild_index(dat_path, idx_path);
    offsets = rebuilt.offsets;
    dat_size = rebuilt.dat_size;
  }
  store = { dat_path, idx_path, offsets, dat_size, read_fd: null };
  stores.set(room, store);
  return store;
}

function get_read_fd(store: RoomStore): number {
  if (store.read_fd === null) {
    store.read_fd = open_sync(store.dat_path, "r");
  }
  return store.read_fd;
}

export function append_post(room: string, post: StoredPost): number {
  ensure_db_dir();
  const store = get_room_store(room);
  const record = encode_record(post);
  // Single write for [len][record]: fewer syscalls and no torn record if the
  // process dies between two appends.
  const rec_buf = Buffer.allocUnsafe(4 + record.length);
  new DataView(rec_buf.buffer, rec_buf.byteOffset, rec_buf.byteLength).setUint32(0, record.length, true);
  rec_buf.set(record, 4);

  const offset = store.dat_size;
  append_file_sync(store.dat_path, rec_buf);

  const idx_buf = Buffer.allocUnsafe(8);
  new DataView(idx_buf.buffer, idx_buf.byteOffset, idx_buf.byteLength).setBigUint64(0, BigInt(offset), true);
  append_file_sync(store.idx_path, idx_buf);

  store.offsets.push(offset);
  store.dat_size += 4 + record.length;
  return store.offsets.length - 1;
}

export function get_post_count(room: string): number {
  const store = get_room_store(room);
  return store.offsets.length;
}

// Read up to `max` posts starting at index `from`, reusing one fd per room.
export function read_posts(room: string, from: number, max: number): StoredPost[] {
  const store = get_room_store(room);
  const start = Math.max(0, from);
  const end = Math.min(store.offsets.length, start + Math.max(0, max));
  if (start >= end) {
    return [];
  }
  const fd = get_read_fd(store);
  const len_buf = Buffer.allocUnsafe(4);
  const out: StoredPost[] = [];
  for (let index = start; index < end; index++) {
    const offset = store.offsets[index];
    read_sync(fd, len_buf, 0, 4, offset);
    const len = new DataView(len_buf.buffer, len_buf.byteOffset, len_buf.byteLength).getUint32(0, true);
    const rec_buf = Buffer.allocUnsafe(len);
    read_sync(fd, rec_buf, 0, len, offset + 4);
    out.push(decode_record(rec_buf));
  }
  return out;
}
