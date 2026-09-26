import type { LiveClientMessage, LiveServerMessage } from "../core/types.js";

/**
 * WebSocket client for /api/live. Audio is only sent after the server says
 * "ready", so the saved recording and the transcript timestamps line up.
 * Browsers can't put headers on a WebSocket, so the access token is exchanged
 * for a 60-second signed URL first; the token itself never appears in a URL.
 */
export class LiveClient {
  private ready = false;

  private constructor(
    private ws: WebSocket,
    start: Extract<LiveClientMessage, { type: "start" }>,
    private onMessage: (m: LiveServerMessage) => void,
    onClose: () => void,
  ) {
    ws.binaryType = "arraybuffer";
    ws.onopen = () => ws.send(JSON.stringify(start));
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const msg = JSON.parse(e.data) as LiveServerMessage;
      if (msg.type === "ready") this.ready = true;
      this.onMessage(msg);
    };
    ws.onerror = () => this.onMessage({ type: "error", message: "Lost connection to the myCALL server." });
    ws.onclose = onClose;
  }

  static async open(
    serverUrl: string,
    token: string | null,
    start: Extract<LiveClientMessage, { type: "start" }>,
    onMessage: (m: LiveServerMessage) => void,
    onClose: () => void,
  ): Promise<LiveClient> {
    let path = "/api/live";
    if (token) {
      const res = await fetch(new URL("/api/sign", serverUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) throw new Error(res.status === 401 ? "The access token was rejected." : `Couldn't start the call (server replied ${res.status}).`);
      path = ((await res.json()) as { url: string }).url;
    }
    const url = new URL(path, serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new LiveClient(new WebSocket(url), start, onMessage, onClose);
  }

  sendAudio(pcm: ArrayBuffer): void {
    // Audio before "ready" is dropped: the server's call clock starts at ready.
    if (this.ready && this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm);
  }

  stop(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "stop" } satisfies LiveClientMessage));
  }

  close(): void {
    this.ws.close();
  }
}
