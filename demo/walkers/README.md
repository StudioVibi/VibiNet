# Walkers - Multiplayer Browser Game

A simple multiplayer game demo built with VibiNet. Players control walkers (single-letter avatars) that move around a 2D space.

## Project Structure

```
demo/walkers/
├── index.ts          # Game logic + bootstrap (no JS in HTML)
├── index.html        # Game UI with canvas (no inline JS)
├── serve.ts          # Local static server (connects to production)
├── dist/             # Compiled bundle (built automatically)
└── README.md         # This file
```

The game imports `src/client.ts` from the repo root, keeping the code DRY and organized.

## How to Play

Either open the hosted demo at https://net.studiovibi.com, or serve it
locally (still playing on the production server):

```bash
bun run demo/walkers/serve.ts   # then open http://localhost:8080
```

To develop against a local game server instead, run `bun run server` from
the repo root and open http://localhost:8080/?local.

You'll be prompted for:
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
