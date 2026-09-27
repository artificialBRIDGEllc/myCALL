import WebSocket from "ws";
import type { Transcript } from "../core/types.js";
import { deepgramToRaw, finalize } from "./import.js";

/**
 * Deepgram speech-to-text. The API key only ever lives on the server; browsers
 * and the extension stream audio to our server, never to Deepgram directly.
 */
export interface DeepgramConfig {
  apiKey: string;
  model: string;
  language: string;
  baseUrl: string;
}

export function deepgramFromEnv(env: NodeJS.ProcessEnv = process.env): DeepgramConfig | null {
  if (!env.DEEPGRAM_API_KEY) return null;
  return {
    apiKey: env.DEEPGRAM_API_KEY,
    model: env.DEEPGRAM_MODEL || "nova-3",
    language: env.DEEPGRAM_LANGUAGE || "en-US",
    baseUrl: env.DEEPGRAM_BASE_URL || "https://api.deepgram.com",
  };
}

export class TranscriptionError extends Error {}

/**
 * Transcribe a recorded call.
 * separateChannels=true for stereo recordings with one party per channel
 * (most dialers/softphones can export this): speaker separation is then exact.
 * Otherwise speakers are separated by diarization.
 */
export async function transcribeRecording(
  cfg: DeepgramConfig,
  audio: Buffer,
  mimeType: string,
  separateChannels: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<Transcript> {
  const params = new URLSearchParams({
    model: cfg.model,
    language: cfg.language,
    smart_format: "true",
    punctuate: "true",
    utterances: "true",
    utt_split: "1.0",
  });
  if (separateChannels) params.set("multichannel", "true");
  else params.set("diarize", "true");

  const res = await fetchImpl(`${cfg.baseUrl}/v1/listen?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${cfg.apiKey}`, "Content-Type": mimeType || "application/octet-stream" },
    body: new Uint8Array(audio),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new TranscriptionError(`Deepgram returned ${res.status}: ${detail}`);
  }
  const json = await res.json();
  return finalize(deepgramToRaw(json), "deepgram");
}

/** Read the channel count from a WAV header (null if not a WAV file). */
export function wavChannels(buf: Buffer): number | null {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  return buf.readUInt16LE(22);
}

// ---------------------------------------------------------------------------
// Live streaming
// ---------------------------------------------------------------------------

export interface LiveSegment {
  channel: number;
  start: number;
  end: number;
  text: string;
  confidence?: number;
}

export interface LiveCallbacks {
  onUtterance(seg: LiveSegment): void;
  onInterim(channel: number, text: string): void;
  onError(err: Error): void;
}

export interface LiveTranscriber {
  send(pcm: Buffer): void;
  /** Flush remaining speech and close. Resolves when the provider is done. */
  finish(): Promise<void>;
}

interface DeepgramResult {
  type: string;
  channel_index?: number[];
  channel?: { alternatives?: Array<{ transcript: string; confidence?: number }> } | number[];
  start?: number;
  duration?: number;
  is_final?: boolean;
  speech_final?: boolean;
}

/**
 * Accumulates Deepgram's streaming "is_final" fragments into whole utterances
 * per channel. Exported separately so it can be unit-tested without a socket.
 */
export class SegmentAssembler {
  private pending = new Map<number, LiveSegment & { confSum: number; n: number }>();
  constructor(private cb: Pick<LiveCallbacks, "onUtterance" | "onInterim">) {}

  handle(msg: DeepgramResult): void {
    if (msg.type === "UtteranceEnd") {
      const ch = Array.isArray(msg.channel) ? msg.channel[0] : undefined;
      if (ch === undefined) this.flushAll();
      else this.flush(ch);
      return;
    }
    if (msg.type !== "Results") return;
    const channel = msg.channel_index?.[0] ?? 0;
    const alt = !Array.isArray(msg.channel) ? msg.channel?.alternatives?.[0] : undefined;
    const text = alt?.transcript?.trim() ?? "";
    if (!msg.is_final) {
      if (text) this.cb.onInterim(channel, [this.pending.get(channel)?.text, text].filter(Boolean).join(" "));
      return;
    }
    if (text) {
      const start = msg.start ?? 0;
      const end = start + (msg.duration ?? 0);
      const p = this.pending.get(channel);
      if (p) {
        p.text += ` ${text}`;
        p.end = end;
        p.confSum += alt?.confidence ?? 0;
        p.n++;
      } else this.pending.set(channel, { channel, start, end, text, confSum: alt?.confidence ?? 0, n: 1 });
    }
    if (msg.speech_final) this.flush(channel);
  }

  flushAll(): void {
    for (const ch of [...this.pending.keys()]) this.flush(ch);
  }

  private flush(channel: number): void {
    const p = this.pending.get(channel);
    if (!p) return;
    this.pending.delete(channel);
    this.cb.onUtterance({ channel, start: p.start, end: p.end, text: p.text, confidence: p.n ? p.confSum / p.n : undefined });
  }
}

/**
 * After CloseStream, Deepgram sends the transcripts for any audio it hasn't
 * finished yet, then closes. Wait this long for that before giving up: cutting
 * it short silently drops the end of the call (seen with a real key at 5 s).
 */
export const LIVE_FINISH_TIMEOUT_MS = 30_000;

export function openDeepgramLive(
  cfg: DeepgramConfig,
  opts: { sampleRate: number; channels: number },
  cb: LiveCallbacks,
): Promise<LiveTranscriber> {
  const params = new URLSearchParams({
    model: cfg.model,
    language: cfg.language,
    encoding: "linear16",
    sample_rate: String(opts.sampleRate),
    channels: String(opts.channels),
    multichannel: opts.channels > 1 ? "true" : "false",
    interim_results: "true",
    punctuate: "true",
    smart_format: "true",
    endpointing: "300",
    utterance_end_ms: "1200",
  });
  const url = `${cfg.baseUrl.replace(/^http/, "ws")}/v1/listen?${params}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${cfg.apiKey}` } });
  const assembler = new SegmentAssembler(cb);
  let keepAlive: NodeJS.Timeout | undefined;

  return new Promise((resolve, reject) => {
    const closed = new Promise<void>((done) => ws.once("close", () => done()));
    ws.once("open", () => {
      keepAlive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "KeepAlive" })), 8000);
      resolve({
        send(pcm) {
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
        },
        async finish() {
          clearInterval(keepAlive);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
          const timeout = new Promise<void>((done) => setTimeout(done, LIVE_FINISH_TIMEOUT_MS));
          await Promise.race([closed, timeout]);
          assembler.flushAll();
          if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
        },
      });
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        assembler.handle(JSON.parse(data.toString()) as DeepgramResult);
      } catch (err) {
        cb.onError(err as Error);
      }
    });
    ws.once("unexpected-response", (_req, res) => {
      reject(new TranscriptionError(`Deepgram live connection refused (${res.statusCode}). Check DEEPGRAM_API_KEY.`));
    });
    ws.on("error", (err) => {
      clearInterval(keepAlive);
      if (ws.readyState === WebSocket.CONNECTING) reject(err);
      else cb.onError(err);
    });
  });
}
