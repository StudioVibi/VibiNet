// protocol.ts
//
// Network protocol for VibiNet, encoded via packer.ts.
// Each WebSocket frame is a packed Union with one of these variants:
// - get_time: { nonce }                        client -> server
// - info_time: { nonce, time }                 server -> client
// - post: { room, time, name, check, payload } client -> server
// - info_post: { room, index, server_time, client_time, name, check, payload }
// - watch: { room, from }                      client -> server
// - unwatch: { room }                          client -> server
// - checkpoint: { room, latest_index, server_time }  server -> client
//
// `check` is an optional (tick, hash) checksum of the sender's finalized
// state, used for desync detection. Payload bytes are encoded as a List of
// UInt8, so we convert Uint8Array <-> number[] at the edge. Times are
// UInt(53) to stay within JS safe integers.

import { decode, encode, Packed } from "./packer.ts";

export type WireCheck = { $: "none" } | { $: "some"; tick: number; hash: number };

type WireMessage =
  | { $: "get_time"; nonce: number }
  | { $: "info_time"; nonce: number; time: number }
  | { $: "post"; room: string; time: number; name: string; check: WireCheck; payload: number[] }
  | {
      $: "info_post";
      room: string;
      index: number;
      server_time: number;
      client_time: number;
      name: string;
      check: WireCheck;
      payload: number[];
    }
  | { $: "watch"; room: string; from: number }
  | { $: "unwatch"; room: string }
  | { $: "checkpoint"; room: string; latest_index: number; server_time: number };

export type Message =
  | { $: "get_time"; nonce: number }
  | { $: "info_time"; nonce: number; time: number }
  | { $: "post"; room: string; time: number; name: string; check: WireCheck; payload: Uint8Array }
  | {
      $: "info_post";
      room: string;
      index: number;
      server_time: number;
      client_time: number;
      name: string;
      check: WireCheck;
      payload: Uint8Array;
    }
  | { $: "watch"; room: string; from: number }
  | { $: "unwatch"; room: string }
  | { $: "checkpoint"; room: string; latest_index: number; server_time: number };

const TIME_BITS = 53;
const BYTE_LIST_PACKED: Packed = { $: "List", type: { $: "UInt", size: 8 } };

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
        room: { $: "String" },
        time: { $: "UInt", size: TIME_BITS },
        name: { $: "String" },
        check: CHECK_PACKED,
        payload: BYTE_LIST_PACKED,
      },
    },
    info_post: {
      $: "Struct",
      fields: {
        room: { $: "String" },
        index: { $: "UInt", size: 32 },
        server_time: { $: "UInt", size: TIME_BITS },
        client_time: { $: "UInt", size: TIME_BITS },
        name: { $: "String" },
        check: CHECK_PACKED,
        payload: BYTE_LIST_PACKED,
      },
    },
    watch: {
      $: "Struct",
      fields: {
        room: { $: "String" },
        from: { $: "UInt", size: 32 },
      },
    },
    unwatch: {
      $: "Struct",
      fields: {
        room: { $: "String" },
      },
    },
    checkpoint: {
      $: "Struct",
      fields: {
        room: { $: "String" },
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

function to_wire_message(message: Message): WireMessage {
  switch (message.$) {
    case "post":
      return { ...message, payload: bytes_to_list(message.payload) };
    case "info_post":
      return { ...message, payload: bytes_to_list(message.payload) };
    default:
      return message;
  }
}

function from_wire_message(message: WireMessage): Message {
  switch (message.$) {
    case "post":
      return { ...message, payload: list_to_bytes(message.payload) };
    case "info_post":
      return { ...message, payload: list_to_bytes(message.payload) };
    default:
      return message;
  }
}

export function encode_message(message: Message): Uint8Array {
  return encode(MESSAGE_PACKED, to_wire_message(message));
}

export function decode_message(buf: Uint8Array): Message {
  const message = decode<WireMessage>(MESSAGE_PACKED, buf);
  return from_wire_message(message);
}
