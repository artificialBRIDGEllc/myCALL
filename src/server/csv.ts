import type { CallRecord, CriterionResult, CriterionStatus, Rubric, ScoreResult } from "../core/types.js";

export type ExportCall = CallRecord & { result: ScoreResult | null };

/**
 * One row per call, one column per checklist item, for reviewing a batch in a
 * spreadsheet. Uses the final grade (human overrides applied).
 */
const STATUS: Record<CriterionStatus, string> = { pass: "Pass", partial: "Partial", fail: "Fail", na: "N/A", needs_review: "Needs review" };

const clock = (sec: number | null) => {
  if (sec == null) return "";
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** RFC 4180 quoting, plus a leading ' on cells a spreadsheet would run as a formula. */
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function callsCsv(calls: ExportCall[], rubrics: Rubric[]): string {
  // A column is one criterion of one rubric *version*: criterion ids are only unique within a
  // rubric, and an edited rubric may change what an id means. Criteria come from each stored
  // result, so items from edited or deleted rubrics still get a column.
  const groupOf = (r: ScoreResult) => `${r.rubricId}@${r.rubricVersion}`;
  /** The current rubric definition, only if it is the version this result was graded against. */
  const defOf = (r: ScoreResult | null | undefined) => {
    const rubric = r ? rubrics.find((x) => x.id === r.rubricId) : undefined;
    return rubric && rubric.version === r!.rubricVersion ? rubric : undefined;
  };
  const scored = calls.map((c) => c.result).filter((r): r is ScoreResult => Boolean(r));
  const groups = [...new Map(scored.map((r) => [groupOf(r), r])).values()];
  const multi = groups.length > 1;
  const columns: Array<{ key: string; name: string }> = [];
  const seen = new Set<string>();
  for (const first of groups) {
    const def = defOf(first);
    const ids = [...(def?.criteria.map((c) => c.id) ?? [])];
    for (const r of scored) if (groupOf(r) === groupOf(first)) for (const c of r.criteria) if (!ids.includes(c.criterionId)) ids.push(c.criterionId);
    const label = `${rubrics.find((x) => x.id === first.rubricId)?.name ?? first.rubricId} v${first.rubricVersion}`;
    for (const id of ids) {
      const key = `${groupOf(first)}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = def?.criteria.find((c) => c.id === id)?.name ?? id;
      columns.push({ key, name: multi ? `${label}: ${name}` : name });
    }
  }
  const header = ["Call", "Agent", "Date", "Length", "Source", "Status", "Score", "Compliance", "Critical failures", "Review", "Items to grade", "Problems found", ...columns.map((c) => c.name)];
  const rows = calls.map((call) => {
    const r = call.result;
    const def = defOf(r);
    const nameOf = (id: string) => def?.criteria.find((c) => c.id === id)?.name ?? id;
    const byKey = new Map(r?.criteria.map((c) => [`${groupOf(r)}:${c.criterionId}`, c]) ?? []);
    const describe = (c: CriterionResult) => {
      // A reviewer's decision keeps the automatic evidence, which may have supported the opposite grade.
      if (c.review) return `${nameOf(c.criterionId)}: reviewer ${c.review.reviewer}: "${c.review.note}"`;
      // A multi-part requirement's evidence shows the parts that WERE said; name the missing ones.
      const parts = def?.criteria.find((x) => x.id === c.criterionId)?.components;
      if (parts?.length && c.componentsFound) {
        const missing = parts.filter((p) => !c.componentsFound!.includes(p.id)).map((p) => p.label);
        if (missing.length) return `${nameOf(c.criterionId)}: missing ${missing.join(" / ")}`;
      }
      if (c.status === "partial") return `${nameOf(c.criterionId)}: ${c.rationale}`;
      const ev = c.evidence[0];
      return ev ? `${nameOf(c.criterionId)}: "${ev.quote}" (${clock(ev.start)})` : `${nameOf(c.criterionId)}: not found`;
    };
    const problems = (r?.criteria ?? [])
      .filter((c) => c.status === "fail" || c.status === "partial")
      .map(describe)
      .join("; ");
    return [
      call.title,
      call.agentName ?? "",
      call.createdAt.slice(0, 10),
      clock(call.durationSec),
      call.source,
      call.status === "error" ? `Error: ${call.error ?? ""}` : call.status,
      r?.score ?? "",
      r?.compliance ?? "",
      (r?.criticalFailures ?? []).map(nameOf).join("; "),
      call.reviewState === "locked" ? "Signed off" : call.reviewState === "in_review" ? "In review" : "Not reviewed",
      call.openReviewItems,
      problems,
      ...columns.map((col) => {
        const c = byKey.get(col.key);
        return c ? STATUS[c.status] : "";
      }),
    ];
  });
  // Excel opens UTF-8 CSV correctly only with a byte-order mark.
  return "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
