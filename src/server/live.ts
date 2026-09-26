import { randomUUID } from "node:crypto";
import path from "node:path";
import type { WebSocket } from "ws";
import type { LiveClientMessage, LiveServerMessage, Role, Transcript, Utterance } from "../core/types.js";
import { LiveSession } from "../engine/live.js";
import { scoreCall } from "../engine/score.js";
import { sampleUtterances } from "../rubrics/sample-call.js";
import { openDeepgramLive, type LiveTranscriber } from "../stt/deepgram.js";
import type { AppConfig } from "./config.js";
import type { Store } from "./db.js";
import type { Pipeline } from "./pipeline.js";
import { WavWriter } from "./wav.js";

/**
 * One live call over a WebSocket.
 *
 * Protocol: the browser sends a JSON {type:"start"} message, then binary
 * frames of 16-bit little-endian PCM, interleaved stereo: channel 0 = the
 * agent's microphone, channel 1 = the call audio from the browser tab (the
 * customer). Separate channels give perfect speaker separation — no
 * diarization guesswork. {type:"stop"} (or closing the socket) ends the call;
 * the server then runs full scoring (rules + AI) and replies {type:"final"}.
 */
const CHANNEL_ROLES: Role[] = ["agent", "customer"];

export function handleLiveSocket(socket: WebSocket, deps: { store: Store; pipeline: Pipeline; config: AppConfig }): void {
  const { store, pipeline, config } = deps;
  let session: LiveSession | null = null;
  let callId: string | null = null;
  let stt: LiveTranscriber | null = null;
  let wav: WavWriter | null = null;
  let clock: NodeJS.Timeout | null = null;
  let demoTimers: NodeJS.Timeout[] = [];
  let startedAt = 0;
  let nextId = 0;
  let finished = false;
  let rubricId = "";
  let source: "live" | "demo" = "live";

  const send = (msg: LiveServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };

  const pushSnapshot = () => {
    if (!session) return;
    send({ type: "checklist", items: session.checklist(), provisionalScore: session.provisionalScore(), metrics: session.metrics(), elapsed: session.elapsedSec });
  };

  const addUtterance = (u: Utterance) => {
    if (!session) return;
    send({ type: "utterance", utterance: u });
    for (const alert of session.addUtterance(u)) send({ type: "alert", alert });
    pushSnapshot();
  };

  const elapsed = () => ((Date.now() - startedAt) / 1000) * (source === "demo" ? config.demoSpeed : 1);

  const start = async (msg: Extract<LiveClientMessage, { type: "start" }>) => {
    const rubric = pipeline.rubric(msg.rubricId);
    if (!rubric) return send({ type: "error", message: `Unknown rubric "${msg.rubricId}".` });
    rubricId = rubric.id;
    source = msg.demo ? "demo" : "live";
    if (!msg.demo && !config.deepgram) {
      return send({ type: "error", message: "Live transcription needs DEEPGRAM_API_KEY on the server. Try the demo call to see how it works." });
    }
    if (!msg.demo && (msg.sampleRate < 8000 || msg.sampleRate > 48000 || (msg.channels !== 1 && msg.channels !== 2))) {
      return send({ type: "error", message: "Unsupported audio format." });
    }

    callId = randomUUID();
    session = new LiveSession(rubric);
    const title = msg.title?.trim() || (msg.demo ? "Demo call" : `Live call ${new Date().toLocaleString("en-US")}`);
    store.createCall({ id: callId, title, agentName: msg.agentName?.trim() || null, source, rubricId: rubric.id });

    if (msg.demo) {
      startedAt = Date.now();
      for (const u of sampleUtterances) {
        demoTimers.push(setTimeout(() => {
          send({ type: "interim", role: u.role, text: u.text.split(" ").slice(0, Math.ceil(u.text.split(" ").length / 2)).join(" ") });
        }, ((u.start + (u.end - u.start) / 2) / config.demoSpeed) * 1000));
        demoTimers.push(setTimeout(() => addUtterance({ ...u }), (u.end / config.demoSpeed) * 1000));
      }
      const last = sampleUtterances.at(-1)!;
      demoTimers.push(setTimeout(() => void finish(), ((last.end + 1.5) / config.demoSpeed) * 1000));
    } else {
      const audioPath = path.join(store.audioDir, `${callId}.wav`);
      wav = new WavWriter(audioPath, msg.sampleRate, msg.channels);
      store.setAudio(callId, audioPath, "audio/wav");
      try {
        stt = await openDeepgramLive(config.deepgram!, { sampleRate: msg.sampleRate, channels: msg.channels }, {
          onUtterance: (seg) => {
            const role = msg.channels === 2 ? (CHANNEL_ROLES[seg.channel] ?? "unknown") : "agent";
            addUtterance({ id: nextId++, start: seg.start, end: seg.end, speaker: `ch${seg.channel}`, role, text: seg.text, confidence: seg.confidence });
          },
          onInterim: (channel, text) => send({ type: "interim", role: msg.channels === 2 ? (CHANNEL_ROLES[channel] ?? "unknown") : "agent", text }),
          onError: (err) => send({ type: "error", message: `Transcription error: ${err.message}` }),
        });
      } catch (err) {
        wav.close();
        store.saveError(callId, (err as Error).message);
        send({ type: "error", message: (err as Error).message });
        finished = true;
        cleanup();
        socket.close(1011, "transcriber unavailable");
        return;
      }
      startedAt = Date.now();
    }

    clock = setInterval(() => {
      if (!session) return;
      for (const alert of session.tick(elapsed())) send({ type: "alert", alert });
      pushSnapshot();
    }, 1000);
    send({ type: "ready", callId, demo: Boolean(msg.demo) });
    pushSnapshot();
  };

  const cleanup = () => {
    if (clock) clearInterval(clock);
    demoTimers.forEach(clearTimeout);
    demoTimers = [];
    clock = null;
  };

  const finish = async () => {
    if (finished || !session || !callId) return;
    finished = true;
    cleanup();
    if (stt) await stt.finish().catch(() => undefined);
    const duration = Math.max(wav?.durationSec ?? 0, session.elapsedSec, elapsed());
    wav?.close();
    const channels = new Set(session.utterances.map((u) => u.speaker));
    const roleMap: Record<string, Role> = {};
    for (const u of session.utterances) roleMap[u.speaker] = u.role;
    const transcript: Transcript = {
      utterances: [...session.utterances].sort((a, b) => a.start - b.start),
      durationSec: Math.round(duration * 100) / 100,
      source,
      roleMap: channels.size ? roleMap : {},
    };
    store.saveTranscript(callId, transcript);
    send({ type: "scoring" });
    try {
      const result = await scoreCall({ rubric: pipeline.rubric(rubricId)!, transcript, reviewer: config.reviewer });
      store.saveResult(callId, result);
      send({ type: "final", callId, result });
    } catch (err) {
      store.saveError(callId, (err as Error).message);
      send({ type: "error", message: (err as Error).message });
    }
    if (socket.readyState === socket.OPEN) socket.close(1000, "done");
  };

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!session || finished || source === "demo") return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      wav?.write(buf);
      stt?.send(buf);
      return;
    }
    let msg: LiveClientMessage;
    try {
      msg = JSON.parse(data.toString()) as LiveClientMessage;
    } catch {
      return send({ type: "error", message: "Invalid message." });
    }
    if (msg.type === "start" && !session) void start(msg);
    else if (msg.type === "stop") void finish();
  });

  socket.on("close", () => {
    if (!finished && session) void finish();
    else cleanup();
  });
}
