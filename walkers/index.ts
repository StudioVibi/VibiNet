import { Vibi } from "../vibi.js";
import { on_sync, ping } from "../client.js";
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
const TOLERANCE = 300; // milliseconds
const PIXELS_PER_SECOND = 200;
const PIXELS_PER_TICK = PIXELS_PER_SECOND / TICKS_PER_SECOND;

// Initial state: empty map
const initial_state: GameState = {};

// Small immutable helpers
function assoc<T extends Record<string, any>>(obj: T, key: string, value: any): T {
  return { ...(obj as any), [key]: value } as T;
}

function update_key<T extends Record<string, any>>(obj: T, key: string, fn: (v: any) => any): T {
  const prev = (obj as any)[key];
  if (prev === undefined) return obj;
  return { ...(obj as any), [key]: fn(prev) } as T;
}

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
      return assoc(state, post.nick, { px: 200, py: 200, w: 0, a: 0, s: 0, d: 0 });
    }
    case "down": {
      return update_key(state, post.player, (p: Player) => assoc(p, post.key, 1));
    }
    case "up": {
      return update_key(state, post.player, (p: Player) => assoc(p, post.key, 0));
    }
  }
  return state;
}

// Create and export game function
export function create_game(room: string, smooth: (past: GameState, curr: GameState) => GameState) {
  const vibi = new Vibi<GameState, GamePost>(
    room,
    initial_state,
    on_tick,
    on_post,
    smooth,
    TICKS_PER_SECOND,
    TOLERANCE
  );

  return vibi;
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

const room = prompt("Enter room name:");
if (!room) {
  alert("Room name is required!");
  throw new Error("Room name required");
}

const nick = prompt("Enter your nickname (single character):");
if (!nick || nick.length !== 1) {
  alert("Nickname must be exactly one character!");
  throw new Error("Nickname must be one character");
}

console.log("[GAME] Room:", room, "Nick:", nick);

const smooth = (past: GameState, curr: GameState): GameState => {
  if (curr[nick]) past[nick] = curr[nick];
  return past;
};

const game = create_game(room, smooth);

const key_states: Record<string, boolean> = { w: false, a: false, s: false, d: false };

on_sync(() => {
  const spawn_x = 200;
  const spawn_y = 200;
  console.log(`[GAME] Synced; spawning '${nick}' at (${spawn_x},${spawn_y})`);
  game.post({ $: "spawn", nick: nick, px: spawn_x, py: spawn_y });

  const valid_keys = new Set(["w", "a", "s", "d"]);
  function handle_key_event(e: KeyboardEvent) {
    const key = e.key.toLowerCase();
    if (!valid_keys.has(key)) return;
    const is_down = e.type === "keydown";
    if (key_states[key] === is_down) return; // no state change (filters repeats)
    key_states[key] = is_down;
    game.post({ $: (is_down ? "down" : "up"), key: key as any, player: nick });
  }
  window.addEventListener("keydown", handle_key_event);
  window.addEventListener("keyup", handle_key_event);

  console.log("[GAME] Starting render at 24 FPS");
  setInterval(render, FRAME_TIME);
});

const FPS = 24;
const FRAME_TIME = 1000 / FPS;

let frame_count = 0;
let last_perf_log = 0;
let perf_samples: Array<{compute:number; render:number; ticks:number}> = [];

function render() {
  const render_start = performance.now();
  frame_count++;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const compute_start = performance.now();
  const present_tick = game.server_tick();
  const initial_tick = game.initial_tick();
  const ticks_to_process = initial_tick !== null ? present_tick - initial_tick : 0;
  const state = game.compute_render_state();
  const compute_time = performance.now() - compute_start;

  ctx.fillStyle = "#000";
  ctx.font = "14px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  try {
    const st = game.server_time();
    const tk = present_tick;
    const rtt = ping();
    ctx.fillText(`time: ${st}`, 8, 6);
    ctx.fillText(`tick: ${tk}`, 8, 24);
    if (isFinite(rtt)) ctx.fillText(`ping: ${Math.round(rtt)} ms`, 8, 42);
  } catch {}

  ctx.fillStyle = "#000";
  ctx.font = "24px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [char, player] of Object.entries(state)) {
    const x = Math.floor(player.px);
    const y = Math.floor(player.py);
    ctx.fillText(char, x, y);
  }

  const render_time = performance.now() - render_start;
  perf_samples.push({ compute: compute_time, render: render_time, ticks: ticks_to_process });

  if (frame_count - last_perf_log >= 60) {
    const avg_compute = perf_samples.reduce((sum, s) => sum + s.compute, 0) / perf_samples.length;
    const avg_render  = perf_samples.reduce((sum, s) => sum + s.render, 0) / perf_samples.length;
    const avg_ticks   = perf_samples.reduce((sum, s) => sum + s.ticks, 0) / perf_samples.length;
    console.log(`[PERF] Frame ${frame_count} | Players: ${Object.keys(state).length} | Avg compute: ${avg_compute.toFixed(2)}ms | Avg render: ${avg_render.toFixed(2)}ms | Avg ticks/frame: ${avg_ticks.toFixed(1)}`);
    last_perf_log = frame_count;
    perf_samples = [];
  }
}
