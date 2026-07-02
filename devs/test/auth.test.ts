// Identity layer: Ethereum users, EIP-191 signatures, reveal chains, the
// auth fold, and name claims. All verification is pure and deterministic;
// these tests exercise the protocol directly (fold-level) and end-to-end
// over the simulated network.

import { test, expect } from "bun:test";
import {
  Auth,
  Authed,
  Claim,
  Config,
  Envelope,
  addr_nick,
  auth_config,
  auth_packed,
  auth_text,
  chain_head,
  chain_new,
  chain_pass,
  chain_verify,
  claim_fold,
  claim_make,
  claim_text,
  nick_read,
  packed_decode,
  packed_encode,
  sig_addr,
  sig_make,
  user_addr,
  user_new,
  user_nick,
  VibiNet,
} from "../../vibinet-ts/src/client.ts";
import { SimNetwork, create_rng } from "./sim_network.ts";

// User
// ----

const KEY_ONE = "0000000000000000000000000000000000000000000000000000000000000001";

test("address derivation matches the known Ethereum vector", () => {
  // privkey = 1 is the canonical test vector.
  expect(user_addr({ key: KEY_ONE })).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
});

test("auto-nick is the address' last 8 bytes", () => {
  const user = { key: KEY_ONE };
  const addr = user_addr(user);
  expect(user_nick(user)).toBe(addr_nick(addr));
  expect(nick_read(user_nick(user))).toBe(BigInt("0x" + addr.slice(-16)));
});

// Sig
// ---

test("sign/recover roundtrip; tampered text recovers someone else", () => {
  const user = user_new();
  const addr = user_addr(user);
  const sign = sig_make(user, "hello world");
  expect(sig_addr(sign, "hello world")).toBe(addr);
  expect(sig_addr(sign, "hello world!")).not.toBe(addr);
  expect(sig_addr("00".repeat(65), "hello world")).toBe(null);
  expect(sig_addr("nonsense", "hello world")).toBe(null);
});

// Chain
// -----

test("chain links verify in order and never twice", () => {
  const chain0 = chain_new("00112233445566778899aabbccddeeff", 8);
  let head = chain_head(chain0);
  let chain = chain0;
  const seen: string[] = [];
  for (let i = 0; i < 8; i++) {
    const passed = chain_pass(chain);
    expect(passed).not.toBe(null);
    const [link, next] = passed!;
    expect(chain_verify(head, link)).toBeTrue();
    // A consumed link no longer extends the new head.
    for (const old of seen) {
      expect(chain_verify(link, old)).toBeFalse();
    }
    seen.push(link);
    head = link;
    chain = next;
  }
  expect(chain_pass(chain)).toBe(null); // exhausted
});

// Auth fold
// ---------

const ROOM = "AuthRoom#0001";

type Game = { log: Array<{ n: number; user: string | null }> };

const game_cfg: Config<Game, { n: number }> = {
  initial: { log: [] },
  on_tick: (state) => state,
  on_post: (post: any, state) => ({ log: [...state.log, { n: post.n, user: post.$user }] }),
  tick_rate: 24,
  tolerance: 100,
};

const cfg = auth_config(ROOM, game_cfg);

function fold(state: Authed<Game>, auth: Auth, n: number): Authed<Game> {
  return cfg.on_post({ auth, body: { n } }, state);
}

function last_user(state: Authed<Game>): string | null {
  return state.game.log[state.game.log.length - 1].user;
}

test("join + passes authenticate; theft, replay and cross-room all fail", () => {
  const user = user_new();
  const addr = user_addr(user);
  const chain0 = chain_new("aa5500ff0123456789abcdefaa5500ff", 4);
  const head = chain_head(chain0);
  const join: Auth = { $: "Join", sign: sig_make(user, auth_text(ROOM, head, 1000)), head, time: 1000 };
  const [link1, chain1] = chain_pass(chain0)!;
  const [link2] = chain_pass(chain1)!;

  let state = cfg.initial;

  // Anonymous post: $user null.
  state = fold(state, { $: "Anon" }, 0);
  expect(last_user(state)).toBe(null);

  // Join binds the address; the Join's own body is authenticated.
  state = fold(state, join, 1);
  expect(last_user(state)).toBe(addr);
  expect(state.auth.users[addr].head).toBe(head);

  // Pass reveals in order.
  state = fold(state, { $: "Pass", link: link1 }, 2);
  expect(last_user(state)).toBe(addr);
  state = fold(state, { $: "Pass", link: link2 }, 3);
  expect(last_user(state)).toBe(addr);

  // Theft: replaying an already-consumed link fails.
  state = fold(state, { $: "Pass", link: link1 }, 4);
  expect(last_user(state)).toBe(null);

  // Replaying the Join (same signed time) fails, so the whole sequence
  // can never be re-run in this room.
  state = fold(state, join, 5);
  expect(last_user(state)).toBe(null);

  // A stolen Join replayed into another room recovers a DIFFERENT address
  // (the signature covers the room nick), so the victim is never impersonated.
  const other = auth_config("OtherRm#0002", game_cfg);
  const cross = other.on_post({ auth: join, body: { n: 6 } }, other.initial);
  expect(cross.game.log[0].user).not.toBe(addr);

  // A fresh anchor with a later signed time re-joins fine.
  const chain_b = chain_new("00000000000000000000000000000001", 4);
  const head_b = chain_head(chain_b);
  const rejoin: Auth = { $: "Join", sign: sig_make(user, auth_text(ROOM, head_b, 2000)), head: head_b, time: 2000 };
  state = fold(state, rejoin, 7);
  expect(last_user(state)).toBe(addr);
  const [link_b] = chain_pass(chain_b)!;
  state = fold(state, { $: "Pass", link: link_b }, 8);
  expect(last_user(state)).toBe(addr);

  // Two users coexist.
  const user2 = user_new();
  const chain_c = chain_new("ffffffffffffffffffffffffffffffff", 4);
  const head_c = chain_head(chain_c);
  const join2: Auth = { $: "Join", sign: sig_make(user2, auth_text(ROOM, head_c, 3000)), head: head_c, time: 3000 };
  state = fold(state, join2, 9);
  expect(last_user(state)).toBe(user_addr(user2));
  expect(state.auth.users[addr].head).toBe(link_b); // untouched
});

// Envelope wire format
// --------------------

test("envelope packer roundtrips and stays small", () => {
  const packer = auth_packed({ $: "Struct", fields: { n: { $: "UInt", size: 8 } } });

  const anon: Envelope<{ n: number }> = { auth: { $: "Anon" }, body: { n: 7 } };
  const anon_buf = packed_encode(packer, anon);
  expect(anon_buf.length).toBe(2); // 2 tag bits + 8 body bits
  expect(packed_decode<any>(packer, anon_buf).body.n).toBe(7);

  const pass: Envelope<{ n: number }> = {
    auth: { $: "Pass", link: "00112233445566778899aabbccddeeff" },
    body: { n: 7 },
  };
  const pass_buf = packed_encode(packer, pass);
  expect(pass_buf.length).toBe(18); // 2 + 128 + 8 bits
  const pass_dec = packed_decode<any>(packer, pass_buf);
  expect(pass_dec.auth.link).toBe("00112233445566778899aabbccddeeff");

  const user = user_new();
  const join: Envelope<{ n: number }> = {
    auth: {
      $: "Join",
      sign: sig_make(user, "x"),
      head: "00112233445566778899aabbccddeeff",
      time: 1735820000000,
    },
    body: { n: 7 },
  };
  const join_buf = packed_encode(packer, join);
  expect(join_buf.length).toBe(89); // 2 + 65*8 + 128 + 53 + 8 bits
  const join_dec = packed_decode<any>(packer, join_buf);
  expect(join_dec.auth.sign).toBe(join.auth.$ === "Join" ? join.auth.sign : "");
});

// Claim
// -----

test("claims fold to the latest valid name, replay-proof", () => {
  const user = user_new();
  const addr = user_addr(user);

  const first = claim_make(user, "Johnny", 1000);
  const rename = claim_make(user, "Johnny_the_Bear", 2000);

  expect(claim_fold(addr, [first])).toBe("Johnny");
  expect(claim_fold(addr, [first, rename])).toBe("Johnny_the_Bear");
  // Replaying the older claim after the rename can never win.
  expect(claim_fold(addr, [first, rename, first])).toBe("Johnny_the_Bear");

  // Another user's claim posted into this room is not valid for addr.
  const intruder = user_new();
  const foreign = claim_make(intruder, "Impostor", 3000);
  expect(claim_fold(addr, [first, foreign])).toBe("Johnny");

  // Garbage signatures are ignored.
  const junk: Claim = { sign: "ab".repeat(65), name: "Hax", time: 4000 };
  expect(claim_fold(addr, [junk])).toBe(null);

  // Tampered name breaks the signature.
  const forged: Claim = { ...first, name: "Johnny_" };
  expect(claim_fold(addr, [forged])).toBe(null);

  // Invalid names are rejected before recovery.
  expect(() => claim_make(user, "no spaces", 1)).toThrow();
});

test("claim text binds the nick", () => {
  const user = user_new();
  const text_a = claim_text(user_nick(user), "Johnny", 1000);
  const text_b = claim_text("Someone#0001", "Johnny", 1000);
  expect(text_a).not.toBe(text_b);
});

// End to end
// ----------

test("auth rooms converge over the sim network with mixed identities", () => {
  const network = new SimNetwork<any>(create_rng(777));
  const profile = { uplink_ms: 40, downlink_ms: 40, jitter_ms: 10, clock_offset_ms: 0 };

  const alice_user = user_new();
  const alice_addr = user_addr(alice_user);

  type S = { log: Array<{ n: number; user: string | null; nick: string | null }> };
  const options = {
    room: "E2ERoom#0001",
    initial: { log: [] } as S,
    on_tick: (s: S) => s,
    on_post: (p: any, s: S) => ({ log: [...s.log, { n: p.n, user: p.$user, nick: p.$nick }] }),
    packer: { $: "Struct", fields: { n: { $: "UInt", size: 8 } } } as VibiNet.Packed,
    tick_rate: 24,
    tolerance: 100,
    auth: true,
  };

  const alice = new VibiNet<S, { n: number }>({
    ...options,
    user: alice_user,
    client: network.create_client("alice", profile) as any,
  });
  const bob = new VibiNet<S, { n: number }>({
    ...options,
    client: network.create_client("bob", profile) as any,
  });

  // Alice posts three times (Join, Pass, Pass); Bob posts once (Anon).
  network.scheduler.schedule_at(100, () => alice.post({ n: 1 }));
  network.scheduler.schedule_at(600, () => alice.post({ n: 2 }));
  network.scheduler.schedule_at(1100, () => bob.post({ n: 3 }));
  network.scheduler.schedule_at(1600, () => alice.post({ n: 4 }));
  network.scheduler.run_until(8000);

  const tick = Math.floor((5000 * 24) / 1000);
  const state_a = alice.compute_state_at(tick);
  const state_b = bob.compute_state_at(tick);
  expect(state_a).toEqual(state_b);
  expect(alice.desync()).toBe(null);
  expect(bob.desync()).toBe(null);

  const by_n = new Map(state_a.log.map((entry) => [entry.n, entry]));
  expect(by_n.get(1)!.user).toBe(alice_addr);
  expect(by_n.get(2)!.user).toBe(alice_addr);
  expect(by_n.get(4)!.user).toBe(alice_addr);
  expect(by_n.get(1)!.nick).toBe(addr_nick(alice_addr));
  expect(by_n.get(3)!.user).toBe(null);
  expect(by_n.get(3)!.nick).toBe(null);
});
