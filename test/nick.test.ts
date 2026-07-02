// Nicks are the text form of 64-bit ids: 8 chars in [_a-zA-Z0-9$] plus '#'
// plus 4 hex digits. Leading '_' are zero digits (stripped when printing).

import { test, expect } from "bun:test";
import { nick_read, nick_show, nick_norm, nick_link, nick_hex, packed_encode, packed_decode, Packed } from "../src/vibinet.ts";

test("nick roundtrip on random codes", () => {
  let seed = 0x9e3779b97f4a7c15n;
  const next = () => {
    // splitmix64
    seed = (seed + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = seed;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return z ^ (z >> 31n);
  };
  for (let i = 0; i < 1000; i++) {
    const code = next();
    const text = nick_show(code);
    expect(nick_read(text)).toBe(code);
    expect(nick_read(nick_link(text))).toBe(code);
  }
});

test("leading underscores are zero digits", () => {
  expect(nick_read("Bob#1234")).toBe(nick_read("_____Bob#1234"));
  expect(nick_norm("_____Bob#1234")).toBe("Bob#1234");
  expect(nick_show(nick_read("Bob#1234")!)).toBe("Bob#1234");
});

test("hex tail is case-insensitive on read, uppercase on show", () => {
  expect(nick_read("Bob#15ff")).toBe(nick_read("Bob#15FF"));
  expect(nick_norm("Bob#15ff")).toBe("Bob#15FF");
});

test("dot separator (URL form) parses", () => {
  expect(nick_read("JohnBear.15FF")).toBe(nick_read("JohnBear#15FF"));
  expect(nick_link("JohnBear#15FF")).toBe("JohnBear.15FF");
});

test("boundary codes", () => {
  expect(nick_show(0n)).toBe("#0000");
  expect(nick_read("#0000")).toBe(0n);
  expect(nick_show(0xffffffffffffffffn)).toBe("$$$$$$$$#FFFF");
  expect(nick_read("$$$$$$$$#FFFF")).toBe(0xffffffffffffffffn);
});

test("invalid nicks are rejected", () => {
  expect(nick_read("")).toBe(null);
  expect(nick_read("Bob")).toBe(null);
  expect(nick_read("Bob#123")).toBe(null);
  expect(nick_read("Bob#12345")).toBe(null);
  expect(nick_read("TooLongName#1234")).toBe(null);
  expect(nick_read("Bo b#1234")).toBe(null);
  expect(nick_read("Bob#12G4")).toBe(null);
  expect(nick_read("Bob-1234")).toBe(null);
});

test("nick_hex gives the 16-hex file name", () => {
  expect(nick_hex("#0000")).toBe("0000000000000000");
  expect(nick_hex("$$$$$$$$#FFFF")).toBe("ffffffffffffffff");
  expect(nick_hex("not a nick")).toBe(null);
});

test("Hex packs bytes and reads back lowercase", () => {
  const hex16: Packed = { $: "Hex", size: 16 };
  const val = "00ff10a0DEADBEEF0123456789abcdef";
  const buf = packed_encode(hex16, val);
  expect(buf.length).toBe(16);
  expect(packed_decode<string>(hex16, buf)).toBe(val.toLowerCase());

  expect(() => packed_encode(hex16, "1234")).toThrow();
  expect(() => packed_encode(hex16, "zz" + val.slice(2))).toThrow();
});
