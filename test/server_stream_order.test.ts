import { test, expect } from "bun:test";
import { SimNetwork, create_rng } from "./sim_network.ts";
import { Post } from "./walkers_game.ts";

const ROOM = "ordered-stream-room";

function spawn(pid_char: string, x: number, y: number): Post {
  return {
    $: "spawn",
    pid: pid_char.charCodeAt(0),
    x,
    y,
  };
}

test("server stream is contiguous and gapless per client", () => {
  const network = new SimNetwork<Post>(create_rng(2026));

  for (let i = 0; i < 6; i++) {
    network.scheduler.run_until(i * 10);
    network.server.receive_post(
      ROOM,
      `seed-${i}`,
      spawn("a", i, i),
      network.scheduler.now
    );
  }

  const client = network.create_client("C", {
    uplink_ms: 5,
    downlink_ms: 10,
    jitter_ms: 0,
    clock_offset_ms: 0,
  });

  const received_indices: number[] = [];

  client.watch(ROOM, null, (post) => {
    received_indices.push(post.index);
  });
  client.load(ROOM, 0, null);

  network.scheduler.run_until(network.scheduler.now + 500);
  expect(received_indices).toEqual([0, 1, 2, 3, 4, 5]);

  for (let i = 6; i < 10; i++) {
    network.scheduler.run_until(network.scheduler.now + 10);
    network.server.receive_post(
      ROOM,
      `live-${i}`,
      spawn("b", i, i),
      network.scheduler.now
    );
  }

  network.scheduler.run_until(network.scheduler.now + 500);
  expect(received_indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
