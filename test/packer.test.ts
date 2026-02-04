import { test, expect } from "bun:test";
import { encode, decode, Type } from "../src/packer.ts";

test("UInt/Int encode-decode and size", () => {
  const u32: Type = { $: "UInt", size: 32 };
  const uVal = 0xdeadbeef;
  const uBuf = encode(u32, uVal);
  expect(uBuf.length).toBe(4);
  expect(decode<number>(u32, uBuf)).toBe(uVal >>> 0);

  const i5: Type = { $: "Int", size: 5 };
  const iVal = -3;
  const iBuf = encode(i5, iVal);
  expect(iBuf.length).toBe(1); // 5 bits
  expect(decode<number>(i5, iBuf)).toBe(iVal);
});

test("Struct bit packing size", () => {
  const T: Type = {
    $: "Struct",
    fields: new Map([
      ["x", { $: "UInt", size: 20 }],
      ["y", { $: "UInt", size: 20 }],
      ["dir", { $: "UInt", size: 2 }],
    ]),
  };
  const val = { x: 123456, y: 654321, dir: 3 };
  const buf = encode(T, val);
  expect(buf.length).toBe(6); // 42 bits
  expect(decode<typeof val>(T, buf)).toEqual(val);
});

test("List encoding size", () => {
  const T: Type = { $: "List", type: { $: "UInt", size: 3 } };
  const val = [1, 2];
  const buf = encode(T, val);
  expect(buf.length).toBe(2); // 9 bits
  expect(decode<number[]>(T, buf)).toEqual(val);
});

test("Vector encoding size", () => {
  const T: Type = { $: "Vector", size: 3, type: { $: "UInt", size: 10 } };
  const val = [1, 2, 3];
  const buf = encode(T, val);
  expect(buf.length).toBe(4); // 30 bits
  expect(decode<number[]>(T, buf)).toEqual(val);
});

test("Map encoding size", () => {
  const T: Type = {
    $: "Map",
    key: { $: "UInt", size: 4 },
    value: { $: "UInt", size: 4 },
  };
  const val = new Map<number, number>([
    [1, 2],
    [3, 4],
  ]);
  const buf = encode(T, val);
  expect(buf.length).toBe(3); // 19 bits
  const decoded = decode<Map<number, number>>(T, buf);
  expect(Array.from(decoded.entries())).toEqual(Array.from(val.entries()));
});

test("String encoding size", () => {
  const T: Type = { $: "String" };
  const val1 = "A";
  const buf1 = encode(T, val1);
  expect(buf1.length).toBe(2); // 10 bits
  expect(decode<string>(T, buf1)).toBe(val1);

  const val2 = "€"; // 3 bytes in UTF-8
  const buf2 = encode(T, val2);
  expect(buf2.length).toBe(4); // 28 bits
  expect(decode<string>(T, buf2)).toBe(val2);
});

test("Nat encoding size", () => {
  const T: Type = { $: "Nat" };
  const val = 3;
  const buf = encode(T, val);
  expect(buf.length).toBe(1); // 4 bits
  expect(decode<number>(T, buf)).toBe(val);
});

test("Vector of 4 v2(u8,u8) packs to 8 bytes", () => {
  const V2: Type = {
    $: "Struct",
    fields: new Map([
      ["x", { $: "UInt", size: 8 }],
      ["y", { $: "UInt", size: 8 }],
    ]),
  };
  const T: Type = { $: "Vector", size: 4, type: V2 };
  const val = [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
    { x: 5, y: 6 },
    { x: 7, y: 8 },
  ];
  // 4 * (8 + 8) bits = 64 bits = 8 bytes.
  const buf = encode(T, val);
  expect(buf.length).toBe(8);
  expect(decode<typeof val>(T, buf)).toEqual(val);
});

test("Non-byte-aligned struct packing size", () => {
  const T: Type = {
    $: "Struct",
    fields: new Map([
      ["a", { $: "UInt", size: 3 }],
      ["b", { $: "UInt", size: 5 }],
      ["c", { $: "UInt", size: 9 }],
      ["d", { $: "Int", size: 7 }],
    ]),
  };
  const val = { a: 5, b: 17, c: 300, d: -12 };
  // Total bits = 3+5+9+7 = 24 bits = 3 bytes.
  const buf = encode(T, val);
  expect(buf.length).toBe(3);
  expect(decode<typeof val>(T, buf)).toEqual(val);
});

test("Nested lists, tuples, maps, and strings (size + identity)", () => {
  const T: Type = {
    $: "Struct",
    fields: new Map([
      ["id", { $: "UInt", size: 12 }],
      ["name", { $: "String" }],
      [
        "pairs",
        {
          $: "List",
          type: {
            $: "Tuple",
            fields: [{ $: "UInt", size: 5 }, { $: "Int", size: 7 }],
          },
        },
      ],
      [
        "meta",
        {
          $: "Map",
          key: { $: "UInt", size: 4 },
          value: { $: "UInt", size: 6 },
        },
      ],
    ]),
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
  const buf = encode(T, val);
  expect(buf.length).toBe(11);
  const out = decode<typeof val>(T, buf);
  expect(out.id).toBe(val.id);
  expect(out.name).toBe(val.name);
  expect(out.pairs).toEqual(val.pairs);
  expect(Array.from(out.meta.entries())).toEqual(Array.from(val.meta.entries()));
});

test("BigInt paths for wide UInt/Int", () => {
  const u70: Type = { $: "UInt", size: 70 };
  const uVal = (1n << 69n) + 12345n;
  const uBuf = encode(u70, uVal);
  expect(uBuf.length).toBe(9); // 70 bits
  expect(decode<bigint>(u70, uBuf)).toBe(uVal);

  const i65: Type = { $: "Int", size: 65 };
  const iVal = -(1n << 63n) + 42n;
  const iBuf = encode(i65, iVal);
  expect(iBuf.length).toBe(9); // 65 bits
  expect(decode<bigint>(i65, iBuf)).toBe(iVal);
});

test("Union with struct variants (tag + payload) size", () => {
  const T: Type = {
    $: "Union",
    variants: new Map([
      [
        "down",
        {
          $: "Struct",
          fields: new Map([
            ["key", { $: "UInt", size: 2 }],
            ["player", { $: "UInt", size: 8 }],
          ]),
        },
      ],
      [
        "spawn",
        {
          $: "Struct",
          fields: new Map([
            ["nick", { $: "UInt", size: 8 }],
            ["px", { $: "UInt", size: 10 }],
            ["py", { $: "UInt", size: 10 }],
          ]),
        },
      ],
      [
        "up",
        {
          $: "Struct",
          fields: new Map([
            ["key", { $: "UInt", size: 2 }],
            ["player", { $: "UInt", size: 8 }],
          ]),
        },
      ],
    ]),
  };

  // 3 variants -> tag bits = 2. Payload = 8+10+10 = 28 bits. Total = 30 bits => 4 bytes.
  const val = { $: "spawn", nick: 7, px: 512, py: 256 };
  const buf = encode(T, val);
  expect(buf.length).toBe(4);
  expect(decode<typeof val>(T, buf)).toEqual(val);
});

test("Union with non-struct variants uses value wrapper", () => {
  const T: Type = {
    $: "Union",
    variants: new Map([
      ["a", { $: "UInt", size: 5 }],
      ["b", { $: "Int", size: 7 }],
    ]),
  };
  // 2 variants -> tag bits = 1. Payload = 5 bits. Total = 6 bits => 1 byte.
  const val = { $: "a", value: 17 };
  const buf = encode(T, val);
  expect(buf.length).toBe(1);
  expect(decode<typeof val>(T, buf)).toEqual(val);
});

test("Union tag ordering is alphabetical", () => {
  const T: Type = {
    $: "Union",
    variants: new Map([
      ["z", { $: "UInt", size: 1 }],
      ["a", { $: "UInt", size: 1 }],
    ]),
  };
  // Alphabetical order => "a" is tag 0, "z" is tag 1.
  const bufA = encode(T, { $: "a", value: 1 });
  const bufZ = encode(T, { $: "z", value: 1 });
  expect((bufA[0] & 1) === 0).toBe(true);
  expect((bufZ[0] & 1) === 1).toBe(true);
});

test("GamePost union encode/decode (string fields)", () => {
  const GamePostT: Type = {
    $: "Union",
    variants: new Map([
      [
        "down",
        {
          $: "Struct",
          fields: new Map([
            ["key", { $: "String" }],
            ["player", { $: "String" }],
          ]),
        },
      ],
      [
        "spawn",
        {
          $: "Struct",
          fields: new Map([
            ["nick", { $: "String" }],
            ["px", { $: "UInt", size: 16 }],
            ["py", { $: "UInt", size: 16 }],
          ]),
        },
      ],
      [
        "up",
        {
          $: "Struct",
          fields: new Map([
            ["key", { $: "String" }],
            ["player", { $: "String" }],
          ]),
        },
      ],
    ]),
  };

  const spawn = { $: "spawn", nick: "a", px: 200, py: 200 };
  const down = { $: "down", key: "w", player: "a" };
  const up = { $: "up", key: "d", player: "a" };

  expect(decode<typeof spawn>(GamePostT, encode(GamePostT, spawn))).toEqual(spawn);
  expect(decode<typeof down>(GamePostT, encode(GamePostT, down))).toEqual(down);
  expect(decode<typeof up>(GamePostT, encode(GamePostT, up))).toEqual(up);
});

test("GamePost union sizes (string fields + u16 positions)", () => {
  const GamePostT: Type = {
    $: "Union",
    variants: new Map([
      [
        "down",
        {
          $: "Struct",
          fields: new Map([
            ["key", { $: "String" }],
            ["player", { $: "String" }],
          ]),
        },
      ],
      [
        "spawn",
        {
          $: "Struct",
          fields: new Map([
            ["nick", { $: "String" }],
            ["px", { $: "UInt", size: 16 }],
            ["py", { $: "UInt", size: 16 }],
          ]),
        },
      ],
      [
        "up",
        {
          $: "Struct",
          fields: new Map([
            ["key", { $: "String" }],
            ["player", { $: "String" }],
          ]),
        },
      ],
    ]),
  };

  // Tag bits = 2. String "a"/"w" is 1 byte => 10 bits each.
  // spawn: 2 + 10 + 16 + 16 = 44 bits => 6 bytes.
  const spawn = { $: "spawn", nick: "a", px: 200, py: 200 };
  expect(encode(GamePostT, spawn).length).toBe(6);

  // down/up: 2 + 10 + 10 = 22 bits => 3 bytes.
  const down = { $: "down", key: "w", player: "a" };
  const up = { $: "up", key: "d", player: "a" };
  expect(encode(GamePostT, down).length).toBe(3);
  expect(encode(GamePostT, up).length).toBe(3);
});
