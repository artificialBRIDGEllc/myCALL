import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CallDetail, Calibration, CallReview, Rubric } from "../src/core/types.js";
import { applyReview, calibrate, emptyReview } from "../src/engine/review.js";
import { scoreCall } from "../src/engine/score.js";
import { builtInRubrics, medicareRubric } from "../src/rubrics/index.js";
import { sampleTranscript } from "../src/rubrics/sample-call.js";
import { buildApp, type App } from "../src/server/app.js";
import { Store } from "../src/server/db.js";
import { Pipeline } from "../src/server/pipeline.js";

describe("applyReview", () => {
  it("overrides grades, re-totals the score and compliance, and keeps the automatic grade visible", async () => {
    const auto = await scoreCall({ rubric: medicareRubric, transcript: sampleTranscript, reviewer: null });
    expect(auto.compliance).toBe("review");
    const review: CallReview = emptyReview(medicareRubric.id);
    for (const id of auto.needsReview) review.overrides[id] = { status: "pass", note: "Listened to the call.", reviewer: "Pat", at: "2026-09-27T00:00:00Z" };
    review.overrides.no_superlatives = { status: "pass", note: "Cited the plan's 5-star rating.", reviewer: "Pat", at: "2026-09-27T00:00:00Z" };
    const final = applyReview(medicareRubric, auto, review);
    expect(final.needsReview).toEqual([]);
    expect(final.compliance).toBe("pass");
    expect(final.score).toBeGreaterThan(auto.score);
    const sup = final.criteria.find((c) => c.criterionId === "no_superlatives")!;
    expect(sup).toMatchObject({ status: "pass", source: "human", rationale: "Cited the plan's 5-star rating." });
    expect(sup.review!.auto.status).toBe("fail");
    expect(sup.evidence.length).toBeGreaterThan(0); // the flagged words stay attached for the record
    // The automatic result object is never mutated.
    expect(auto.criteria.find((c) => c.criterionId === "no_superlatives")!.status).toBe("fail");
  });

  it("ignores overrides made against a different rubric", async () => {
    const auto = await scoreCall({ rubric: medicareRubric, transcript: sampleTranscript, reviewer: null });
    const review = { ...emptyReview("general-sales"), overrides: { no_pressure: { status: "pass" as const, note: "x", reviewer: "y", at: "z" } } };
    expect(applyReview(medicareRubric, auto, review)).toBe(auto);
  });
});

describe("calibrate", () => {
  it("counts agreement, false alarms, misses and human-resolved items on signed-off calls only", async () => {
    const auto = await scoreCall({ rubric: medicareRubric, transcript: sampleTranscript, reviewer: null });
    const at = "2026-09-27T00:00:00Z";
    const lockedA: CallReview = { ...emptyReview(medicareRubric.id), locked: true, lockedBy: "Pat", lockedAt: at, overrides: { no_superlatives: { status: "pass", note: "ok", reviewer: "Pat", at }, rapport: { status: "pass", note: "ok", reviewer: "Pat", at } } };
    const lockedB: CallReview = { ...emptyReview(medicareRubric.id), locked: true, lockedBy: "Pat", lockedAt: at, overrides: { recording_notice: { status: "fail", note: "Said after consent was needed.", reviewer: "Pat", at } } };
    const unlocked: CallReview = { ...emptyReview(medicareRubric.id), overrides: { no_pressure: { status: "pass", note: "x", reviewer: "Pat", at } } };
    const cal = calibrate(medicareRubric, [
      { auto, review: lockedA },
      { auto, review: lockedB },
      { auto, review: unlocked },
    ]);
    const row = (id: string) => cal.rows.find((r) => r.criterionId === id)!;
    expect(cal.lockedCalls).toBe(2);
    expect(row("no_superlatives")).toMatchObject({ decided: 2, agreed: 1, falseAlarms: 1, misses: 0, accuracy: 50 });
    expect(row("recording_notice")).toMatchObject({ decided: 2, agreed: 1, misses: 1, falseAlarms: 0 });
    expect(row("no_pressure")).toMatchObject({ decided: 2, agreed: 2, accuracy: 100 }); // unlocked call's change doesn't count
    expect(row("rapport")).toMatchObject({ decided: 0, resolvedByHuman: 1, accuracy: null });
  });
});

describe("review API", () => {
  let ctx: App;
  let base: string;
  let dataDir: string;
  const json = { "Content-Type": "application/json" };

  const call = async (id: string) => (await (await fetch(`${base}/api/calls/${id}`)).json()) as CallDetail;
  const send = (method: string, url: string, body: unknown) => fetch(`${base}${url}`, { method, headers: json, body: JSON.stringify(body) });

  async function newCall(): Promise<CallDetail> {
    const transcript = sampleTranscript.utterances.map((u) => `[${Math.floor(u.start / 60)}:${String(Math.floor(u.start % 60)).padStart(2, "0")}] ${u.role === "agent" ? "Agent" : "Customer"}: ${u.text}`).join("\n");
    const res = await send("POST", "/api/calls", { transcript, rubricId: "medicare-tpmo", title: "Review me" });
    const { id } = (await res.json()) as { id: string };
    for (let i = 0; i < 100; i++) {
      const c = await call(id);
      if (c.status !== "processing") return c;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mycall-review-"));
    process.env.LOG_LEVEL = "silent";
    ctx = await buildApp({ port: 0, host: "127.0.0.1", dataDir, apiToken: null, deepgram: null, reviewer: null, maxUploadMb: 5, webDir: null, demoSpeed: 100 });
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(ctx.app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps a reviewed call's totals when its rubric is edited afterwards", async () => {
    const base_ = (await (await fetch(`${base}/api/rubrics/medicare-tpmo`)).json()) as Rubric;
    const v1 = { ...base_, id: "custom-tpmo", name: "Custom TPMO", version: "1" };
    expect((await send("POST", "/api/rubrics", v1)).status).toBe(201);
    const transcript = sampleTranscript.utterances.map((u) => `${u.role === "agent" ? "Agent" : "Customer"}: ${u.text}`).join("\n");
    const { id } = (await (await send("POST", "/api/calls", { transcript, rubricId: "custom-tpmo" })).json()) as { id: string };
    for (let i = 0; i < 100 && (await call(id)).status === "processing"; i++) await new Promise((r) => setTimeout(r, 20));
    const reviewed = (await (await send("PUT", `/api/calls/${id}/review/no_pressure`, { status: "partial", fraction: 0.5, note: "Corrected it right after.", reviewer: "Pat" })).json()) as CallDetail;

    // v2 makes that item a critical compliance gate; the old call must not be re-judged by it.
    const v2 = { ...v1, version: "2", criteria: v1.criteria.map((c) => (c.id === "no_pressure" ? { ...c, severity: "critical" as const } : c)) };
    expect((await send("POST", "/api/rubrics", v2)).status).toBe(201);
    const after = await call(id);
    expect(after.result!.score).toBe(reviewed.result!.score);
    expect(after.result!.compliance).toBe(reviewed.result!.compliance);
    expect(after.result!.criticalFailures).not.toContain("no_pressure");
    expect(after.result!.criteria.find((c) => c.criterionId === "no_pressure")).toMatchObject({ status: "partial", source: "human" });

    // Deleting the rubric must not throw away the human decisions either.
    expect((await fetch(`${base}/api/rubrics/custom-tpmo`, { method: "DELETE" })).status).toBe(204);
    const orphaned = await call(id);
    expect(orphaned.result!.score).toBe(reviewed.result!.score);
    expect(orphaned.result!.criteria.find((c) => c.criterionId === "no_pressure")).toMatchObject({ status: "partial", source: "human" });
  });

  it("refuses to change a rubric without a new version, and keeps a reviewer's critical fail after the rubric is deleted", async () => {
    const base_ = (await (await fetch(`${base}/api/rubrics/medicare-tpmo`)).json()) as Rubric;
    const v1 = { ...base_, id: "strict-tpmo", name: "Strict TPMO", version: "1" };
    expect((await send("POST", "/api/rubrics", v1)).status).toBe(201);
    expect((await send("POST", "/api/rubrics", v1)).status).toBe(201); // re-saving identical content is fine
    const changed = { ...v1, criteria: v1.criteria.map((c) => (c.id === "recording_notice" ? { ...c, points: 99 } : c)) };
    expect((await send("POST", "/api/rubrics", changed)).status).toBe(409);

    const transcript = sampleTranscript.utterances.map((u) => `${u.role === "agent" ? "Agent" : "Customer"}: ${u.text}`).join("\n");
    const { id } = (await (await send("POST", "/api/calls", { transcript, rubricId: "strict-tpmo" })).json()) as { id: string };
    for (let i = 0; i < 100 && (await call(id)).status === "processing"; i++) await new Promise((r) => setTimeout(r, 20));
    // The TPMO disclaimer passed automatically; the reviewer fails it (a critical item).
    const reviewed = (await (await send("PUT", `/api/calls/${id}/review/tpmo_disclaimer`, { status: "fail", note: "Read too fast to be understood.", reviewer: "Pat" })).json()) as CallDetail;
    expect(reviewed.result).toMatchObject({ compliance: "fail", passed: false });
    expect(reviewed.result!.criticalFailures).toContain("tpmo_disclaimer");

    expect((await fetch(`${base}/api/rubrics/strict-tpmo`, { method: "DELETE" })).status).toBe(204);
    const orphaned = await call(id);
    expect(orphaned.result).toMatchObject({ compliance: "fail", passed: false, score: reviewed.result!.score });
    expect(orphaned.result!.criticalFailures).toContain("tpmo_disclaimer");
  });

  it("reviews an older call with the exact rubric version it was graded with", async () => {
    const base_ = (await (await fetch(`${base}/api/rubrics/medicare-tpmo`)).json()) as Rubric;
    const v1 = { ...base_, id: "versioned-tpmo", name: "Versioned TPMO", version: "1" };
    expect((await send("POST", "/api/rubrics", v1)).status).toBe(201);
    const transcript = sampleTranscript.utterances.map((u) => `${u.role === "agent" ? "Agent" : "Customer"}: ${u.text}`).join("\n");
    const { id } = (await (await send("POST", "/api/calls", { transcript, rubricId: "versioned-tpmo" })).json()) as { id: string };
    for (let i = 0; i < 100 && (await call(id)).status === "processing"; i++) await new Promise((r) => setTimeout(r, 20));

    // v2 drops "no_pressure" and makes "rapport" critical.
    const v2 = { ...v1, version: "2", criteria: v1.criteria.filter((c) => c.id !== "no_pressure").map((c) => (c.id === "rapport" ? { ...c, severity: "critical" as const } : c)) };
    expect((await send("POST", "/api/rubrics", v2)).status).toBe(201);

    // The v1 call can still be reviewed on an item v2 no longer has...
    expect((await send("PUT", `/api/calls/${id}/review/no_pressure`, { status: "pass", note: "Fair warning, not a scare tactic.", reviewer: "Pat" })).status).toBe(200);
    // ...and is judged by v1, where failing "rapport" is not a compliance failure.
    const r = (await (await send("PUT", `/api/calls/${id}/review/rapport`, { status: "fail", note: "Cold throughout.", reviewer: "Pat" })).json()) as CallDetail;
    expect(r.result!.criticalFailures).not.toContain("rapport");
  });

  it("clears review decisions when a call is rescored with a newer version of its rubric", async () => {
    const base_ = (await (await fetch(`${base}/api/rubrics/medicare-tpmo`)).json()) as Rubric;
    const v1 = { ...base_, id: "rescore-tpmo", name: "Rescore TPMO", version: "1" };
    expect((await send("POST", "/api/rubrics", v1)).status).toBe(201);
    const transcript = sampleTranscript.utterances.map((u) => `${u.role === "agent" ? "Agent" : "Customer"}: ${u.text}`).join("\n");
    const { id } = (await (await send("POST", "/api/calls", { transcript, rubricId: "rescore-tpmo" })).json()) as { id: string };
    for (let i = 0; i < 100 && (await call(id)).status === "processing"; i++) await new Promise((r) => setTimeout(r, 20));
    await send("PUT", `/api/calls/${id}/review/no_pressure`, { status: "pass", note: "Fair warning.", reviewer: "Pat" });

    // Same version: the decision survives a rescore.
    await send("POST", `/api/calls/${id}/rescore`, {});
    let after = await call(id);
    for (let i = 0; i < 100 && after.status === "processing"; i++) after = (await new Promise((r) => setTimeout(r, 20)), await call(id));
    expect(after.review?.overrides.no_pressure?.status).toBe("pass");

    // New version: it is cleared and the clearing is logged.
    expect((await send("POST", "/api/rubrics", { ...v1, version: "2", criteria: v1.criteria.map((c) => (c.id === "no_pressure" ? { ...c, severity: "critical" as const } : c)) })).status).toBe(201);
    await send("POST", `/api/calls/${id}/rescore`, {});
    after = await call(id);
    for (let i = 0; i < 100 && after.status === "processing"; i++) after = (await new Promise((r) => setTimeout(r, 20)), await call(id));
    expect(after.review).toBeNull();
    expect(after.reviewLog.at(-1)).toMatchObject({ reviewer: "system", action: "revert" });
    expect(after.reviewLog.at(-1)!.note).toContain("v2");
  });

  it("runs the full loop: grade open items, override, sign off, lock, reopen — all audited", async () => {
    const c = await newCall();
    expect(c.reviewState).toBe("auto");
    expect(c.openReviewItems).toBeGreaterThan(0);
    expect(c.result!.compliance).toBe("review");

    // Signing off is refused while items are still open.
    expect((await send("POST", `/api/calls/${c.id}/lock`, { reviewer: "Pat" })).status).toBe(409);
    // A decision needs a name and a note.
    expect((await send("PUT", `/api/calls/${c.id}/review/rapport`, { status: "pass", note: "", reviewer: "Pat" })).status).toBe(400);
    expect((await send("PUT", `/api/calls/${c.id}/review/nope`, { status: "pass", note: "x", reviewer: "Pat" })).status).toBe(404);

    for (const id of c.result!.needsReview) {
      const r = await send("PUT", `/api/calls/${c.id}/review/${id}`, { status: id === "objection_handling" ? "na" : "pass", note: "Reviewed the recording.", reviewer: "Pat" });
      expect(r.status).toBe(200);
    }
    const overridden = (await (await send("PUT", `/api/calls/${c.id}/review/no_pressure`, { status: "partial", fraction: 0.5, note: "Scare line, but corrected it right after.", reviewer: "Pat" })).json()) as CallDetail;
    expect(overridden.reviewState).toBe("in_review");
    expect(overridden.openReviewItems).toBe(0);
    const np = overridden.result!.criteria.find((x) => x.criterionId === "no_pressure")!;
    expect(np).toMatchObject({ status: "partial", fraction: 0.5, earned: 2.5, source: "human" });
    expect(np.review!.auto.status).toBe("fail");

    // List view reflects the final (reviewed) numbers.
    const list = (await (await fetch(`${base}/api/calls`)).json()) as Array<{ id: string; score: number; reviewState: string; openReviewItems: number }>;
    expect(list.find((x) => x.id === c.id)).toMatchObject({ score: overridden.result!.score, reviewState: "in_review", openReviewItems: 0 });

    const locked = (await (await send("POST", `/api/calls/${c.id}/lock`, { reviewer: "Pat", note: "QA complete." })).json()) as CallDetail;
    expect(locked.reviewState).toBe("locked");
    expect(locked.review).toMatchObject({ locked: true, lockedBy: "Pat" });

    // Locked means locked: no edits, no rescoring, no deleting.
    expect((await send("PUT", `/api/calls/${c.id}/review/rapport`, { status: "fail", note: "x", reviewer: "Sam" })).status).toBe(409);
    expect((await send("POST", `/api/calls/${c.id}/rescore`, {})).status).toBe(409);
    expect((await fetch(`${base}/api/calls/${c.id}`, { method: "DELETE" })).status).toBe(409);

    // Calibration now includes this call.
    const cal = (await (await fetch(`${base}/api/calibration/medicare-tpmo`)).json()) as Calibration;
    expect(cal.lockedCalls).toBe(1);
    expect(cal.rows.find((r) => r.criterionId === "no_pressure")).toMatchObject({ decided: 1, agreed: 0 });
    expect(cal.rows.find((r) => r.criterionId === "tpmo_disclaimer")).toMatchObject({ decided: 1, agreed: 1, accuracy: 100 });

    // Reopening needs a reason; then edits work again.
    expect((await send("POST", `/api/calls/${c.id}/unlock`, { reviewer: "Sam" })).status).toBe(400);
    const reopened = (await (await send("POST", `/api/calls/${c.id}/unlock`, { reviewer: "Sam", note: "Carrier asked for re-review." })).json()) as CallDetail;
    expect(reopened.reviewState).toBe("in_review");
    const reverted = (await (await send("DELETE", `/api/calls/${c.id}/review/no_pressure`, { reviewer: "Sam" })).json()) as CallDetail;
    expect(reverted.result!.criteria.find((x) => x.criterionId === "no_pressure")!.status).toBe("fail");

    const actions = reverted.reviewLog.map((e) => e.action);
    expect(actions.slice(-4)).toEqual(["override", "lock", "unlock", "revert"]);
    expect(reverted.reviewLog.find((e) => e.criterionId === "no_pressure" && e.action === "override")).toMatchObject({ fromStatus: "fail", toStatus: "partial", reviewer: "Pat" });

    // The export carries the final result, the untouched automatic result and the audit trail.
    const exp = (await (await fetch(`${base}/api/calls/${c.id}/export`)).json()) as { call: CallDetail; automaticResult: { criteria: Array<{ criterionId: string; status: string }> } };
    expect(exp.call.reviewLog.length).toBe(reverted.reviewLog.length);
    expect(exp.automaticResult.criteria.find((x) => x.criterionId === "rapport")!.status).toBe("needs_review");
  });

  it("keeps decisions across a rescore with the same rubric, and clears them (logged) for a different rubric", async () => {
    const c = await newCall();
    await send("PUT", `/api/calls/${c.id}/review/rapport`, { status: "pass", note: "Warm.", reviewer: "Pat" });
    await send("POST", `/api/calls/${c.id}/rescore`, {});
    let after: CallDetail = c;
    for (let i = 0; i < 100 && (after = await call(c.id)).status === "processing"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(after.result!.criteria.find((x) => x.criterionId === "rapport")!.status).toBe("pass");

    await send("POST", `/api/calls/${c.id}/rescore`, { rubricId: "general-sales" });
    for (let i = 0; i < 100 && (after = await call(c.id)).status === "processing"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(after.review).toBeNull();
    expect(after.reviewLog.at(-1)).toMatchObject({ reviewer: "system", action: "revert" });
  });

  it("makes the review log append-only at the database level", () => {
    const db = new DatabaseSync(path.join(dataDir, "mycall.db"));
    expect(() => db.exec("UPDATE review_events SET reviewer = 'someone else'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM review_events")).toThrow(/append-only/);
    db.close();
  });
});

describe("atomic audit writes", () => {
  let dir: string;
  let store: Store;
  let pipeline: Pipeline;
  const callId = "atomic-call";

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mycall-atomic-"));
    store = new Store(dir);
    pipeline = new Pipeline(store, { reviewer: null, deepgram: null } as never);
    store.createCall({ id: callId, title: "Atomic", agentName: null, source: "import", rubricId: medicareRubric.id });
    pipeline.saveScored(callId, medicareRubric, await scoreCall({ rubric: medicareRubric, transcript: sampleTranscript, reviewer: null }));
    pipeline.setOverride(callId, "no_pressure", { status: "pass", note: "Fair warning, not a scare tactic.", reviewer: "Pat" });
  });

  afterAll(() => {
    vi.restoreAllMocks();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes no revert event and keeps the old review when saving a cross-version rescore fails", async () => {
    const other = builtInRubrics.find((r) => r.id !== medicareRubric.id)!;
    const auto = await scoreCall({ rubric: other, transcript: sampleTranscript, reviewer: null });
    const reviewBefore = store.getCall(callId)!.review;
    const logBefore = store.reviewLog(callId);
    expect(reviewBefore?.overrides.no_pressure?.status).toBe("pass");

    const spy = vi.spyOn(store, "saveResult").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });
    expect(() => pipeline.saveScored(callId, other, auto)).toThrow(/disk I\/O error/);
    expect(spy).toHaveBeenCalledOnce();

    expect(store.reviewLog(callId)).toEqual(logBefore);
    expect(store.reviewLog(callId).some((e) => e.action === "revert")).toBe(false);
    expect(store.getCall(callId)!.review).toEqual(reviewBefore);
    expect(store.getCall(callId)!.autoResult!.rubricId).toBe(medicareRubric.id);

    // Once the database recovers, the same rescore commits both writes together.
    pipeline.saveScored(callId, other, auto);
    expect(store.getCall(callId)!.review).toBeNull();
    expect(store.reviewLog(callId).at(-1)).toMatchObject({ reviewer: "system", action: "revert" });
  });

  it("writes no review event when saving a review decision fails", async () => {
    pipeline.saveScored(callId, medicareRubric, await scoreCall({ rubric: medicareRubric, transcript: sampleTranscript, reviewer: null }));
    const logBefore = store.reviewLog(callId);
    const reviewBefore = store.getCall(callId)!.review;
    vi.spyOn(store, "saveReview").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });
    expect(() => pipeline.setOverride(callId, "rapport", { status: "fail", note: "Cold throughout.", reviewer: "Pat" })).toThrow(/disk I\/O error/);
    expect(store.reviewLog(callId)).toEqual(logBefore);
    expect(store.getCall(callId)!.review).toEqual(reviewBefore);
  });

  it("rolls back only the inner writes of a nested transaction the caller recovers from", () => {
    const logBefore = store.reviewLog(callId).length;
    const event = { callId, action: "override" as const, criterionId: null, fromStatus: null, toStatus: null, reviewer: "t", note: "n", at: "2026-11-10T00:00:00Z" };
    store.transaction(() => {
      store.addReviewEvent(event);
      expect(() =>
        store.transaction(() => {
          store.addReviewEvent(event);
          throw new Error("inner");
        }),
      ).toThrow("inner");
    });
    expect(store.reviewLog(callId).length).toBe(logBefore + 1);
    expect(() => store.transaction(async () => undefined)).toThrow(/synchronous/);
    expect(store.reviewLog(callId).length).toBe(logBefore + 1);
  });
});

describe("migration", () => {
  it("keeps custom rubrics saved before version history existed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mycall-rv-"));
    const store = new Store(dir);
    const custom = { ...medicareRubric, id: "legacy-custom", version: "7" };
    store.saveRubric(custom);
    const db = new DatabaseSync(path.join(dir, "mycall.db"));
    db.exec("DELETE FROM rubric_versions"); // as if saved by the old code
    db.close();
    expect(store.rubricVersion("legacy-custom", "7")).toBeNull();
    new Pipeline(store, { reviewer: null, deepgram: null } as never);
    expect(store.rubricVersion("legacy-custom", "7")).toMatchObject({ id: "legacy-custom", version: "7" });
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fills in saved totals for calls scored before totals were stored", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mycall-backfill-"));
    process.env.LOG_LEVEL = "silent";
    const opts = { port: 0, host: "127.0.0.1", dataDir: dir, apiToken: null, deepgram: null, reviewer: null, maxUploadMb: 5, webDir: null, demoSpeed: 100 };
    let ctx = await buildApp(opts);
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    let url = `http://127.0.0.1:${(ctx.app.server.address() as { port: number }).port}`;
    const transcript = sampleTranscript.utterances.map((u) => `${u.role === "agent" ? "Agent" : "Customer"}: ${u.text}`).join("\n");
    const { id } = (await (await fetch(`${url}/api/calls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript, rubricId: "medicare-tpmo" }) })).json()) as { id: string };
    for (let i = 0; i < 100; i++) {
      const c = (await (await fetch(`${url}/api/calls/${id}`)).json()) as CallDetail;
      if (c.status !== "processing") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await ctx.app.close();

    const db = new DatabaseSync(path.join(dir, "mycall.db"));
    db.exec("UPDATE calls SET final_json = NULL");
    db.close();

    ctx = await buildApp(opts); // startup backfills while the rubric version is known
    await ctx.app.close();
    const check = new DatabaseSync(path.join(dir, "mycall.db"));
    const row = check.prepare("SELECT final_json FROM calls WHERE id = ?").get(id) as { final_json: string | null };
    check.close();
    expect(JSON.parse(row.final_json!)).toMatchObject({ compliance: expect.any(String), score: expect.any(Number) });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("upgrades a database created before human review existed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mycall-mig-"));
    const db = new DatabaseSync(path.join(dir, "mycall.db"));
    db.exec(`CREATE TABLE calls (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, agent_name TEXT, source TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, duration_sec REAL, rubric_id TEXT NOT NULL, audio_path TEXT, audio_mime TEXT, score INTEGER, compliance TEXT, error TEXT,
      transcript_json TEXT, result_json TEXT);
      INSERT INTO calls (id, org_id, title, source, status, created_at, rubric_id, score, compliance) VALUES ('old', 'default', 'Old call', 'import', 'scored', '2026-01-01', 'medicare-tpmo', 80, 'pass');`);
    db.close();
    const store = new Store(dir);
    expect(store.listCalls()[0]).toMatchObject({ id: "old", reviewState: "auto", openReviewItems: 0, score: 80 });
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
