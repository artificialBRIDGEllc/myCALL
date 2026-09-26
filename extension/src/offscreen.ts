import { startCapture, type CaptureHandle } from "../../src/capture/capture.js";
import { LiveClient } from "../../src/capture/live-client.js";
import type { ExtMessage } from "./shared.js";

/**
 * Offscreen document: holds the MediaStreams (tab + mic), mixes them onto two
 * channels, and streams PCM to the myCALL server. Results are relayed to the
 * service worker, which owns the call state shown in the popup.
 */
let capture: CaptureHandle | null = null;
let client: LiveClient | null = null;

const toWorker = (m: ExtMessage) => chrome.runtime.sendMessage(m).catch(() => undefined);

async function start(msg: Extract<ExtMessage, { to: "offscreen"; type: "start" }>): Promise<void> {
  const { settings, streamId, title } = msg;
  const call = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } as unknown as MediaTrackConstraints,
    video: false,
  });
  let mic: MediaStream | null = null;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    toWorker({ to: "worker", type: "live", payload: { type: "error", message: "Microphone not allowed — open the extension's Setup page and allow the microphone. Scoring the caller side only." } });
  }
  client = new LiveClient(
    settings.serverUrl,
    settings.token || null,
    { type: "start", rubricId: settings.rubricId, agentName: settings.agentName || undefined, title, sampleRate: 16000, channels: 2 },
    (payload) => {
      toWorker({ to: "worker", type: "live", payload });
      if (payload.type === "scoring") void stopCapture();
    },
    () => {
      void stopCapture();
      toWorker({ to: "worker", type: "closed" });
    },
  );
  const lc = client;
  // Tab capture mutes the tab for the user, so play the call audio back through the speakers.
  capture = await startCapture({ mic, call }, "pcm-worklet.js", (pcm) => lc.sendAudio(pcm), { playCallAudio: true });
}

async function stopCapture(): Promise<void> {
  const c = capture;
  capture = null;
  await c?.stop();
}

chrome.runtime.onMessage.addListener((msg: ExtMessage) => {
  if (msg.to !== "offscreen") return false;
  if (msg.type === "start") {
    start(msg).catch((err: Error) => {
      toWorker({ to: "worker", type: "live", payload: { type: "error", message: err.message } });
      toWorker({ to: "worker", type: "closed" });
    });
  } else if (msg.type === "stop") client?.stop();
  return false;
});
