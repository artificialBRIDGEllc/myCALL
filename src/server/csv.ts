import type { CallDetail, CriterionStatus, Rubric } from "../core/types.js";

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

export function callsCsv(calls: CallDetail[], rubrics: Rubric[]): string {
  // Columns are keyed by rubric + criterion (criterion ids are only unique within a rubric),
  // taken from each stored result so criteria from edited or deleted rubrics still get a column.
  const rubricOf = (id: string | undefined) => rubrics.find((r) => r.id === id);
  const rubricIds = [...new Set(calls.map((c) => c.result?.rubricId).filter((id): id is string => Boolean(id)))];
  const multi = rubricIds.length > 1;
  const columns: Array<{ key: string; name: string }> = [];
  const seen = new Set<string>();
  for (const rubricId of rubricIds) {
    const rubric = rubricOf(rubricId);
    const ids = [...(rubric?.criteria.map((c) => c.id) ?? [])];
    for (const call of calls) if (call.result?.rubricId === rubricId) for (const c of call.result.criteria) if (!ids.includes(c.criterionId)) ids.push(c.criterionId);
    for (const id of ids) {
      const key = `${rubricId}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = rubric?.criteria.find((c) => c.id === id)?.name ?? id;
      columns.push({ key, name: multi ? `${rubric?.name ?? rubricId}: ${name}` : name });
    }
  }
  const header = ["Call", "Agent", "Date", "Length", "Source", "Status", "Score", "Compliance", "Critical failures", "Review", "Items to grade", "Problems found", ...columns.map((c) => c.name)];
  const rows = calls.map((call) => {
    const r = call.result;
    const rubric = rubricOf(r?.rubricId);
    const nameOf = (id: string) => rubric?.criteria.find((c) => c.id === id)?.name ?? id;
    const byKey = new Map(r?.criteria.map((c) => [`${r.rubricId}:${c.criterionId}`, c]) ?? []);
    const problems = (r?.criteria ?? [])
      .filter((c) => c.status === "fail" || c.status === "partial")
      .map((c) => {
        // A reviewer's decision keeps the automatic evidence, which may have supported the opposite grade.
        if (c.review) return `${nameOf(c.criterionId)}: reviewer ${c.review.reviewer}: "${c.review.note}"`;
        const ev = c.evidence[0];
        return ev ? `${nameOf(c.criterionId)}: "${ev.quote}" (${clock(ev.start)})` : `${nameOf(c.criterionId)}: not found`;
      })
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
