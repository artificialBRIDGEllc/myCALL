import type { Role, Utterance } from "../core/types.js";
import { normalize } from "../engine/text.js";

/** Phrases agents say far more often than callers. Used to decide which speaker is the agent. */
const AGENT_SIGNALS = [
  /\blicensed\b/,
  /\bmy name is\b/,
  /\bthis call (is|may be) (being )?recorded\b/,
  /\bdo not offer every plan\b|\bdont offer every plan\b/,
  /\bscope of (the )?appointment\b/,
  /\bhow (can|may) i help\b/,
  /\bthank you for calling\b|\bthanks for calling\b/,
  /\bwe represent\b/,
  /\blet me (check|look|pull|see)\b/,
  /\bin network\b/,
  /\bdeductible\b|\bcopay\b|\bout of pocket\b/,
];

/**
 * Guess which raw speaker label is the agent: whoever scores highest on agent
 * phrases (ties -> whoever talks more; agents usually talk more on sales calls).
 * Every other speaker is labeled customer. Reviewers can swap sides in the UI.
 */
export function inferRoleMap(utterances: Array<Pick<Utterance, "speaker" | "text" | "start" | "end">>): Record<string, Role> {
  const stats = new Map<string, { signals: number; talk: number }>();
  for (const u of utterances) {
    const s = stats.get(u.speaker) ?? { signals: 0, talk: 0 };
    const t = normalize(u.text);
    s.signals += AGENT_SIGNALS.filter((re) => re.test(t)).length;
    s.talk += Math.max(0, u.end - u.start);
    stats.set(u.speaker, s);
  }
  const ranked = [...stats.entries()].sort((a, b) => b[1].signals - a[1].signals || b[1].talk - a[1].talk);
  const map: Record<string, Role> = {};
  ranked.forEach(([speaker], i) => (map[speaker] = i === 0 ? "agent" : "customer"));
  return map;
}

export function applyRoleMap<T extends Utterance>(utterances: T[], map: Record<string, Role>): T[] {
  return utterances.map((u) => ({ ...u, role: map[u.speaker] ?? "unknown" }));
}

/** Swap agent <-> customer for every speaker (used when auto-detection guessed wrong). */
export function swapRoles(map: Record<string, Role>): Record<string, Role> {
  const out: Record<string, Role> = {};
  for (const [k, v] of Object.entries(map)) out[k] = v === "agent" ? "customer" : v === "customer" ? "agent" : v;
  return out;
}
