import { describe, expect, it } from "vitest";
import type { Transcript, Utterance } from "../src/core/types.js";
import { LiveSession } from "../src/engine/live.js";
import { computeMetrics } from "../src/engine/metrics.js";
import { redactPHI } from "../src/engine/redact.js";
import type { AiReview, AiReviewer } from "../src/engine/reviewer.js";
import { buildUserPrompt } from "../src/engine/reviewer.js";
import { runRules } from "../src/engine/rules.js";
import { scoreCall, verifyEvidence } from "../src/engine/score.js";
import { normalize } from "../src/engine/text.js";
import { generalSalesRubric, medicareRubric } from "../src/rubrics/index.js";
import { sampleTranscript } from "../src/rubrics/sample-call.js";

const u = (id: number, start: number, role: "agent" | "customer", text: string): Utterance => ({
  id,
  start,
  end: start + 4,
  speaker: role === "agent" ? "0" : "1",
  role,
  text,
});
const tx = (utterances: Utterance[], durationSec = 300): Transcript => ({ utterances, durationSec, source: "import", roleMap: {} });
const finding = (t: Transcript, id: string) => runRules(medicareRubric, t.utterances, t.durationSec).find((f) => f.criterionId === id)!;

describe("normalize", () => {
  it("strips punctuation, apostrophes and case", () => {
    expect(normalize("We're NOT with Medicare.gov — call 1-800-MEDICARE!")).toBe("were not with medicare gov call 1 800 medicare");
  });
});

describe("rule engine", () => {
  it("finds a TPMO disclaimer split across utterances", () => {
    const t = tx([
      u(0, 5, "agent", "We do not offer every plan available in your area. Currently we represent"),
      u(1, 10, "agent", "five organizations which offer 30 products in your area."),
      u(2, 16, "agent", "Please contact Medicare.gov or 1-800-MEDICARE for all your options."),
    ]);
    const f = finding(t, "tpmo_disclaimer");
    expect(f.satisfied).toBe(true);
    expect(f.componentsFound.sort()).toEqual(["all_options", "not_every_plan", "represent_count"]);
  });

  it("fails a TPMO disclaimer read after the first minute", () => {
    const t = tx([
      u(0, 90, "agent", "We don't offer every plan in your area. We represent 3 carriers. Call Medicare.gov for all options."),
    ]);
    const f = finding(t, "tpmo_disclaimer");
    expect(f.satisfied).toBe(false);
    expect(f.late).toBe(true);
  });

  it("does not credit the customer for agent disclosures", () => {
    const t = tx([u(0, 5, "customer", "This call is being recorded, right?")]);
    expect(finding(t, "recording_notice").satisfied).toBe(false);
  });

  it("flags government affiliation but not selling Medicare plans", () => {
    const bad = tx([u(0, 5, "agent", "Hi, I'm calling from Medicare about your benefits.")]);
    const ok = tx([u(0, 5, "agent", "I'm with Medicare Advantage plans department at Sunrise, and Medicare.gov has more info.")]);
    expect(finding(bad, "no_government_affiliation").violated).toBe(true);
    expect(finding(ok, "no_government_affiliation").evidence).toHaveLength(0);
  });

  it("marks negated prohibited phrases as negated, not violated", () => {
    const t = tx([u(0, 5, "agent", "I can't tell you it's the best plan for everyone.")]);
    const f = finding(t, "no_superlatives");
    expect(f.violated).toBe(false);
    expect(f.negatedOnly).toBe(true);
  });

  it("does not flag Medigap 'guaranteed issue'", () => {
    const t = tx([u(0, 5, "agent", "In some states you have guaranteed issue rights for Medigap.")]);
    expect(finding(t, "no_guarantees").evidence).toHaveLength(0);
  });

  it("gives partial credit for needs analysis", () => {
    const t = tx([u(0, 5, "agent", "Which doctors do you see and what prescriptions do you take? What's your budget?")]);
    const f = finding(t, "needs_analysis");
    expect(f.componentsFound.sort()).toEqual(["budget", "doctors", "prescriptions"]);
    expect(f.satisfied).toBe(false);
  });
});

describe("scoreCall — rules only", () => {
  it("scores the sample call, catches its violations, and sends judgment items to review", async () => {
    const r = await scoreCall({ rubric: medicareRubric, transcript: sampleTranscript, reviewer: null });
    const by = Object.fromEntries(r.criteria.map((c) => [c.criterionId, c]));
    expect(by.tpmo_disclaimer!.status).toBe("pass");
    expect(by.recording_notice!.status).toBe("pass");
    expect(by.scope_of_appointment!.status).toBe("pass");
    expect(by.no_superlatives!.status).toBe("fail");
    expect(by.no_pressure!.status).toBe("fail");
    expect(by.no_government_affiliation!.status).toBe("pass");
    expect(by.plan_explanation!.status).toBe("needs_review");
    // Every failure carries the exact words, with a timestamp.
    expect(by.no_superlatives!.evidence[0]!.quote).toContain("best plan");
    expect(by.no_superlatives!.evidence).toHaveLength(1); // two patterns hit one sentence -> one piece of evidence
    expect(by.no_superlatives!.evidence[0]!.start).toBeCloseTo(110);
    // informed_enrollment is critical and unreviewed -> compliance needs review, not a silent pass.
    expect(r.compliance).toBe("review");
    expect(r.aiReviewer).toBeNull();
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(100);
  });

  it("fails compliance when a critical disclosure is missing", async () => {
    const t = tx([u(0, 2, "agent", "Hi this is Sam, let me tell you about a great plan."), u(1, 8, "customer", "Okay.")], 120);
    const r = await scoreCall({ rubric: medicareRubric, transcript: t, reviewer: null });
    expect(r.compliance).toBe("fail");
    expect(r.criticalFailures).toContain("tpmo_disclaimer");
    expect(r.passed).toBe(false);
  });
});

class FakeReviewer implements AiReviewer {
  name = "fake-reviewer";
  constructor(private make: (ids: string[]) => AiReview) {}
  async review(input: { rubric: typeof medicareRubric }) {
    return this.make(input.rubric.criteria.filter((c) => c.evaluator !== "rules").map((c) => c.id));
  }
}
const baseReview = (criteria: AiReview["criteria"]): AiReview => ({
  criteria,
  summary: "Summary.",
  callOutcome: "Follow-up scheduled",
  customerSentiment: "positive",
  strengths: [{ point: "Warm opening", utteranceId: 0 }],
  improvements: [{ point: "Avoid superlatives", utteranceId: 19, betterPhrasing: "Based on your doctors, this plan fits well." }],
  extracted: [{ fieldId: "pharmacy", value: "Walgreens on Main Street", utteranceId: 14 }],
});

describe("scoreCall — with AI reviewer", () => {
  it("merges AI judgments, verifies quotes, and never lets the AI invent evidence", async () => {
    const reviewer = new FakeReviewer((ids) =>
      baseReview(
        ids.map((id) => {
          if (id === "no_superlatives") return { criterionId: id, status: "pass", scorePercent: 100, rationale: "Context ok", evidence: [], coaching: null };
          if (id === "no_government_affiliation")
            return { criterionId: id, status: "fail", scorePercent: 0, rationale: "Invented", evidence: [{ utteranceId: 3, quote: "I work for the government" }], coaching: null };
          if (id === "informed_enrollment") return { criterionId: id, status: "na", scorePercent: 0, rationale: "No enrollment on this call.", evidence: [], coaching: null };
          return { criterionId: id, status: "pass", scorePercent: 100, rationale: "Done well.", evidence: [{ utteranceId: 21, quote: "the premium is zero dollars" }], coaching: null };
        }),
      ),
    );
    const r = await scoreCall({ rubric: medicareRubric, transcript: sampleTranscript, reviewer });
    const by = Object.fromEntries(r.criteria.map((c) => [c.criterionId, c]));
    // Non-critical flagged phrase the AI cleared -> pass, evidence kept for transparency.
    expect(by.no_superlatives!.status).toBe("pass");
    // AI claimed a violation with a quote that is not in the transcript -> human review, not a fail.
    expect(by.no_government_affiliation!.status).toBe("needs_review");
    expect(by.plan_explanation!.status).toBe("pass");
    expect(by.plan_explanation!.evidence[0]!.utteranceId).toBe(21);
    expect(by.informed_enrollment!.status).toBe("na");
    expect(r.aiReviewer).toBe("fake-reviewer");
    expect(r.extracted.find((e) => e.field === "pharmacy")!.value).toContain("Walgreens");
    expect(r.compliance).toBe("review");
  });

  it("fails closed when the AI reviewer errors", async () => {
    const reviewer: AiReviewer = { name: "broken", review: async () => Promise.reject(new Error("timeout")) };
    const r = await scoreCall({ rubric: medicareRubric, transcript: sampleTranscript, reviewer });
    expect(r.aiError).toBe("timeout");
    expect(r.aiReviewer).toBeNull();
    expect(r.criteria.find((c) => c.criterionId === "rapport")!.status).toBe("needs_review");
  });
});

describe("evidence verification", () => {
  const byUtt = new Map(sampleTranscript.utterances.map((x) => [x.id, x]));
  const check = (utteranceId: number, quote: string) =>
    verifyEvidence({ criterionId: "x", status: "pass", scorePercent: 100, rationale: "", evidence: [{ utteranceId, quote }], coaching: null }, byUtt).length;

  it("accepts verbatim quotes, ignoring case and punctuation, with ... skips", () => {
    expect(check(19, "honestly, this is the BEST plan out there")).toBe(1);
    expect(check(21, "The premium is zero dollars ... maximum out of pocket")).toBe(1);
  });

  it("rejects reordered, stitched-together or too-short quotes", () => {
    expect(check(19, "your doctors lose you'll the best plan")).toBe(0); // same words, wrong order
    expect(check(19, "this is the best plan next year")).toBe(0); // not contiguous
    expect(check(19, "best")).toBe(0);
    expect(check(99, "anything")).toBe(0); // no such utterance
  });

  it("accepts quotes of redacted text the AI actually saw", () => {
    const u = { id: 0, start: 0, end: 3, speaker: "1", role: "customer" as const, text: "My number is 555-123-4567 okay" };
    const one = new Map([[0, u]]);
    expect(verifyEvidence({ criterionId: "x", status: "pass", scorePercent: 100, rationale: "", evidence: [{ utteranceId: 0, quote: "my number is [PHONE] okay" }], coaching: null }, one)).toHaveLength(1);
  });
});

describe("live session", () => {
  it("coaches in real time: countdown warning, violation alert, then overdue", () => {
    const live = new LiveSession(medicareRubric);
    expect(live.tick(10)).toEqual([]);
    const warn = live.tick(46);
    expect(warn.some((a) => a.criterionId === "tpmo_disclaimer" && a.level === "critical")).toBe(true);
    const alerts = live.addUtterance(u(0, 47, "agent", "Honestly you have to decide today, this offer expires tonight."));
    expect(alerts.some((a) => a.criterionId === "no_pressure" && a.level === "warning")).toBe(true);
    const overdue = live.tick(61);
    expect(overdue.some((a) => a.criterionId === "tpmo_disclaimer" && a.message.startsWith("Missed"))).toBe(true);
    const item = live.checklist().find((i) => i.criterionId === "tpmo_disclaimer")!;
    expect(item.state).toBe("overdue");
    expect(live.provisionalScore()).toBeLessThan(100);
  });

  it("replays the sample call with the right checklist", () => {
    const live = new LiveSession(medicareRubric);
    for (const utt of sampleTranscript.utterances) live.addUtterance(utt);
    live.tick(sampleTranscript.durationSec);
    const states = Object.fromEntries(live.checklist().map((i) => [i.criterionId, i.state]));
    expect(states.tpmo_disclaimer).toBe("done");
    expect(states.no_superlatives).toBe("violated");
    expect(states.no_government_affiliation).toBe("done");
  });
});

describe("support code", () => {
  it("redacts identifiers but keeps 1-800-MEDICARE", () => {
    const out = redactPHI("My MBI is 1EG4-TE5-MK73, SSN 123-45-6789, call me at (555) 123-4567 or 1-800-MEDICARE, born 04/12/1951.");
    expect(out).toContain("[MBI]");
    expect(out).toContain("[SSN]");
    expect(out).toContain("[PHONE]");
    expect(out).toContain("[DATE]");
    expect(out).toContain("1-800-MEDICARE");
    expect(out).not.toContain("6789");
  });

  it("builds a reviewer prompt with ids, clock times and rule hints", () => {
    const p = buildUserPrompt({ rubric: medicareRubric, utterances: sampleTranscript.utterances, durationSec: 159, findings: runRules(medicareRubric, sampleTranscript.utterances, 159) });
    expect(p).toContain("u19 [1:50] AGENT:");
    expect(p).toContain("### no_superlatives");
    expect(p).toContain("flagged at u19");
    expect(p).not.toContain("### recording_notice"); // rules-only items are not sent to the AI
  });

  it("computes talk ratio and questions", () => {
    const m = computeMetrics(sampleTranscript.utterances, sampleTranscript.durationSec);
    expect(m.agentTalkPct).toBeGreaterThan(50);
    expect(m.agentQuestions).toBeGreaterThanOrEqual(4);
    expect(m.agentTalkPct + m.customerTalkPct).toBeCloseTo(100, 0);
  });

  it("general rubric compiles and scores", async () => {
    const r = await scoreCall({ rubric: generalSalesRubric, transcript: sampleTranscript, reviewer: null });
    expect(r.criteria).toHaveLength(generalSalesRubric.criteria.length);
  });
});
