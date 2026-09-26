import type { CallMetrics, Utterance } from "../core/types.js";

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Conversation analytics computed directly from timestamps — no AI, always available. */
export function computeMetrics(utterances: Utterance[], durationSec: number): CallMetrics {
  const duration = Math.max(durationSec, utterances.at(-1)?.end ?? 0, 1);
  let agentTalk = 0;
  let customerTalk = 0;
  let agentWords = 0;
  let agentQuestions = 0;
  let interruptions = 0;
  let longest = 0;
  let runStart: number | null = null;
  let runEnd = 0;

  const sorted = [...utterances].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const u = sorted[i]!;
    const len = Math.max(0, u.end - u.start);
    if (u.role === "agent") {
      agentTalk += len;
      agentWords += u.text.split(/\s+/).filter(Boolean).length;
      agentQuestions += (u.text.match(/\?/g) ?? []).length;
      if (runStart !== null && u.start - runEnd < 1.5) runEnd = u.end;
      else {
        runStart = u.start;
        runEnd = u.end;
      }
      longest = Math.max(longest, runEnd - runStart);
    } else {
      if (u.role === "customer") customerTalk += len;
      runStart = null;
    }
    // Interruption: this speaker starts while the other side is still talking.
    const prev = sorted[i - 1];
    if (prev && prev.role !== u.role && u.start < prev.end - 0.3) interruptions++;
  }

  const speech = unionLength(sorted.map((u) => [u.start, u.end] as const));
  const talkTotal = agentTalk + customerTalk || 1;
  return {
    durationSec: round1(duration),
    agentTalkPct: round1((agentTalk / talkTotal) * 100),
    customerTalkPct: round1((customerTalk / talkTotal) * 100),
    silencePct: round1(Math.max(0, (1 - speech / duration) * 100)),
    agentWordsPerMinute: agentTalk > 0 ? Math.round(agentWords / (agentTalk / 60)) : 0,
    agentQuestions,
    longestAgentMonologueSec: round1(longest),
    interruptions,
  };
}

function unionLength(intervals: ReadonlyArray<readonly [number, number]>): number {
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else curEnd = Math.max(curEnd, e);
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}
