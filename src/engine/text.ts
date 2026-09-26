import type { Role, Utterance } from "../core/types.js";

/**
 * Normalize speech-to-text output so phrase rules are robust to punctuation,
 * casing and formatting differences between STT providers.
 *   "We're NOT affiliated w/ Medicare.gov!" -> "were not affiliated w medicare gov"
 * Apostrophes are dropped (so "i'm" -> "im"); every other symbol becomes a space.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Compile rule patterns once. Patterns are regex sources written against normalized text. */
export function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(`\\b(?:${p})\\b`, "g"));
}

interface Segment {
  utteranceId: number;
  from: number;
  to: number;
}

/**
 * A searchable stream of one speaker role's speech. Consecutive utterances are
 * joined so a disclosure split across two STT segments still matches.
 */
export class SpeechStream {
  text = "";
  private segments: Segment[] = [];

  append(u: Utterance): void {
    const norm = normalize(u.text);
    if (!norm) return;
    if (this.text) this.text += " ";
    const from = this.text.length;
    this.text += norm;
    this.segments.push({ utteranceId: u.id, from, to: this.text.length });
  }

  /** Utterance ids that overlap the character span [from, to). */
  utterancesFor(from: number, to: number): number[] {
    return this.segments.filter((s) => s.from < to && s.to > from).map((s) => s.utteranceId);
  }

  /** Character offset where the given utterance begins in the stream (for incremental scans). */
  offsetOf(utteranceId: number): number {
    return this.segments.find((s) => s.utteranceId === utteranceId)?.from ?? 0;
  }
}

export interface Match {
  utteranceIds: number[];
  matched: string;
  /** Up to six words preceding the match, used for negation detection. */
  before: string;
}

export function findMatches(stream: SpeechStream, regexes: RegExp[], fromOffset = 0): Match[] {
  const out: Match[] = [];
  for (const re of regexes) {
    re.lastIndex = fromOffset;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stream.text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const before = stream.text.slice(Math.max(0, start - 60), start).split(" ").slice(-6).join(" ");
      out.push({ utteranceIds: stream.utterancesFor(start, end), matched: m[0], before });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out;
}

const NEGATIONS = /\b(not|never|no|cant|cannot|wont|dont|doesnt|isnt|arent|wouldnt|couldnt|shouldnt)\b/;

/** True when a prohibited phrase is probably being negated ("I can't promise..."). */
export function looksNegated(before: string): boolean {
  return NEGATIONS.test(before);
}

export function roleMatches(role: Role, speaker: Role | "any" | undefined): boolean {
  const want = speaker ?? "agent";
  return want === "any" || role === want;
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
