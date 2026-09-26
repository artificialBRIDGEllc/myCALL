import type { LiveClientMessage, LiveServerMessage } from "../core/types.js";

/**
 * WebSocket client for /api/live. Audio is only sent after the server says
 * "ready", so the saved recording and the transcript timestamps line up.
 */
export class LiveClient {
  private ws: WebSocket;
  private ready = false;

  constructor(
    serverUrl: string,
    token: string | null,
    start: Extract<LiveClientMessage, { type: "start" }>,
    private onMessage: (m: LiveServerMessage) => void,
    onClose: () => void,
  ) {
    const url = new URL("/api/live", serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (token) url.searchParams.set("token", token);
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => this.ws.send(JSON.stringify(start));
    this.ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const msg = JSON.parse(e.data) as LiveServerMessage;
      if (msg.type === "ready") {
        this.ready = true;
      }
      this.onMessage(msg);
    };
    this.ws.onerror = () => this.onMessage({ type: "error", message: "Lost connection to the myCALL server." });
    this.ws.onclose = onClose;
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
