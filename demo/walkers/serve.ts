// Serve the walkers demo statically on localhost (no local game server).
// The page connects to the official production server (wss). Usage:
//
//   bun run demo/walkers/serve.ts     # http://localhost:8080
//
// To develop against a local game server instead, run
// `bun run src/server.ts` and open http://localhost:8080/?local.

declare const Bun: any;

const ROOT = new URL(".", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8080);

const build = Bun.spawnSync({
  cmd: ["bun", "build", `${ROOT}index.ts`, "--outdir", `${ROOT}dist`, "--target=browser", "--format=esm"],
});
if (!build.success) {
  console.error("[SERVE] bundle build failed");
  process.exit(1);
}

Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${ROOT}${path.slice(1)}`);
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[SERVE] walkers demo at http://localhost:${PORT} (game server: production wss)`);
