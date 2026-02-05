import { VibiNet } from "../src/index.ts";
import pkg from "../package.json" assert { type: "json" };

// Walkers: each player is a single letter that moves with WASD.
// This file mirrors the README tutorial steps, but with full code.

// -----------------------------------------------------------------------------
// 1) State
// -----------------------------------------------------------------------------
// State is a full snapshot of the world at one tick.
// It must be plain data and safe to copy/replay deterministically.

type Player = {
  x: number;
  y: number;
  w: number;
  a: number;
  s: number;
  d: number;
};

type State = {
  [char: string]: Player;
};

const initial: State = {};

// -----------------------------------------------------------------------------
// 2) Posts (inputs only)
// -----------------------------------------------------------------------------
// Posts are player inputs. They are the only things sent over the network.
// In this demo, `pid` is a single ASCII character code that identifies a player.

type PID = number;

type Key =
  | { $: "w" }
  | { $: "a" }
  | { $: "s" }
  | { $: "d" };

type Post =
  | { $: "spawn"; pid: PID; x: number; y: number }
  | { $: "down"; pid: PID; key: Key }
  | { $: "up"; pid: PID; key: Key };

// -----------------------------------------------------------------------------
// 3) Pure game logic (no mutation)
// -----------------------------------------------------------------------------
// These functions MUST be pure: they must not mutate the input state in place.
// VibiNet relies on immutability to keep all clients in sync.

const TICK_RATE         = 24;  // ticks per second
const TOLERANCE         = 100; // ms
const PIXELS_PER_SECOND = 200;
const PIXELS_PER_TICK   = PIXELS_PER_SECOND / TICK_RATE;

function on_tick(state: State): State {
  const new_state: State = {};

  for (const [char, player] of Object.entries(state)) {
    new_state[char] = {
      x:
        player.x +
        (player.d * PIXELS_PER_TICK) +
        (player.a * -PIXELS_PER_TICK),
      y:
        player.y +
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

function on_post(post: Post, state: State): State {
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

// -----------------------------------------------------------------------------
// 4) Post packing
// -----------------------------------------------------------------------------
// VibiNet stores and sends posts in compact binary form.
// This schema describes how to encode/decode the Post type.

const key_packer: VibiNet.Packed = {
  $: "Union",
  variants: {
    w: { $: "Struct", fields: {} },
    a: { $: "Struct", fields: {} },
    s: { $: "Struct", fields: {} },
    d: { $: "Struct", fields: {} },
  },
};

const packer: VibiNet.Packed = {
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

// -----------------------------------------------------------------------------
// 5) Browser bootstrap
// -----------------------------------------------------------------------------
// The rest of the file is plain browser code that uses the VibiNet game object.
// Rendering is not part of VibiNet; it just computes state.

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

function resize_canvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

resize_canvas();
window.addEventListener("resize", resize_canvas);

let room = prompt("Enter room name:");
if (!room) room = VibiNet.gen_name();

const nick = prompt("Enter your nickname (single ASCII character):");
if (!nick) {
  alert("Nickname must be a single ASCII character!");
  throw new Error("Nickname must be one character");
}

const player_id = ascii_code_from_char(nick);
const player_char = nick;

// Use local prediction for your player, remote for everyone else.
const smooth = (remote_state: State, local_state: State): State => {
  if (!local_state[player_char]) {
    return remote_state;
  }
  return { ...remote_state, [player_char]: local_state[player_char] };
};

// Choose local server when running locally; otherwise default to the hosted one.
const host = window.location.hostname;
const server =
  host === "localhost" || host === "127.0.0.1"
    ? `ws://${host}:8080`
    : "ws://net.studiovibi.com:8080";

// Create the game object (the only VibiNet object you use at runtime).
const game = new VibiNet.game<State, Post>({
  server,
  room,
  initial,
  on_tick,
  on_post,
  packer,
  tick_rate: TICK_RATE,
  tolerance: TOLERANCE,
  smooth,
});

document.title = `Walkers ${pkg.version}`;

const key_states: Record<"w" | "a" | "s" | "d", boolean> = {
  w: false,
  a: false,
  s: false,
  d: false,
};

// Wait for time sync before posting.
game.on_sync(() => {
  const spawn_x = 200;
  const spawn_y = 200;
  game.post({ $: "spawn", pid: player_id, x: spawn_x, y: spawn_y });

  function handle_key_event(e: KeyboardEvent) {
    const key_str = e.key.toLowerCase();
    const is_down = e.type === "keydown";

    if (!Object.prototype.hasOwnProperty.call(key_states, key_str)) {
      return;
    }

    const typed_key = key_str as "w" | "a" | "s" | "d";
    if (key_states[typed_key] === is_down) {
      return;
    }

    key_states[typed_key] = is_down;
    const action = is_down ? "down" : "up";
    game.post({ $: action, pid: player_id, key: { $: typed_key } });
  }

  window.addEventListener("keydown", handle_key_event);
  window.addEventListener("keyup", handle_key_event);
  setInterval(render, 1000 / TICK_RATE);
});

function render() {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const curr_tick = game.server_tick();
  const state = game.compute_render_state();

  ctx.fillStyle = "#111";
  ctx.font = "14px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  try {
    const st = game.server_time();
    const pc = game.post_count();
    const rtt = game.ping();
    ctx.fillText(`room: ${room}`, 8, 6);
    ctx.fillText(`time: ${st}`, 8, 24);
    ctx.fillText(`tick: ${curr_tick}`, 8, 42);
    ctx.fillText(`post: ${pc}`, 8, 60);
    if (isFinite(rtt)) ctx.fillText(`ping: ${Math.round(rtt)} ms`, 8, 78);
  } catch {}

  for (const [char, player] of Object.entries(state)) {
    ctx.fillStyle = "#111";
    ctx.font = "24px sans-serif";
    ctx.fillText(char, player.x, player.y);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function ascii_code_from_char(char: string): number {
  if (char.length !== 1) {
    throw new Error("Nickname must be a single character");
  }
  const code = char.charCodeAt(0);
  if (code < 0x20 || code > 0x7e) {
    throw new Error("Nickname must be a printable ASCII character");
  }
  return code;
}

function char_from_ascii_code(code: number): string {
  return String.fromCharCode(code & 0xff);
}
