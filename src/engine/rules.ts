import type { Criterion, Evidence, Role, Rubric, Utterance } from "../core/types.js";
import { compilePatterns, findMatches, looksNegated, roleMatches, SpeechStream, type Match } from "./text.js";

/**
 * Deterministic phrase-rule engine. The same class scores a recorded call
 * (feed every utterance, then read findings) and a live call (feed utterances
 * as they are finalized, call tick() every second, stream the events).
 * No network, no AI, no cost — so it is safe to run on every word, live.
 */

export interface RuleFinding {
  criterionId: string;
  /** Required: evidence the item was said. Prohibited: the violations. */
  evidence: Evidence[];
  componentsFound: string[];
  componentsTotal: number;
  /** Required: fully satisfied inside its time window. */
  satisfied: boolean;
  /** Required: satisfied, but only after withinSeconds elapsed. */
  late: boolean;
  /** Required with a time window that has already elapsed without success. */
  overdue: boolean;
  /** Prohibited: at least one hit that does not look negated. */
  violated: boolean;
  /** Prohibited: hits exist but every one looks negated ("I can't promise..."). */
  negatedOnly: boolean;
}

export type RuleEvent =
  | { kind: "violation"; criterionId: string; evidence: Evidence; negated: boolean }
  | { kind: "component"; criterionId: string; componentId: string; evidence: Evidence }
  | { kind: "satisfied"; criterionId: string; late: boolean }
  | { kind: "overdue"; criterionId: string };

interface CompiledCriterion {
  c: Criterion;
  patterns: RegExp[];
  components: { id: string; patterns: RegExp[] }[];
}

interface State {
  finding: RuleFinding;
  /** Dedup key for prohibited hits. */
  seen: Set<string>;
  lateComponents: Set<string>;
}

export class RuleEngine {
  private streams: Record<Role | "any", SpeechStream> = {
    agent: new SpeechStream(),
    customer: new SpeechStream(),
    unknown: new SpeechStream(),
    any: new SpeechStream(),
  };
  private utterances = new Map<number, Utterance>();
  private compiled: CompiledCriterion[];
  private state = new Map<string, State>();

  constructor(readonly rubric: Rubric) {
    this.compiled = rubric.criteria
      .filter((c) => c.evaluator !== "llm" && c.kind !== "judgment")
      .map((c) => ({
        c,
        patterns: compilePatterns(c.patterns ?? []),
        components: (c.components ?? []).map((k) => ({ id: k.id, patterns: compilePatterns(k.patterns) })),
      }));
    for (const { c } of this.compiled) {
      this.state.set(c.id, {
        finding: {
          criterionId: c.id,
          evidence: [],
          componentsFound: [],
          componentsTotal: c.components?.length ?? 0,
          satisfied: false,
          late: false,
          overdue: false,
          violated: false,
          negatedOnly: false,
        },
        seen: new Set(),
        lateComponents: new Set(),
      });
    }
  }

  /** Criteria this engine can evaluate (everything except pure AI judgment). */
  get criterionIds(): string[] {
    return this.compiled.map((x) => x.c.id);
  }

  addUtterance(u: Utterance): RuleEvent[] {
    this.utterances.set(u.id, u);
    const prevOffset: Partial<Record<Role | "any", number>> = {};
    for (const key of ["any", u.role] as const) {
      const s = this.streams[key];
      // Re-scan from the start of the previous utterance so phrases that span
      // an STT segment boundary are caught exactly once.
      prevOffset[key] = Math.max(0, s.text.length - 200);
      s.append(u);
    }

    const events: RuleEvent[] = [];
    for (const cc of this.compiled) {
      const speaker = cc.c.speaker ?? "agent";
      if (!roleMatches(u.role, speaker)) continue;
      const streamKey = speaker === "any" ? "any" : speaker;
      const stream = this.streams[streamKey];
      if (cc.c.kind === "prohibited") events.push(...this.scanProhibited(cc, stream, prevOffset[streamKey] ?? 0));
      else events.push(...this.scanRequired(cc, stream));
    }
    return events;
  }

  /** Advance the clock (live calls). Emits "overdue" once per time-boxed requirement. */
  tick(elapsedSec: number): RuleEvent[] {
    const events: RuleEvent[] = [];
    for (const { c } of this.compiled) {
      if (c.kind !== "required" || c.withinSeconds === undefined) continue;
      const st = this.state.get(c.id)!;
      if (!st.finding.satisfied && !st.finding.overdue && elapsedSec > c.withinSeconds) {
        st.finding.overdue = true;
        events.push({ kind: "overdue", criterionId: c.id });
      }
    }
    return events;
  }

  findings(): RuleFinding[] {
    return [...this.state.values()].map((s) => ({
      ...s.finding,
      evidence: [...s.finding.evidence],
      componentsFound: [...s.finding.componentsFound],
    }));
  }

  finding(criterionId: string): RuleFinding | undefined {
    return this.state.get(criterionId)?.finding;
  }

  private evidenceFor(m: Match, componentId?: string): Evidence | null {
    const ids = m.utteranceIds;
    const first = ids.length ? this.utterances.get(ids[0]!) : undefined;
    const last = ids.length ? this.utterances.get(ids[ids.length - 1]!) : undefined;
    if (!first || !last) return null;
    const quote = ids
      .map((id) => this.utterances.get(id)?.text ?? "")
      .join(" ")
      .trim();
    return { utteranceId: first.id, start: first.start, end: last.end, role: first.role, quote, componentId };
  }

  private scanProhibited(cc: CompiledCriterion, stream: SpeechStream, fromOffset: number): RuleEvent[] {
    const st = this.state.get(cc.c.id)!;
    const events: RuleEvent[] = [];
    for (const m of findMatches(stream, cc.patterns, fromOffset)) {
      // One piece of evidence per utterance, even when several patterns hit it.
      const key = m.utteranceIds.join(",");
      const negated = looksNegated(m.before);
      if (st.seen.has(key)) {
        if (!negated && !st.finding.violated) {
          st.finding.violated = true;
          st.finding.negatedOnly = false;
          const ev = st.finding.evidence.find((e) => e.utteranceId === m.utteranceIds[0]);
          if (ev) events.push({ kind: "violation", criterionId: cc.c.id, evidence: ev, negated: false });
        }
        continue;
      }
      st.seen.add(key);
      const ev = this.evidenceFor(m);
      if (!ev) continue;
      st.finding.evidence.push(ev);
      if (!negated) st.finding.violated = true;
      st.finding.negatedOnly = !st.finding.violated;
      events.push({ kind: "violation", criterionId: cc.c.id, evidence: ev, negated });
    }
    return events;
  }

  private scanRequired(cc: CompiledCriterion, stream: SpeechStream): RuleEvent[] {
    const st = this.state.get(cc.c.id)!;
    const f = st.finding;
    if (f.satisfied) return [];
    const events: RuleEvent[] = [];
    const window = cc.c.withinSeconds;
    const inWindow = (ev: Evidence) => window === undefined || ev.start <= window;

    if (cc.components.length) {
      for (const comp of cc.components) {
        if (f.componentsFound.includes(comp.id)) continue;
        for (const m of findMatches(stream, comp.patterns)) {
          const ev = this.evidenceFor(m, comp.id);
          if (!ev) continue;
          if (!inWindow(ev)) {
            st.lateComponents.add(comp.id);
            continue;
          }
          f.componentsFound.push(comp.id);
          f.evidence.push(ev);
          events.push({ kind: "component", criterionId: cc.c.id, componentId: comp.id, evidence: ev });
          break;
        }
      }
      const need = cc.c.minComponents ?? cc.components.length;
      if (f.componentsFound.length >= need) {
        f.satisfied = true;
        events.push({ kind: "satisfied", criterionId: cc.c.id, late: false });
      } else {
        const lateTotal = new Set([...f.componentsFound, ...st.lateComponents]).size;
        f.late = lateTotal >= need;
      }
      return events;
    }

    for (const m of findMatches(stream, cc.patterns)) {
      const ev = this.evidenceFor(m);
      if (!ev) continue;
      if (!inWindow(ev)) {
        f.late = true;
        if (!f.evidence.length) f.evidence.push(ev);
        continue;
      }
      f.evidence = [ev];
      f.satisfied = true;
      f.late = false;
      events.push({ kind: "satisfied", criterionId: cc.c.id, late: false });
      break;
    }
    return events;
  }
}

/** Run the rule engine over a complete transcript. */
export function runRules(rubric: Rubric, utterances: Utterance[], durationSec: number): RuleFinding[] {
  const engine = new RuleEngine(rubric);
  for (const u of utterances) engine.addUtterance(u);
  engine.tick(durationSec);
  return engine.findings();
}
