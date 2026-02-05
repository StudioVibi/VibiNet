import { VibiNet } from "../src/index.ts";

export type Player = {
  x: number;
  y: number;
  w: number;
  a: number;
  s: number;
  d: number;
};

export type State = {
  [char: string]: Player;
};

type Key = { $: "w" } | { $: "a" } | { $: "s" } | { $: "d" };

export type Post =
  | { $: "spawn"; pid: number; x: number; y: number }
  | { $: "down"; pid: number; key: Key }
  | { $: "up"; pid: number; key: Key };

const key_packer: VibiNet.Packed = {
  $: "Union",
  variants: {
    w: { $: "Struct", fields: {} },
    a: { $: "Struct", fields: {} },
    s: { $: "Struct", fields: {} },
    d: { $: "Struct", fields: {} },
  },
};

export const packer: VibiNet.Packed = {
  $: "Union",
  variants: {
    spawn: {
      $: "Struct",
      fields: {
        pid: { $: "UInt", size: 8 },
        x: { $: "Int", size: 32 },
        y: { $: "Int", size: 32 },
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

export const TICK_RATE = 24;
export const TOLERANCE = 300;
const PIXELS_PER_SECOND = 200;
const PIXELS_PER_TICK = PIXELS_PER_SECOND / TICK_RATE;

export const initial: State = {};

function char_from_ascii_code(code: number): string {
  return String.fromCharCode(code & 0xff);
}

export function on_tick(state: State): State {
  const new_state: State = {};

  for (const [char, player] of Object.entries(state)) {
    new_state[char] = {
      x: player.x +
        (player.d * PIXELS_PER_TICK) +
        (player.a * -PIXELS_PER_TICK),
      y: player.y +
        (player.s * PIXELS_PER_TICK) +
        (player.w * -PIXELS_PER_TICK),
      w: player.w,
      a: player.a,
      s: player.s,
      d: player.d,
    };
  }

  return new_state;
}

export function on_post(post: Post, state: State): State {
  switch (post.$) {
    case "spawn": {
      const nick = char_from_ascii_code(post.pid);
      const player = { x: post.x, y: post.y, w: 0, a: 0, s: 0, d: 0 };
      return { ...state, [nick]: player };
    }
    case "down": {
      const nick = char_from_ascii_code(post.pid);
      const player = { ...state[nick], [post.key.$]: 1 };
      return { ...state, [nick]: player };
    }
    case "up": {
      const nick = char_from_ascii_code(post.pid);
      const player = { ...state[nick], [post.key.$]: 0 };
      return { ...state, [nick]: player };
    }
  }
  return state;
}
