# Walkers - Multiplayer Browser Game

A simple multiplayer game demo built with VibiNet. Players control walkers (single-letter avatars) that move around a 2D space.

## Project Structure

```
walkers/
├── index.ts          # Game logic + bootstrap (no JS in HTML)
├── index.html        # Game UI with canvas (no inline JS)
├── dist/             # Compiled JavaScript files (built automatically)
│   ├── client.js
│   ├── vibi.js
│   └── index.js
└── README.md         # This file
```

The game imports `src/vibi.ts` and `src/client.ts` from the parent directory, keeping the code DRY and organized.

## How to Play

### 1. Start the WebSocket Server

From the root directory:
```bash
bun run server
```

The unified server builds the browser bundle automatically and serves the game UI.

### 2. Open the Game

Open http://localhost:8080 in your browser. You'll be prompted for:
- Room name (auto-generated if left blank)
- Your nickname (must be a single character)

### 5. Controls

- **W** - Move up
- **A** - Move left
- **S** - Move down
- **D** - Move right

## How It Works

- Each player spawns at a fixed position (200,200)
- Movement speed: 200 pixels/second
- Game runs at 24 ticks/second
- Players are synchronized across all clients using VibiNet
- All clients compute the same deterministic game state

## Technical Details

- **State**: Map of character → player position and key states
- **on_tick**: Updates positions based on WASD states
- **on_post**: Handles spawn and key up/down events
- **Tolerance**: 300ms for network lag compensation

Open multiple browser windows/tabs with the same room name to see multiplayer in action!
