import type {
  Calibration,
  CalibrationRow,
  CallReview,
  CriterionOverride,
  CriterionResult,
  CriterionStatus,
  Rubric,
  ScoreResult,
} from "../core/types.js";
import { summarize } from "./score.js";

/**
 * Human review: a reviewer can grade anything the automatic scorer left for
 * review, and override anything it decided. Overrides sit on top of the stored
 * automatic result (which is never modified), so the original grade, the human
 * grade and who changed it are always visible side by side.
 */
export function emptyReview(rubricId: string): CallReview {
  return { rubricId, overrides: {}, locked: false, lockedBy: null, lockedAt: null };
}

export function overrideFraction(o: CriterionOverride): number {
  if (o.status === "pass") return 1;
  if (o.status === "fail" || o.status === "na") return 0;
  return Math.min(0.9, Math.max(0.1, o.fraction ?? 0.5));
}

/** The final result: automatic grades with human overrides applied, re-totalled. */
export function applyReview(rubric: Rubric, auto: ScoreResult, review: CallReview | null): ScoreResult {
  if (!review || review.rubricId !== auto.rubricId || !Object.keys(review.overrides).length) return auto;
  const criteria: CriterionResult[] = auto.criteria.map((c) => {
    const o = review.overrides[c.criterionId];
    if (!o) return c;
    const fraction = overrideFraction(o);
    const counted = o.status !== "na";
    return {
      ...c,
      status: o.status,
      fraction: counted ? fraction : 0,
      earned: counted ? Math.round(c.maxPoints * fraction * 10) / 10 : 0,
      rationale: o.note,
      source: "human",
      review: {
        auto: { status: c.status, fraction: c.fraction, source: c.source as Exclude<CriterionResult["source"], "human">, rationale: c.rationale },
        reviewer: o.reviewer,
        note: o.note,
        at: o.at,
      },
    };
  });
  return { ...auto, ...summarize(rubric, criteria), criteria };
}

const FAILING = new Set<CriterionStatus>(["fail", "partial"]);
const PASSING = new Set<CriterionStatus>(["pass", "na"]);

/**
 * How accurate is the automatic grader, criterion by criterion? Measured only on
 * signed-off (locked) calls: signing off means the reviewer accepted every grade
 * they didn't change, so an un-overridden grade counts as agreement.
 */
export function calibrate(rubric: Rubric, calls: Array<{ auto: ScoreResult; review: CallReview }>): Calibration {
  const locked = calls.filter((c) => c.review.locked && c.review.rubricId === rubric.id && c.auto.rubricId === rubric.id);
  const rows: CalibrationRow[] = rubric.criteria.map((crit) => {
    const row: CalibrationRow = {
      criterionId: crit.id,
      name: crit.name,
      evaluator: crit.evaluator,
      severity: crit.severity,
      decided: 0,
      agreed: 0,
      falseAlarms: 0,
      misses: 0,
      resolvedByHuman: 0,
      accuracy: null,
    };
    for (const { auto, review } of locked) {
      const a = auto.criteria.find((c) => c.criterionId === crit.id);
      if (!a) continue;
      const o = review.overrides[crit.id];
      if (a.status === "needs_review") {
        if (o) row.resolvedByHuman++;
        continue;
      }
      row.decided++;
      const human = o?.status ?? a.status;
      if (human === a.status) row.agreed++;
      else if (FAILING.has(a.status) && PASSING.has(human)) row.falseAlarms++;
      else if (PASSING.has(a.status) && FAILING.has(human)) row.misses++;
      // pass<->na or fail<->partial changes count as disagreement but neither alarm nor miss.
    }
    row.accuracy = row.decided ? Math.round((row.agreed / row.decided) * 1000) / 10 : null;
    return row;
  });
  return { rubricId: rubric.id, lockedCalls: locked.length, rows };
}
