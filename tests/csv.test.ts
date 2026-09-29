import { describe, expect, it } from "vitest";
import type { CallDetail, CriterionResult, Rubric } from "../src/core/types.js";
import { callsCsv, csvCell } from "../src/server/csv.js";

const rubric = (id: string, name: string, criteria: Array<[string, string]>) => ({ id, name, criteria: criteria.map(([cid, cname]) => ({ id: cid, name: cname })) }) as unknown as Rubric;
const crit = (criterionId: string, status: CriterionResult["status"], extra: Partial<CriterionResult> = {}) =>
  ({ criterionId, status, fraction: 0, earned: 0, maxPoints: 5, evidence: [], rationale: "", source: "rules", ...extra }) as CriterionResult;
const call = (title: string, rubricId: string, criteria: CriterionResult[], durationSec = 60) =>
  ({
    id: title, title, agentName: null, source: "upload", status: "scored", createdAt: "2026-09-29T00:00:00Z", durationSec, error: null,
    reviewState: "auto", openReviewItems: 0,
    result: { rubricId, score: 80, compliance: "pass", criticalFailures: [], criteria },
  }) as unknown as CallDetail;
const parse = (csv: string) => csv.replace(/^﻿/, "").trim().split("\r\n");

describe("results spreadsheet", () => {
  it("keeps same-named criterion ids from different rubrics in separate, labelled columns", () => {
    const rubrics = [rubric("a", "Sales", [["greeting", "Greets warmly"]]), rubric("b", "Service", [["greeting", "Says hello"]])];
    const [head, r1, r2] = parse(callsCsv([call("one", "a", [crit("greeting", "pass")]), call("two", "b", [crit("greeting", "fail")])], rubrics));
    expect(head).toContain("Sales: Greets warmly,Service: Says hello");
    expect(r1!.endsWith(",Pass,")).toBe(true);
    expect(r2!.endsWith(",,Fail")).toBe(true);
  });

  it("still exports grades for criteria no longer in the current rubric", () => {
    const [head, row] = parse(callsCsv([call("old", "a", [crit("greeting", "pass"), crit("retired_item", "fail")])], [rubric("a", "Sales", [["greeting", "Greets"]])]));
    expect(head!.endsWith("Greets,retired_item")).toBe(true);
    expect(row!.endsWith("Pass,Fail")).toBe(true);
  });

  it("never writes a 60-second timestamp", () => {
    const quote = { utteranceId: 1, start: 59.6, end: 61, role: "agent", quote: "best plan" };
    const [, row] = parse(callsCsv([call("t", "a", [crit("x", "fail", { evidence: [quote] as never })], 119.7)], [rubric("a", "S", [["x", "X"]])]));
    expect(row).toContain(",2:00,");
    expect(row).toContain("(1:00)");
    expect(row).not.toMatch(/:60/);
  });

  it("shows the reviewer's reason, not the automatic quote, for a failure a reviewer decided", () => {
    const quote = { utteranceId: 1, start: 5, end: 6, role: "agent", quote: "we do not offer every plan" };
    const failed = crit("x", "fail", { evidence: [quote] as never, source: "human", review: { auto: { status: "pass", fraction: 1, source: "rules", rationale: "" }, reviewer: "Pat", note: "Read it too fast to understand", at: "" } });
    const [, row] = parse(callsCsv([call("t", "a", [failed])], [rubric("a", "S", [["x", "X"]])]));
    expect(row).toContain('X: reviewer Pat: ""Read it too fast to understand""');
    expect(row).not.toContain("we do not offer every plan");
  });

  it("neutralises cells a spreadsheet would run as formulas", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });
});
