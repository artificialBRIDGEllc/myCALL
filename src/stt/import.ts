import type { Role, Transcript, Utterance } from "../core/types.js";
import { applyRoleMap, inferRoleMap } from "./roles.js";

/**
 * Import an existing transcript so calls can be scored without re-transcribing.
 * Supported:
 *  - WebVTT / SRT captions (Zoom, Teams, Meet exports) with "Name: text" or <v Name> speakers
 *  - Deepgram JSON (prerecorded response)
 *  - Plain text: one turn per line, "Speaker: text" with optional [mm:ss] timestamps
 */
export function importTranscript(content: string, filename = ""): Transcript {
  const trimmed = content.trim();
  if (!trimmed) throw new ImportError("The transcript is empty.");
  const lower = filename.toLowerCase();
  let raw: RawUtterance[];
  if (lower.endsWith(".json") || trimmed.startsWith("{")) raw = parseDeepgramJson(trimmed);
  else if (trimmed.startsWith("WEBVTT") || lower.endsWith(".vtt") || lower.endsWith(".srt") || /-->/.test(trimmed)) raw = parseCaptions(trimmed);
  else raw = parsePlainText(trimmed);
  if (!raw.length) throw new ImportError("No speech found in the transcript.");
  return finalize(raw, "import");
}

export class ImportError extends Error {}

export interface RawUtterance {
  start: number;
  end: number;
  speaker: string;
  text: string;
  confidence?: number;
  /** Explicit role when the source says so ("Agent:", "Customer:"). */
  role?: Role;
}

export function finalize(raw: RawUtterance[], source: Transcript["source"]): Transcript {
  const sorted = raw.filter((r) => r.text.trim()).sort((a, b) => a.start - b.start);
  const base: Utterance[] = sorted.map((r, id) => ({
    id,
    start: round(r.start),
    end: round(Math.max(r.end, r.start)),
    speaker: r.speaker,
    role: "unknown",
    text: r.text.trim(),
    confidence: r.confidence,
  }));
  const explicit: Record<string, Role> = {};
  for (const r of sorted) if (r.role && r.role !== "unknown") explicit[r.speaker] = r.role;
  const inferred = inferRoleMap(base);
  const roleMap = { ...inferred, ...explicit };
  // If explicit labels claimed only one side, everyone else is the other side.
  const explicitRoles = new Set(Object.values(explicit));
  if (explicitRoles.size === 1) {
    const other: Role = explicitRoles.has("agent") ? "customer" : "agent";
    for (const k of Object.keys(roleMap)) if (!(k in explicit)) roleMap[k] = other;
  }
  const utterances = applyRoleMap(base, roleMap);
  return { utterances, durationSec: round(utterances.at(-1)?.end ?? 0), source, roleMap };
}

const round = (n: number) => Math.round(n * 100) / 100;

const AGENT_NAMES = /^(agent|rep|representative|advisor|broker|sales ?rep|csr|me)$/i;
const CUSTOMER_NAMES = /^(customer|caller|client|beneficiary|prospect|lead|member|patient)$/i;

function roleFromName(name: string): Role | undefined {
  if (AGENT_NAMES.test(name.trim())) return "agent";
  if (CUSTOMER_NAMES.test(name.trim())) return "customer";
  return undefined;
}

function parseTimestamp(ts: string): number {
  const parts = ts.trim().replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + (Number.isFinite(p) ? p : 0), 0);
}

function parseCaptions(text: string): RawUtterance[] {
  const out: RawUtterance[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  let lastSpeaker = "Speaker 1";
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx < 0) continue;
    const [a, b] = lines[timeIdx]!.split("-->");
    const start = parseTimestamp(a!.split(" ")[0]!);
    const end = parseTimestamp(b!.trim().split(" ")[0]!);
    let body = lines.slice(timeIdx + 1).join(" ").trim();
    let speaker = lastSpeaker;
    const voice = body.match(/^<v(?:\.[^ >]*)? ([^>]+)>/);
    if (voice) {
      speaker = voice[1]!.trim();
      body = body.replace(/<[^>]+>/g, "").trim();
    } else {
      const named = body.match(/^([A-Za-z][\w .'-]{0,40}):\s+(.*)$/);
      if (named) {
        speaker = named[1]!.trim();
        body = named[2]!;
      }
    }
    lastSpeaker = speaker;
    if (body) out.push({ start, end, speaker, text: body, role: roleFromName(speaker) });
  }
  return mergeRuns(out);
}

function parsePlainText(text: string): RawUtterance[] {
  const out: RawUtterance[] = [];
  let clock = 0;
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const l = line.trim();
    if (!l) continue;
    const m = l.match(/^(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*)?([A-Za-z][\w .'-]{0,40}?)\s*(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?)?\s*:\s+(.+)$/);
    if (!m) {
      // Continuation of the previous speaker's turn.
      const prev = out.at(-1);
      if (prev) {
        prev.text += ` ${l}`;
        prev.end += estimate(l);
        clock = prev.end;
      }
      continue;
    }
    const ts = m[1] ?? m[3];
    const speaker = m[2]!.trim();
    const body = m[4]!.trim();
    const start = ts ? parseTimestamp(ts) : clock;
    const end = start + estimate(body);
    out.push({ start, end, speaker, text: body, role: roleFromName(speaker) });
    clock = end + 0.3;
  }
  // Fix ends that overlap the next line's explicit timestamp.
  for (let i = 0; i < out.length - 1; i++) if (out[i]!.end > out[i + 1]!.start) out[i]!.end = out[i + 1]!.start;
  return out;
}

/** ~2.6 words/second is typical conversational speech. */
function estimate(text: string): number {
  return Math.max(0.8, text.split(/\s+/).length / 2.6);
}

function mergeRuns(items: RawUtterance[]): RawUtterance[] {
  const out: RawUtterance[] = [];
  for (const it of items) {
    const prev = out.at(-1);
    if (prev && prev.speaker === it.speaker && it.start - prev.end < 1.0 && prev.text.length < 400) {
      prev.text += ` ${it.text}`;
      prev.end = it.end;
    } else out.push({ ...it });
  }
  return out;
}

interface DeepgramUtterance {
  start: number;
  end: number;
  transcript: string;
  speaker?: number;
  channel?: number;
  confidence?: number;
}

function parseDeepgramJson(text: string): RawUtterance[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ImportError("The JSON transcript could not be parsed.");
  }
  return deepgramToRaw(json);
}

/** Convert a Deepgram prerecorded response (with utterances=true) into raw utterances. */
export function deepgramToRaw(json: unknown): RawUtterance[] {
  const results = (json as { results?: { utterances?: DeepgramUtterance[]; channels?: unknown[] } }).results;
  const utts = results?.utterances;
  if (!Array.isArray(utts)) throw new ImportError("Unrecognized JSON: expected a Deepgram response with results.utterances.");
  const multichannel = (results?.channels?.length ?? 1) > 1;
  return utts.map((u) => ({
    start: u.start,
    end: u.end,
    // Stereo recordings: one side per channel (perfect separation). Mono: diarized speaker.
    speaker: multichannel ? `ch${u.channel ?? 0}` : String(u.speaker ?? 0),
    text: u.transcript,
    confidence: u.confidence,
  }));
}
