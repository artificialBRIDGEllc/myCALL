import type { CallDetail, CriterionStatus, Rubric } from "../core/types.js";

/**
 * One row per call, one column per checklist item, for reviewing a batch in a
 * spreadsheet. Uses the final grade (human overrides applied).
 */
const STATUS: Record<CriterionStatus, string> = { pass: "Pass", partial: "Partial", fail: "Fail", na: "N/A", needs_review: "Needs review" };

const clock = (sec: number | null) => (sec == null ? "" : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`);

/** RFC 4180 quoting, plus a leading ' on cells a spreadsheet would run as a formula. */
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function callsCsv(calls: CallDetail[], rubrics: Rubric[]): string {
  // Columns for every checklist item used by these calls, in rubric order.
  const columns: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const call of calls) {
    const rubric = rubrics.find((r) => r.id === call.result?.rubricId);
    for (const c of rubric?.criteria ?? []) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        columns.push({ id: c.id, name: c.name });
      }
    }
  }
  const header = ["Call", "Agent", "Date", "Length", "Source", "Status", "Score", "Compliance", "Critical failures", "Review", "Items to grade", "Problems found", ...columns.map((c) => c.name)];
  const rows = calls.map((call) => {
    const r = call.result;
    const rubric = rubrics.find((x) => x.id === r?.rubricId);
    const nameOf = (id: string) => rubric?.criteria.find((c) => c.id === id)?.name ?? id;
    const byId = new Map(r?.criteria.map((c) => [c.criterionId, c]) ?? []);
    const problems = (r?.criteria ?? [])
      .filter((c) => c.status === "fail" || c.status === "partial")
      .map((c) => {
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
        const c = byId.get(col.id);
        return c ? STATUS[c.status] : "";
      }),
    ];
  });
  // Excel opens UTF-8 CSV correctly only with a byte-order mark.
  return "﻿" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
