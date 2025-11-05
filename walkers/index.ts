import { StateMachine } from "../state_machine.js";
export { on_sync, ping } from "../client.js";

// Player type
type Player = {
  px: number;
  py: number;
  w: number;
  a: number;
  s: number;
  d: number;
};

// Game state: map from character to player
type GameState = {
  [char: string]: Player;
};

// Post types
type GamePost =
  | { $: "spawn"; nick: string; px: number; py: number }
  | { $: "down"; key: "w" | "a" | "s" | "d"; player: string }
  | { $: "up"; key: "w" | "a" | "s" | "d"; player: string };

// Game configuration
const TICKS_PER_SECOND = 24; // ticks per second
const TOLERANCE = 200; // milliseconds
const PIXELS_PER_SECOND = 200;
const PIXELS_PER_TICK = PIXELS_PER_SECOND / TICKS_PER_SECOND;

// Initial state: empty map
const initial_state: GameState = {};

// on_tick: update player positions based on WASD state
function on_tick(state: GameState): GameState {
  const new_state: GameState = {};

  for (const [char, player] of Object.entries(state)) {
    new_state[char] = {
      px: player.px + (player.d * PIXELS_PER_TICK) + (player.a * -PIXELS_PER_TICK),
      py: player.py + (player.s * PIXELS_PER_TICK) + (player.w * -PIXELS_PER_TICK),
      w: player.w,
      a: player.a,
      s: player.s,
      d: player.d,
    };
  }

  return new_state;
}

// on_post: handle player commands
function on_post(post: GamePost, state: GameState): GameState {
  switch (post.$) {
    case "spawn": {
      // Pin spawn at fixed coordinates (200,200)
      return {
        ...state,
        [post.nick]: {
          px: 200,
          py: 200,
          w: 0,
          a: 0,
          s: 0,
          d: 0,
        },
      };
    }
    case "down": {
      const player = state[post.player];
      if (!player) return state;
      return {
        ...state,
        [post.player]: {
          ...player,
          [post.key]: 1,
        },
      };
    }
    case "up": {
      const player = state[post.player];
      if (!player) return state;
      return {
        ...state,
        [post.player]: {
          ...player,
          [post.key]: 0,
        },
      };
    }
  }
  return state;
}

// Create and export game function
export function createGame(room: string) {
  const sm = new StateMachine<GameState, GamePost>(
    room,
    initial_state,
    on_tick,
    on_post,
    TICKS_PER_SECOND,
    TOLERANCE
  );

  return sm;
}
