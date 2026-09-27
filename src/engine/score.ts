import type {
  Criterion,
  CriterionResult,
  CriterionStatus,
  Evidence,
  Rubric,
  ScoreResult,
  Transcript,
  Utterance,
} from "../core/types.js";
import { computeMetrics } from "./metrics.js";
import type { AiReview, AiReviewer } from "./reviewer.js";
import { runRules, type RuleFinding } from "./rules.js";
import { redactPHI } from "./redact.js";
import { formatClock, normalize } from "./text.js";

type AiCriterion = AiReview["criteria"][number];

export interface ScoreOptions {
  rubric: Rubric;
  transcript: Transcript;
  /** Null = rules-only scoring (free, instant; judgment criteria go to human review). */
  reviewer?: AiReviewer | null;
}

/**
 * Score a complete call. Deterministic rules run first; the AI reviewer (if any)
 * grades judgment criteria and confirms/overrides hybrid ones. The merge policy
 * is conservative ("fail closed"): an AI claim only counts if its quoted
 * evidence is verified against the real transcript, and anything the AI clears
 * on a critical compliance item goes to human review instead of passing silently.
 */
export async function scoreCall({ rubric, transcript, reviewer }: ScoreOptions): Promise<ScoreResult> {
  const { utterances, durationSec } = transcript;
  const findings = runRules(rubric, utterances, durationSec);
  const metrics = computeMetrics(utterances, durationSec);

  let review: AiReview | null = null;
  let aiError: string | null = null;
  if (reviewer && utterances.length) {
    try {
      review = await reviewer.review({ rubric, utterances, durationSec, findings });
    } catch (err) {
      aiError = err instanceof Error ? err.message : String(err);
    }
  }

  return assemble(rubric, transcript, findings, review, reviewer && review ? reviewer.name : null, aiError, metrics);
}

export function assemble(
  rubric: Rubric,
  transcript: Transcript,
  findings: RuleFinding[],
  review: AiReview | null,
  aiReviewer: string | null,
  aiError: string | null,
  metrics = computeMetrics(transcript.utterances, transcript.durationSec),
): ScoreResult {
  const byUtt = new Map(transcript.utterances.map((u) => [u.id, u]));
  const ruleById = new Map(findings.map((f) => [f.criterionId, f]));
  const aiById = new Map((review?.criteria ?? []).map((c) => [c.criterionId, c]));
  const aiAvailable = review !== null;

  const criteria = rubric.criteria.map((c) =>
    judge(c, ruleById.get(c.id), aiById.get(c.id), aiAvailable, byUtt),
  );

  const totals = summarize(rubric, criteria);

  const validUtt = (id: number | null) => (id !== null && byUtt.has(id) ? id : null);
  const labels = new Map((rubric.extract ?? []).map((f) => [f.id, f.label]));

  return {
    rubricId: rubric.id,
    rubricVersion: rubric.version,
    ...totals,
    criteria,
    metrics,
    summary: review?.summary ?? null,
    callOutcome: review?.callOutcome ?? null,
    customerSentiment: review?.customerSentiment ?? null,
    strengths: (review?.strengths ?? []).map((s) => ({ point: s.point, utteranceId: validUtt(s.utteranceId) })),
    improvements: (review?.improvements ?? []).map((s) => ({
      point: s.point,
      utteranceId: validUtt(s.utteranceId),
      betterPhrasing: s.betterPhrasing,
    })),
    extracted: (rubric.extract ?? []).map((f) => {
      const hit = review?.extracted.find((x) => x.fieldId === f.id);
      return { field: f.id, label: labels.get(f.id) ?? f.id, value: hit?.value ?? null, utteranceId: validUtt(hit?.utteranceId ?? null) };
    }),
    aiReviewer,
    aiError,
    scoredAt: new Date().toISOString(),
  };
}

/**
 * Score, pass/fail and compliance gate from a list of graded criteria.
 * Shared by automatic scoring and by human review, so both use identical maths.
 */
export function summarize(
  rubric: Rubric,
  criteria: CriterionResult[],
): Pick<ScoreResult, "score" | "passed" | "compliance" | "criticalFailures" | "needsReview"> {
  const counted = criteria.filter((r) => r.status === "pass" || r.status === "partial" || r.status === "fail");
  const max = counted.reduce((s, r) => s + r.maxPoints, 0);
  const earned = counted.reduce((s, r) => s + r.earned, 0);
  const score = max > 0 ? Math.round((earned / max) * 100) : 0;

  const critical = new Set(rubric.criteria.filter((c) => c.severity === "critical").map((c) => c.id));
  const criticalFailures = criteria
    .filter((r) => critical.has(r.criterionId) && (r.status === "fail" || r.status === "partial"))
    .map((r) => r.criterionId);
  const needsReview = criteria.filter((r) => r.status === "needs_review").map((r) => r.criterionId);
  const compliance = criticalFailures.length ? "fail" : needsReview.some((id) => critical.has(id)) ? "review" : "pass";
  return { score, passed: compliance === "pass" && score >= rubric.passThreshold, compliance, criticalFailures, needsReview };
}

// ---------------------------------------------------------------------------
// Per-criterion merge policy
// ---------------------------------------------------------------------------

function result(
  c: Criterion,
  status: CriterionStatus,
  fraction: number,
  evidence: Evidence[],
  rationale: string,
  source: CriterionResult["source"],
  extra: Partial<CriterionResult> = {},
): CriterionResult {
  const counted = status === "pass" || status === "partial" || status === "fail";
  const f = counted ? Math.min(1, Math.max(0, fraction)) : 0;
  const failing = status === "fail" || status === "partial" || status === "needs_review";
  return {
    criterionId: c.id,
    status,
    fraction: f,
    earned: counted ? Math.round(c.points * f * 10) / 10 : 0,
    maxPoints: c.points,
    evidence,
    rationale,
    source,
    coaching: extra.coaching ?? (failing ? c.liveHint : undefined),
    ...extra,
  };
}

/**
 * Keep only AI evidence whose quote really appears, word for word and in
 * order, in the cited utterance. "..." in a quote may skip words between
 * fragments. The quote is checked against both the raw and the PHI-redacted
 * text (the AI only ever saw the redacted form).
 */
export function verifyEvidence(ai: AiCriterion, byUtt: Map<number, Utterance>): Evidence[] {
  const out: Evidence[] = [];
  for (const e of ai.evidence) {
    const u = byUtt.get(e.utteranceId);
    if (!u) continue;
    const fragments = e.quote
      .split(/\.{3}|…/)
      .map(normalize)
      .filter(Boolean);
    const quoteWords = fragments.join(" ").split(" ").filter(Boolean).length;
    const utteranceWords = normalize(u.text).split(" ").filter(Boolean).length;
    // A one-word "quote" proves nothing unless the utterance itself is that short.
    if (!fragments.length || quoteWords < Math.min(3, utteranceWords)) continue;
    const texts = [normalize(u.text), normalize(redactPHI(u.text))];
    if (texts.some((t) => containsInOrder(t, fragments))) {
      out.push({ utteranceId: u.id, start: u.start, end: u.end, role: u.role, quote: u.text });
    }
  }
  return dedupe(out);
}

function containsInOrder(text: string, fragments: string[]): boolean {
  const padded = ` ${text} `;
  let from = 0;
  for (const f of fragments) {
    const at = padded.indexOf(` ${f} `, from);
    if (at < 0) return false;
    from = at + f.length + 1;
  }
  return true;
}

function dedupe(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return evidence.filter((e) => {
    const k = `${e.utteranceId}|${e.componentId ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function aiFraction(ai: AiCriterion): number {
  if (ai.status === "pass") return 1;
  if (ai.status === "fail") return 0;
  const p = Number.isFinite(ai.scorePercent) ? ai.scorePercent / 100 : 0.5;
  return Math.min(0.9, Math.max(0.1, p));
}

function componentFraction(c: Criterion, f: RuleFinding): number {
  if (!c.components?.length) return f.satisfied ? 1 : 0;
  const need = c.minComponents ?? c.components.length;
  return Math.min(1, f.componentsFound.length / need);
}

function judge(
  c: Criterion,
  f: RuleFinding | undefined,
  ai: AiCriterion | undefined,
  aiAvailable: boolean,
  byUtt: Map<number, Utterance>,
): CriterionResult {
  if (c.kind === "judgment" || c.evaluator === "llm" || !f) {
    if (!ai) {
      return result(
        c,
        "needs_review",
        0,
        [],
        aiAvailable ? "The AI reviewer did not grade this item." : "Needs a human or AI reviewer (no AI reviewer configured).",
        "llm",
      );
    }
    return result(c, ai.status, aiFraction(ai), verifyEvidence(ai, byUtt), ai.rationale, "llm", {
      coaching: ai.coaching ?? undefined,
    });
  }
  return c.kind === "prohibited" ? judgeProhibited(c, f, ai, aiAvailable, byUtt) : judgeRequired(c, f, ai, aiAvailable, byUtt);
}

function judgeRequired(
  c: Criterion,
  f: RuleFinding,
  ai: AiCriterion | undefined,
  aiAvailable: boolean,
  byUtt: Map<number, Utterance>,
): CriterionResult {
  const extra = { componentsFound: f.componentsFound };
  const window = c.withinSeconds !== undefined ? ` within ${c.withinSeconds}s` : "";
  if (f.satisfied) {
    const at = f.evidence[0] ? ` at ${formatClock(f.evidence[0].start)}` : "";
    return result(c, "pass", 1, f.evidence, `Found by phrase rules${at}.`, "rules", extra);
  }

  const rulesFraction = f.late ? 0 : componentFraction(c, f);
  const rulesStatus: CriterionStatus = rulesFraction > 0 ? "partial" : "fail";
  const rulesRationale = f.late
    ? `Said too late — only found after the ${c.withinSeconds}s limit.`
    : f.componentsTotal
      ? `Found ${f.componentsFound.length} of ${f.componentsTotal} required elements${window}.`
      : `Not found${window}.`;

  if (c.evaluator === "rules" || !ai) {
    const note = c.evaluator === "hybrid" && !aiAvailable ? " AI paraphrase check unavailable, so this fails closed." : "";
    return result(c, rulesStatus, rulesFraction, f.evidence, rulesRationale + note, "rules", extra);
  }

  if (ai.status === "na") return result(c, "na", 0, [], ai.rationale, "rules+llm", extra);
  const aiEvidence = verifyEvidence(ai, byUtt).filter((e) => c.withinSeconds === undefined || e.start <= c.withinSeconds + 5);
  if (ai.status === "pass" || ai.status === "partial") {
    if (!aiEvidence.length) {
      return result(c, "needs_review", 0, f.evidence, `AI reviewer judged "${ai.status}" but its evidence could not be verified in the transcript${window}. ${ai.rationale}`, "rules+llm", extra);
    }
    const fraction = Math.max(rulesFraction, aiFraction(ai));
    return result(c, fraction >= 1 ? "pass" : "partial", fraction, dedupe([...f.evidence, ...aiEvidence]), `Paraphrase confirmed by AI reviewer. ${ai.rationale}`, "rules+llm", {
      ...extra,
      coaching: ai.coaching ?? undefined,
    });
  }
  return result(c, rulesStatus, rulesFraction, dedupe([...f.evidence, ...aiEvidence]), `${rulesRationale} ${ai.rationale}`, "rules+llm", {
    ...extra,
    coaching: ai.coaching ?? c.liveHint,
  });
}

function judgeProhibited(
  c: Criterion,
  f: RuleFinding,
  ai: AiCriterion | undefined,
  aiAvailable: boolean,
  byUtt: Map<number, Utterance>,
): CriterionResult {
  const flagged = f.evidence.length > 0;
  const aiEvidence = ai ? verifyEvidence(ai, byUtt) : [];

  if (c.evaluator === "rules" || !ai) {
    if (f.violated) return result(c, "fail", 0, f.evidence, `Prohibited phrasing found (${f.evidence.length}×).`, "rules");
    if (f.negatedOnly) {
      return result(c, "needs_review", 0, f.evidence, "Flagged phrasing appears negated — confirm context.", "rules");
    }
    const note = c.evaluator === "hybrid" && !aiAvailable ? " (phrase rules only)" : "";
    return result(c, "pass", 1, [], `No prohibited phrasing found${note}.`, "rules");
  }

  if (ai.status === "fail" || ai.status === "partial") {
    const evidence = dedupe([...f.evidence, ...aiEvidence]);
    if (!evidence.length) {
      return result(c, "needs_review", 0, [], `AI reviewer reported a violation but cited no verifiable words. ${ai.rationale}`, "llm", {
        coaching: ai.coaching ?? undefined,
      });
    }
    return result(c, "fail", 0, evidence, ai.rationale, flagged ? "rules+llm" : "llm", { coaching: ai.coaching ?? c.liveHint });
  }

  if (flagged) {
    // The AI cleared a phrase the rules flagged. Critical items still get a human look.
    if (c.severity === "critical") {
      return result(c, "needs_review", 0, f.evidence, `Phrase rules flagged this; AI reviewer judged it acceptable: ${ai.rationale} Confirm before closing.`, "rules+llm");
    }
    return result(c, "pass", 1, f.evidence, `Flagged phrase judged acceptable in context: ${ai.rationale}`, "rules+llm");
  }
  return result(c, "pass", 1, [], ai.rationale || "No violation found.", "rules+llm");
}
