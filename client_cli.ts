import * as readline from "readline";
import * as client from "./client.ts";

// Setup readline for interactive input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> "
});

// Handle Ctrl-C and Ctrl-Z to exit gracefully
process.on("SIGINT", () => {
  console.log("\nExiting...");
  client.close();
  process.exit(0);
});

process.on("SIGTSTP", () => {
  console.log("\nExiting...");
  client.close();
  process.exit(0);
});

// Show prompt after connection is ready
setTimeout(() => {
  rl.prompt();
}, 100);

// Handle user input
rl.on("line", (input) => {
  const trimmed = input.trim();
  const parts = trimmed.split(" ");
  const command = parts[0];

  switch (command) {
    case "/post": {
      const room = parts[1];
      const json = parts.slice(2).join(" ");
      const data = JSON.parse(json);
      client.post(room, data);
      break;
    }
    case "/load": {
      const room = parts[1];
      const from = parseInt(parts[2]) || 0;
      client.load(room, from, (message) => {
        console.log(JSON.stringify(message, null, 2));
        rl.prompt();
      });
      break;
    }
    case "/watch": {
      const room = parts[1];
      client.watch(room, (message) => {
        console.log(JSON.stringify(message, null, 2));
        rl.prompt();
      });
      break;
    }
    case "/unwatch": {
      const room = parts[1];
      client.unwatch(room);
      break;
    }
  }

  rl.prompt();
});
