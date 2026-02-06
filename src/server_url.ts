export const OFFICIAL_SERVER_URL = "wss://net.studiovibi.com";

export function walkers_server_for_host(hostname: string): string | undefined {
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `ws://${hostname}:8080`;
  }
  return undefined;
}

export function normalize_ws_url(raw_url: string): string {
  let ws_url = raw_url;

  try {
    const url = new URL(raw_url);
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    }
    ws_url = url.toString();
  } catch {
    ws_url = raw_url;
  }

  if (
    typeof window !== "undefined" &&
    window.location.protocol === "https:" &&
    ws_url.startsWith("ws://")
  ) {
    const upgraded = `wss://${ws_url.slice("ws://".length)}`;
    console.warn(
      `[VibiNet] Upgrading insecure WebSocket URL "${ws_url}" to "${upgraded}" because the page is HTTPS.`
    );
    return upgraded;
  }

  return ws_url;
}
