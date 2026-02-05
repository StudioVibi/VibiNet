import { test, expect } from "bun:test";
import { encode, decode, Packed } from "../src/packer.ts";

test("UInt/Int encode-decode and size", () => {
  const u32: Packed = { $: "UInt", size: 32 };
  const u_val = 0xdeadbeef;
  const u_buf = encode(u32, u_val);
  expect(u_buf.length).toBe(4);
  expect(decode<number>(u32, u_buf)).toBe(u_val >>> 0);

  const i5: Packed = { $: "Int", size: 5 };
  const i_val = -3;
  const i_buf = encode(i5, i_val);
  expect(i_buf.length).toBe(1); // 5 bits
  expect(decode<number>(i5, i_buf)).toBe(i_val);
});

test("Struct bit packing size", () => {
  const packed_t: Packed = {
    $: "Struct",
    fields: {
      x: { $: "UInt", size: 20 },
      y: { $: "UInt", size: 20 },
      dir: { $: "UInt", size: 2 },
    },
  };
  const val = { x: 123456, y: 654321, dir: 3 };
  const buf = encode(packed_t, val);
  expect(buf.length).toBe(6); // 42 bits
  expect(decode<typeof val>(packed_t, buf)).toEqual(val);
});

test("List encoding size", () => {
  const packed_t: Packed = { $: "List", type: { $: "UInt", size: 3 } };
  const val = [1, 2];
  const buf = encode(packed_t, val);
  expect(buf.length).toBe(2); // 9 bits
  expect(decode<number[]>(packed_t, buf)).toEqual(val);
});

test("Vector encoding size", () => {
  const packed_t: Packed = { $: "Vector", size: 3, type: { $: "UInt", size: 10 } };
  const val = [1, 2, 3];
  const buf = encode(packed_t, val);
  expect(buf.length).toBe(4); // 30 bits
  expect(decode<number[]>(packed_t, buf)).toEqual(val);
});

test("Map encoding size", () => {
  const packed_t: Packed = {
    $: "Map",
    key: { $: "UInt", size: 4 },
    value: { $: "UInt", size: 4 },
  };
  const val = new Map<number, number>([
    [1, 2],
    [3, 4],
  ]);
  const buf = encode(packed_t, val);
  expect(buf.length).toBe(3); // 19 bits
  const decoded = decode<Map<number, number>>(packed_t, buf);
  expect(Array.from(decoded.entries())).toEqual(Array.from(val.entries()));
});

test("String encoding size", () => {
  const packed_t: Packed = { $: "String" };
  const val_1 = "A";
  const buf_1 = encode(packed_t, val_1);
  expect(buf_1.length).toBe(2); // 10 bits
  expect(decode<string>(packed_t, buf_1)).toBe(val_1);

  const val_2 = "€"; // 3 bytes in UTF-8
  const buf_2 = encode(packed_t, val_2);
  expect(buf_2.length).toBe(4); // 28 bits
  expect(decode<string>(packed_t, buf_2)).toBe(val_2);
});

test("Nat encoding size", () => {
  const packed_t: Packed = { $: "Nat" };
  const val = 3;
  const buf = encode(packed_t, val);
  expect(buf.length).toBe(1); // 4 bits
  expect(decode<number>(packed_t, buf)).toBe(val);
});

test("Vector of 4 v2(u8,u8) packs to 8 bytes", () => {
  const v2_packed: Packed = {
    $: "Struct",
    fields: {
      x: { $: "UInt", size: 8 },
      y: { $: "UInt", size: 8 },
    },
  };
  const packed_t: Packed = { $: "Vector", size: 4, type: v2_packed };
  const val = [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
    { x: 5, y: 6 },
    { x: 7, y: 8 },
  ];
  // 4 * (8 + 8) bits = 64 bits = 8 bytes.
  const buf = encode(packed_t, val);
  expect(buf.length).toBe(8);
  expect(decode<typeof val>(packed_t, buf)).toEqual(val);
});

test("Non-byte-aligned struct packing size", () => {
  const packed_t: Packed = {
    $: "Struct",
    fields: {
      a: { $: "UInt", size: 3 },
      b: { $: "UInt", size: 5 },
      c: { $: "UInt", size: 9 },
      d: { $: "Int", size: 7 },
    },
  };
  const val = { a: 5, b: 17, c: 300, d: -12 };
  // Total bits = 3+5+9+7 = 24 bits = 3 bytes.
  const buf = encode(packed_t, val);
  expect(buf.length).toBe(3);
  expect(decode<typeof val>(packed_t, buf)).toEqual(val);
});

test("Nested lists, tuples, maps, and strings (size + identity)", () => {
  const packed_t: Packed = {
    $: "Struct",
    fields: {
      id: { $: "UInt", size: 12 },
      name: { $: "String" },
      pairs: {
        $: "List",
        type: {
          $: "Tuple",
          fields: [{ $: "UInt", size: 5 }, { $: "Int", size: 7 }],
        },
      },
      meta: {
        $: "Map",
        key: { $: "UInt", size: 4 },
        value: { $: "UInt", size: 6 },
      },
    },
  };

  const val = {
    id: 0xabc,
    name: "Hi",
    pairs: [
      [3, -4],
      [7, 5],
    ],
    meta: new Map([
      [1, 12],
      [2, 34],
    ]),
  };

  // Manual size:
  // id: 12 bits
  // name "Hi" -> 2 bytes UTF-8: 2*(1+8) + 1 = 19 bits
  // pairs: list of 2 tuples
  //   each tuple: 5 + 7 = 12 bits, plus 1 list tag
  //   list bits: 2*(1+12) + 1 = 27 bits
  // meta: map with 2 entries
  //   each entry: 4+6 bits, plus 1 list tag
  //   map bits: 2*(1+10) + 1 = 23 bits
  // total = 12 + 19 + 27 + 23 = 81 bits => 11 bytes
  const buf = encode(packed_t, val);
  expect(buf.length).toBe(11);
  const out = decode<typeof val>(packed_t, buf);
  expect(out.id).toBe(val.id);
  expect(out.name).toBe(val.name);
  expect(out.pairs).toEqual(val.pairs);
  expect(Array.from(out.meta.entries())).toEqual(Array.from(val.meta.entries()));
});

test("BigInt paths for wide UInt/Int", () => {
  const u70: Packed = { $: "UInt", size: 70 };
  const u_val = (1n << 69n) + 12345n;
  const u_buf = encode(u70, u_val);
  expect(u_buf.length).toBe(9); // 70 bits
  expect(decode<bigint>(u70, u_buf)).toBe(u_val);

  const i65: Packed = { $: "Int", size: 65 };
  const i_val = -(1n << 63n) + 42n;
  const i_buf = encode(i65, i_val);
  expect(i_buf.length).toBe(9); // 65 bits
  expect(decode<bigint>(i65, i_buf)).toBe(i_val);
});

test("Union with struct variants (tag + payload) size", () => {
  const packed_t: Packed = {
    $: "Union",
    variants: {
      down: {
        $: "Struct",
        fields: {
          key: { $: "UInt", size: 2 },
          player: { $: "UInt", size: 8 },
        },
      },
      spawn: {
        $: "Struct",
        fields: {
          nick: { $: "UInt", size: 8 },
          x: { $: "UInt", size: 10 },
          y: { $: "UInt", size: 10 },
        },
      },
      up: {
        $: "Struct",
        fields: {
          key: { $: "UInt", size: 2 },
          player: { $: "UInt", size: 8 },
        },
      },
    },
  };

  // 3 variants -> tag bits = 2. Payload = 8+10+10 = 28 bits. Total = 30 bits => 4 bytes.
  const val = { $: "spawn", nick: 7, x: 512, y: 256 };
  const buf = encode(packed_t, val);
  expect(buf.length).toBe(4);
  expect(decode<typeof val>(packed_t, buf)).toEqual(val);
});

test("Union with non-struct variants uses value wrapper", () => {
  const packed_t: Packed = {
    $: "Union",
    variants: {
      a: { $: "UInt", size: 5 },
      b: { $: "Int", size: 7 },
    },
  };
  // 2 variants -> tag bits = 1. Payload = 5 bits. Total = 6 bits => 1 byte.
  const val = { $: "a", value: 17 };
  const buf = encode(packed_t, val);
  expect(buf.length).toBe(1);
  expect(decode<typeof val>(packed_t, buf)).toEqual(val);
});

test("Union tag ordering is alphabetical", () => {
  const packed_t: Packed = {
    $: "Union",
    variants: {
      z: { $: "UInt", size: 1 },
      a: { $: "UInt", size: 1 },
    },
  };
  // Alphabetical order => "a" is tag 0, "z" is tag 1.
  const buf_a = encode(packed_t, { $: "a", value: 1 });
  const buf_z = encode(packed_t, { $: "z", value: 1 });
  expect((buf_a[0] & 1) === 0).toBe(true);
  expect((buf_z[0] & 1) === 1).toBe(true);
});

test("GamePost union encode/decode (string fields)", () => {
  const key_packer: Packed = {
    $: "Union",
    variants: {
      w: { $: "Struct", fields: {} },
      a: { $: "Struct", fields: {} },
      s: { $: "Struct", fields: {} },
      d: { $: "Struct", fields: {} },
    },
  };
  const game_post_t: Packed = {
    $: "Union",
    variants: {
      spawn: {
        $: "Struct",
        fields: {
          pid: { $: "UInt", size: 8 },
          x: { $: "UInt", size: 16 },
          y: { $: "UInt", size: 16 },
        },
      },
      down: {
        $: "Struct",
        fields: {
          pid: { $: "UInt", size: 8 },
          key: key_packer,
        },
      },
      up: {
        $: "Struct",
        fields: {
          pid: { $: "UInt", size: 8 },
          key: key_packer,
        },
      },
    },
  };

  const spawn = { $: "spawn", pid: 97, x: 200, y: 200 };
  const down = { $: "down", pid: 97, key: { $: "w" } };
  const up = { $: "up", pid: 97, key: { $: "d" } };

  expect(decode<typeof spawn>(game_post_t, encode(game_post_t, spawn))).toEqual(spawn);
  expect(decode<typeof down>(game_post_t, encode(game_post_t, down))).toEqual(down);
  expect(decode<typeof up>(game_post_t, encode(game_post_t, up))).toEqual(up);
});

test("GamePost union sizes (string fields + u16 positions)", () => {
  const key_packer: Packed = {
    $: "Union",
    variants: {
      w: { $: "Struct", fields: {} },
      a: { $: "Struct", fields: {} },
      s: { $: "Struct", fields: {} },
      d: { $: "Struct", fields: {} },
    },
  };
  const game_post_t: Packed = {
    $: "Union",
    variants: {
      spawn: {
        $: "Struct",
        fields: {
          pid: { $: "UInt", size: 8 },
          x: { $: "UInt", size: 16 },
          y: { $: "UInt", size: 16 },
        },
      },
      down: {
        $: "Struct",
        fields: {
          pid: { $: "UInt", size: 8 },
          key: key_packer,
        },
      },
      up: {
        $: "Struct",
        fields: {
          pid: { $: "UInt", size: 8 },
          key: key_packer,
        },
      },
    },
  };

  // Tag bits = 2. Key enum uses 2 bits.
  // spawn: 2 + 8 + 16 + 16 = 42 bits => 6 bytes.
  const spawn = { $: "spawn", pid: 97, x: 200, y: 200 };
  expect(encode(game_post_t, spawn).length).toBe(6);

  // down/up: 2 + 2 + 8 = 12 bits => 2 bytes.
  const down = { $: "down", pid: 97, key: { $: "w" } };
  const up = { $: "up", pid: 97, key: { $: "d" } };
  expect(encode(game_post_t, down).length).toBe(2);
  expect(encode(game_post_t, up).length).toBe(2);
});
