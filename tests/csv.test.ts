import { describe, expect, it } from "vitest";
import type { CriterionResult, Rubric } from "../src/core/types.js";
import { callsCsv as toCsv, csvCell, type ExportCall } from "../src/server/csv.js";

const callsCsv = (calls: ExportCall[], rubrics: Rubric[]) => toCsv(calls, (id, version) => rubrics.find((r) => r.id === id && r.version === version));

const rubric = (id: string, name: string, criteria: Array<[string, string]>, version = "1", components?: Array<[string, string]>) =>
  ({ id, name, version, criteria: criteria.map(([cid, cname]) => ({ id: cid, name: cname, components: components?.map(([pid, label]) => ({ id: pid, label })) })) }) as unknown as Rubric;
const crit = (criterionId: string, status: CriterionResult["status"], extra: Partial<CriterionResult> = {}) =>
  ({ criterionId, status, fraction: 0, earned: 0, maxPoints: 5, evidence: [], rationale: "", source: "rules", ...extra }) as CriterionResult;
const call = (title: string, rubricId: string, criteria: CriterionResult[], durationSec = 60, rubricVersion = "1") =>
  ({
    id: title, title, agentName: null, source: "upload", status: "scored", createdAt: "2026-09-29T00:00:00Z", durationSec, error: null,
    reviewState: "auto", openReviewItems: 0,
    result: { rubricId, rubricVersion, score: 80, compliance: "pass", criticalFailures: [], criteria },
  }) as unknown as ExportCall;
const parse = (csv: string) => csv.replace(/^﻿/, "").trim().split("\r\n");

describe("results spreadsheet", () => {
  it("keeps same-named criterion ids from different rubrics in separate, labelled columns", () => {
    const rubrics = [rubric("a", "Sales", [["greeting", "Greets warmly"]]), rubric("b", "Service", [["greeting", "Says hello"]])];
    const [head, r1, r2] = parse(callsCsv([call("one", "a", [crit("greeting", "pass")]), call("two", "b", [crit("greeting", "fail")])], rubrics));
    expect(head).toContain("Sales v1: Greets warmly,Service v1: Says hello");
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

  it("keeps grades from an older rubric version out of the current version's column", () => {
    const rubrics = [rubric("a", "Sales", [["greeting", "Uses the new greeting script"]], "2")];
    const [head, oldRow, newRow] = parse(callsCsv([call("old", "a", [crit("greeting", "fail")], 60, "1"), call("new", "a", [crit("greeting", "pass")], 60, "2")], rubrics));
    expect(head).toContain("a v1: greeting,Sales v2: Uses the new greeting script"); // v1 not on file: labelled by id
    expect(oldRow!.endsWith(",Fail,")).toBe(true);
    expect(newRow!.endsWith(",,Pass")).toBe(true);
  });

  it("names the missing parts of a partly-read disclosure instead of quoting the part that was said", () => {
    const rubrics = [rubric("a", "S", [["tpmo", "TPMO disclaimer"]], "1", [["not_every", "Not every plan"], ["count", "How many plans"], ["ship", "Medicare.gov / SHIP"]])];
    const said = { utteranceId: 1, start: 5, end: 6, role: "agent", quote: "we do not offer every plan" };
    const partial = crit("tpmo", "partial", { evidence: [said] as never, componentsFound: ["not_every"] });
    const [, row] = parse(callsCsv([call("t", "a", [partial])], rubrics));
    expect(row).toContain("TPMO disclaimer: missing How many plans / Medicare.gov / SHIP");
    expect(row).not.toContain("we do not offer every plan");
  });

  it("never repeats a header, even when item names collide with each other or with fixed columns", () => {
    const rubrics = [rubric("a", "S", [["greet1", "Greeting"], ["greet2", "Greeting"], ["score", "Score"]])];
    const [head] = parse(callsCsv([call("t", "a", [crit("greet1", "pass"), crit("greet2", "fail"), crit("score", "pass")])], rubrics));
    const cols = head!.split(",");
    expect(new Set(cols).size).toBe(cols.length);
    expect(head).toContain("Greeting [greet1],Greeting [greet2],Score [score]");
  });

  it("keeps headers unique across rubrics with the same name, version and item", () => {
    const rubrics = [rubric("a", "Sales", [["greet", "Greeting"]]), rubric("b", "Sales", [["greet", "Greeting"], ["x", "Sales v1: Greeting [a@1:greet]"]])];
    const [head] = parse(callsCsv([call("one", "a", [crit("greet", "pass")]), call("two", "b", [crit("greet", "fail"), crit("x", "pass")])], rubrics));
    const cols = head!.split(",");
    expect(new Set(cols).size).toBe(cols.length);
  });

  it("neutralises cells a spreadsheet would run as formulas", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("  =1+1")).toBe("'  =1+1");
    expect(csvCell("\n@SUM(A1)")).toBe(`"'\n@SUM(A1)"`);
    expect(csvCell("Dana Brooks")).toBe("Dana Brooks");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });
});
