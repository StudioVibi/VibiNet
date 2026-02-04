import type { Packed } from "../src/packer.ts";

export type Player = {
  px: number;
  py: number;
  w: number;
  a: number;
  s: number;
  d: number;
};

export type GameState = {
  [char: string]: Player;
};

export type GamePost =
  | { $: "spawn"; nick: string; px: number; py: number }
  | { $: "down"; key: "w" | "a" | "s" | "d"; player: string }
  | { $: "up"; key: "w" | "a" | "s" | "d"; player: string };

export const game_post_packed: Packed = {
  $: "Union",
  variants: {
    down: {
      $: "Struct",
      fields: {
        key: { $: "String" },
        player: { $: "String" },
      },
    },
    spawn: {
      $: "Struct",
      fields: {
        nick: { $: "String" },
        px: { $: "Int", size: 32 },
        py: { $: "Int", size: 32 },
      },
    },
    up: {
      $: "Struct",
      fields: {
        key: { $: "String" },
        player: { $: "String" },
      },
    },
  },
};

export const TICK_RATE = 24;
export const TOLERANCE = 300;
const PIXELS_PER_SECOND = 200;
const PIXELS_PER_TICK = PIXELS_PER_SECOND / TICK_RATE;

export const initial: GameState = {};

export function on_tick(state: GameState): GameState {
  const new_state: GameState = {};

  for (const [char, player] of Object.entries(state)) {
    new_state[char] = {
      px: player.px +
        (player.d * PIXELS_PER_TICK) +
        (player.a * -PIXELS_PER_TICK),
      py: player.py +
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

export function on_post(post: GamePost, state: GameState): GameState {
  switch (post.$) {
    case "spawn": {
      const player = { px: 200, py: 200, w: 0, a: 0, s: 0, d: 0 };
      return { ...state, [post.nick]: player };
    }
    case "down": {
      const updated = { ...state[post.player], [post.key]: 1 };
      return { ...state, [post.player]: updated };
    }
    case "up": {
      const updated = { ...state[post.player], [post.key]: 0 };
      return { ...state, [post.player]: updated };
    }
  }
  return state;
}
