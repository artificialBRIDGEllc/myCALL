import type { CallMetrics, ChecklistItem, Criterion, LiveAlert, Rubric, Utterance } from "../core/types.js";
import { computeMetrics } from "./metrics.js";
import { RuleEngine, type RuleEvent } from "./rules.js";
import { formatClock } from "./text.js";

/**
 * Real-time coach for a call in progress. Wraps the deterministic RuleEngine,
 * turns its events into agent-facing alerts, and keeps a live checklist and a
 * provisional score. Pure and synchronous: the server feeds it utterances from
 * the streaming transcriber and a clock tick once per second.
 */
export class LiveSession {
  readonly utterances: Utterance[] = [];
  private engine: RuleEngine;
  private criteria: Map<string, Criterion>;
  private elapsed = 0;
  private alertSeq = 0;
  private warned = new Set<string>();

  constructor(readonly rubric: Rubric) {
    this.engine = new RuleEngine(rubric);
    this.criteria = new Map(rubric.criteria.map((c) => [c.id, c]));
  }

  get elapsedSec(): number {
    return this.elapsed;
  }

  addUtterance(u: Utterance): LiveAlert[] {
    this.utterances.push(u);
    this.elapsed = Math.max(this.elapsed, u.end);
    return this.engine.addUtterance(u).flatMap((e) => this.toAlerts(e));
  }

  tick(elapsedSec: number): LiveAlert[] {
    this.elapsed = Math.max(this.elapsed, elapsedSec);
    const alerts = this.engine.tick(this.elapsed).flatMap((e) => this.toAlerts(e));
    // Early warning at 75% of a time window, so the agent can still comply.
    for (const c of this.criteria.values()) {
      if (c.kind !== "required" || c.withinSeconds === undefined || this.warned.has(c.id)) continue;
      const f = this.engine.finding(c.id);
      if (!f || f.satisfied) continue;
      const left = c.withinSeconds - this.elapsed;
      if (left <= c.withinSeconds * 0.25 && left > 0) {
        this.warned.add(c.id);
        alerts.push(this.alert(c, c.severity === "critical" ? "critical" : "warning", `${Math.ceil(left)}s left: ${c.liveHint ?? c.name}`));
      }
    }
    return alerts;
  }

  checklist(): ChecklistItem[] {
    const items: ChecklistItem[] = [];
    for (const id of this.engine.criterionIds) {
      const c = this.criteria.get(id)!;
      const f = this.engine.finding(id)!;
      let state: ChecklistItem["state"];
      if (c.kind === "prohibited") state = f.violated ? "violated" : "done";
      else if (f.satisfied) state = "done";
      else if (f.overdue || f.late) state = "overdue";
      else state = "pending";
      items.push({
        criterionId: id,
        name: c.name,
        kind: c.kind,
        severity: c.severity,
        state,
        secondsLeft: c.withinSeconds !== undefined && state === "pending" ? Math.max(0, Math.ceil(c.withinSeconds - this.elapsed)) : undefined,
        componentsFound: f.componentsTotal ? [...f.componentsFound] : undefined,
        componentsTotal: f.componentsTotal || undefined,
        hint: state === "done" ? undefined : c.liveHint,
      });
    }
    return items;
  }

  /**
   * Provisional 0-100 score from rule-checkable items only. Items still in
   * progress (not yet said, time not up) are left out so the score doesn't
   * start at zero; AI-judged skills are added when the call is finalized.
   */
  provisionalScore(): number {
    let earned = 0;
    let max = 0;
    for (const item of this.checklist()) {
      const c = this.criteria.get(item.criterionId)!;
      if (item.state === "pending") {
        const partial = item.componentsTotal ? (item.componentsFound?.length ?? 0) / (c.minComponents ?? item.componentsTotal) : 0;
        if (partial > 0) {
          earned += c.points * Math.min(1, partial);
          max += c.points;
        }
        continue;
      }
      max += c.points;
      if (item.state === "done") earned += c.points;
    }
    return max ? Math.round((earned / max) * 100) : 100;
  }

  metrics(): CallMetrics {
    return computeMetrics(this.utterances, this.elapsed);
  }

  private alert(c: Criterion, level: LiveAlert["level"], message: string, quote?: string): LiveAlert {
    return { id: `a${++this.alertSeq}`, at: Math.round(this.elapsed), criterionId: c.id, level, message, quote };
  }

  private toAlerts(e: RuleEvent): LiveAlert[] {
    const c = this.criteria.get(e.criterionId);
    if (!c) return [];
    switch (e.kind) {
      case "violation":
        if (e.negated) return [this.alert(c, "info", `Possible issue (sounds negated): ${c.name}`, e.evidence.quote)];
        return [this.alert(c, c.severity === "critical" ? "critical" : "warning", `${c.name} — ${c.liveHint ?? "prohibited statement"}`, e.evidence.quote)];
      case "overdue":
        return [this.alert(c, c.severity === "critical" ? "critical" : "warning", `Missed: ${c.name} (not done in first ${formatClock(c.withinSeconds ?? 0)})`)];
      case "satisfied":
        return [this.alert(c, "info", `✓ ${c.name}`)];
      case "component":
        return [];
    }
  }
}
