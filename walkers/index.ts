import { Vibi } from "../src/vibi.ts";
import type { Packed } from "../src/packer.ts";
import { on_sync, ping, gen_name } from "../src/client.ts";
import pkg from "../package.json" assert { type: "json" };

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

const game_post_packed: Packed = {
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

// Game configuration
const TICK_RATE         = 24; // ticks per second
const TOLERANCE         = 300; // milliseconds
const PIXELS_PER_SECOND = 200;
const PIXELS_PER_TICK   = PIXELS_PER_SECOND / TICK_RATE;

// Initial state: empty map
const initial: GameState = {};

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

// Create and export game function
export function create_game(
  room: string,
  smooth: (remote_state: GameState, local_state: GameState) => GameState
) {
  return new Vibi<GameState, GamePost>(
    room,
    initial,
    on_tick,
    on_post,
    game_post_packed,
    smooth,
    TICK_RATE,
    TOLERANCE
  );
}

// ---- App bootstrap (no JS in HTML) ----
const canvas: HTMLCanvasElement = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

function resize_canvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resize_canvas();
window.addEventListener("resize", resize_canvas);

let room = prompt("Enter room name:");
if (!room) room = gen_name();

const nick = prompt("Enter your nickname (single character):");
if (!nick || nick.length !== 1) {
  alert("Nickname must be exactly one character!");
  throw new Error("Nickname must be one character");
}

console.log("[GAME] Room:", room, "Nick:", nick);

const smooth = (remote_state: GameState, local_state: GameState): GameState => {
  if (!local_state[nick]) {
    return remote_state;
  }
  return { ...remote_state, [nick]: local_state[nick] };
};

const game: Vibi<GameState, GamePost> = create_game(room, smooth);
document.title = `Walkers ${pkg.version}`;

const key_states: Record<string, boolean> = { w: false, a: false, s: false, d: false };

on_sync(() => {
  const spawn_x = 200;
  const spawn_y = 200;
  console.log(`[GAME] Synced; spawning '${nick}' at (${spawn_x},${spawn_y})`);
  game.post({ $: "spawn", nick: nick, px: spawn_x, py: spawn_y });

  const valid_keys = new Set(["w", "a", "s", "d"]);

  function handle_key_event(e: KeyboardEvent) {
    const key     = e.key.toLowerCase();
    const is_down = e.type === "keydown";

    if (!valid_keys.has(key)) {
      return;
    }

    if (key_states[key] === is_down) {
      return; // no state change (filters repeats)
    }

    key_states[key] = is_down;
    const action = is_down ? "down" : "up";
    game.post({ $: action, key: key as any, player: nick });
  }
  window.addEventListener("keydown", handle_key_event);
  window.addEventListener("keyup", handle_key_event);

  setInterval(render, 1000 / TICK_RATE);
});

function render() {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const curr_tick = game.server_tick();
  const state     = game.compute_render_state();

  ctx.fillStyle    = "#000";
  ctx.font         = "14px monospace";
  ctx.textAlign    = "left";
  ctx.textBaseline = "top";

  try {
    const st  = game.server_time();
    const pc  = (game as any).post_count ? (game as any).post_count() : 0;
    const rtt = ping();

    ctx.fillText(`room: ${room}`, 8, 6);
    ctx.fillText(`time: ${st}`, 8, 24);
    ctx.fillText(`tick: ${curr_tick}`, 8, 42);
    ctx.fillText(`post: ${pc}`, 8, 60);

    if (isFinite(rtt)) {
      ctx.fillText(`ping: ${Math.round(rtt)} ms`, 8, 78);
    }
  } catch {}

  ctx.fillStyle    = "#000";
  ctx.font         = "24px monospace";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";

  for (const [char, player] of Object.entries(state)) {
    const x = Math.floor(player.px);
    const y = Math.floor(player.py);
    ctx.fillText(char, x, y);
  }
}
