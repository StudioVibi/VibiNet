// protocol.ts
//
// Network protocol for VibiNet, encoded via packer.ts.
// Each WebSocket frame is a packed Union with one of these variants:
// - get_time: no fields
// - info_time: { time }
// - post: { room, time, name, payload }
// - info_post: { room, index, server_time, client_time, name, payload }
// - load: { room, from }
// - watch: { room }
// - unwatch: { room }
//
// The protocol reuses packer for all fields. Payload bytes are encoded
// as a List of UInt8, so we convert Uint8Array <-> number[] at the edge.
// Times are stored as UInt(53) to stay within JS safe integers.

import { decode, encode, Packed } from "./packer.ts";

type WireMessage =
  | { $: "get_time" }
  | { $: "info_time"; time: number }
  | { $: "post"; room: string; time: number; name: string; payload: number[] }
  | {
      $: "info_post";
      room: string;
      index: number;
      server_time: number;
      client_time: number;
      name: string;
      payload: number[];
    }
  | { $: "load"; room: string; from: number }
  | { $: "watch"; room: string }
  | { $: "unwatch"; room: string };

export type Message =
  | { $: "get_time" }
  | { $: "info_time"; time: number }
  | { $: "post"; room: string; time: number; name: string; payload: Uint8Array }
  | {
      $: "info_post";
      room: string;
      index: number;
      server_time: number;
      client_time: number;
      name: string;
      payload: Uint8Array;
    }
  | { $: "load"; room: string; from: number }
  | { $: "watch"; room: string }
  | { $: "unwatch"; room: string };

const TIME_BITS = 53;
const BYTE_LIST_PACKED: Packed = { $: "List", type: { $: "UInt", size: 8 } };

const MESSAGE_PACKED: Packed = {
  $: "Union",
  variants: {
    get_time: { $: "Struct", fields: {} },
    info_time: {
      $: "Struct",
      fields: {
        time: { $: "UInt", size: TIME_BITS },
      },
    },
    post: {
      $: "Struct",
      fields: {
        room: { $: "String" },
        time: { $: "UInt", size: TIME_BITS },
        name: { $: "String" },
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
        payload: BYTE_LIST_PACKED,
      },
    },
    load: {
      $: "Struct",
      fields: {
        room: { $: "String" },
        from: { $: "UInt", size: 32 },
      },
    },
    watch: {
      $: "Struct",
      fields: {
        room: { $: "String" },
      },
    },
    unwatch: {
      $: "Struct",
      fields: {
        room: { $: "String" },
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
      return {
        $: "post",
        room: message.room,
        time: message.time,
        name: message.name,
        payload: bytes_to_list(message.payload),
      };
    case "info_post":
      return {
        $: "info_post",
        room: message.room,
        index: message.index,
        server_time: message.server_time,
        client_time: message.client_time,
        name: message.name,
        payload: bytes_to_list(message.payload),
      };
    default:
      return message as WireMessage;
  }
}

function from_wire_message(message: WireMessage): Message {
  switch (message.$) {
    case "post":
      return {
        $: "post",
        room: message.room,
        time: message.time,
        name: message.name,
        payload: list_to_bytes(message.payload),
      };
    case "info_post":
      return {
        $: "info_post",
        room: message.room,
        index: message.index,
        server_time: message.server_time,
        client_time: message.client_time,
        name: message.name,
        payload: list_to_bytes(message.payload),
      };
    default:
      return message as Message;
  }
}

export function encode_message(message: Message): Uint8Array {
  return encode(MESSAGE_PACKED, to_wire_message(message));
}

export function decode_message(buf: Uint8Array): Message {
  const message = decode<WireMessage>(MESSAGE_PACKED, buf);
  return from_wire_message(message);
}
