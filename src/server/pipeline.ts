import fs from "node:fs/promises";
import type { Calibration, CallDetail, CallReview, CriterionOverride, ReviewEvent, ReviewedStatus, Rubric, ScoreResult, Transcript } from "../core/types.js";
import { applyOverrides, applyReview, calibrate, emptyReview } from "../engine/review.js";
import { scoreCall } from "../engine/score.js";
import { builtInRubrics } from "../rubrics/index.js";
import { applyRoleMap, swapRoles } from "../stt/roles.js";
import { transcribeRecording, wavChannels } from "../stt/deepgram.js";
import type { AppConfig } from "./config.js";
import type { ExportCall } from "./csv.js";
import type { FinalSummary, FinalTotals, StoredCall, Store } from "./db.js";

/** A review request that can't be applied; `status` is the HTTP status to return. */
export class ReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const REVIEWED: ReadonlySet<string> = new Set<ReviewedStatus>(["pass", "partial", "fail", "na"]);

/**
 * Background processing for recorded calls: transcribe -> score -> save.
 * A small in-process queue caps concurrency so a bulk upload of 200 calls
 * doesn't hammer the STT/AI providers. Swap for a real queue (BullMQ, SQS)
 * when running more than one server.
 */
export class Pipeline {
  private queue: Array<() => Promise<void>> = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private store: Store,
    private config: AppConfig,
    private concurrency = 3,
  ) {
    // Keep every rubric version in use (built-in and custom, including ones saved before version
    // history existed), and save final totals for
    // calls scored before totals were stored, while their rubric version is still known.
    for (const r of [...builtInRubrics, ...store.listRubrics()]) store.archiveRubric(r);
    for (const c of store.callsMissingTotals()) {
      const rubric = this.rubricFor(c.autoResult);
      if (rubric) store.setFinalTotals(c.id, totalsOf(applyReview(rubric, c.autoResult, c.review)));
    }
  }

  rubrics(): Rubric[] {
    const custom = this.store.listRubrics();
    const ids = new Set(custom.map((r) => r.id));
    return [...builtInRubrics.filter((r) => !ids.has(r.id)), ...custom];
  }

  rubric(id: string): Rubric | undefined {
    return this.rubrics().find((r) => r.id === id);
  }

  /** The exact rubric version a result was graded with (current, or a kept older version). */
  rubricVersion(id: string, version: string): Rubric | undefined {
    const current = this.rubric(id);
    if (current?.version === version) return current;
    return this.store.rubricVersion(id, version) ?? undefined;
  }

  private rubricFor(auto: ScoreResult): Rubric | undefined {
    return this.rubricVersion(auto.rubricId, auto.rubricVersion);
  }

  /** Recorded audio: transcribe, then score. */
  enqueueAudio(callId: string, rubric: Rubric, separateChannelsHint: boolean | null): void {
    this.enqueue(callId, async () => {
      const call = this.store.getCall(callId);
      if (!call?.audioPath) throw new Error("Audio file missing.");
      if (!this.config.deepgram) {
        throw new Error("Transcription is not configured. Add DEEPGRAM_API_KEY, or upload a transcript instead of audio.");
      }
      const audio = await fs.readFile(call.audioPath);
      const separate = separateChannelsHint ?? wavChannels(audio) === 2;
      const transcript = await transcribeRecording(this.config.deepgram, audio, call.audioMime ?? "application/octet-stream", separate);
      if (!transcript.utterances.length) throw new Error("No speech was detected in the recording.");
      this.store.saveTranscript(callId, transcript);
      await this.score(callId, rubric, transcript);
    });
  }

  /** Transcript already available (import or live call): score it. */
  enqueueScore(callId: string, rubric: Rubric, transcript: Transcript): void {
    this.store.saveTranscript(callId, transcript);
    this.enqueue(callId, () => this.score(callId, rubric, transcript));
  }

  /** Re-run scoring, optionally with another rubric or with agent/customer swapped. */
  rescore(callId: string, rubric: Rubric, swap: boolean): boolean {
    const call = this.store.getCall(callId);
    if (!call) return false;
    this.store.setProcessing(callId, rubric.id);
    if (!call.transcript) {
      if (call.audioPath) {
        this.enqueueAudio(callId, rubric, null);
        return true;
      }
      this.store.saveError(callId, "Nothing to score: no transcript or audio.");
      return true;
    }
    let transcript = call.transcript;
    if (swap) {
      const roleMap = swapRoles(transcript.roleMap);
      transcript = { ...transcript, roleMap, utterances: applyRoleMap(transcript.utterances, roleMap) };
    }
    this.enqueueScore(callId, rubric, transcript);
    return true;
  }

  /** Resolves when the queue is empty (tests, graceful shutdown). */
  idle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async score(callId: string, rubric: Rubric, transcript: Transcript): Promise<void> {
    const result = await scoreCall({ rubric, transcript, reviewer: this.config.reviewer });
    this.saveScored(callId, rubric, result);
  }

  // -------------------------------------------------------------------------
  // Scoring results + human review
  // -------------------------------------------------------------------------

  /**
   * Store a fresh automatic result. Existing overrides carry over when the
   * rubric is unchanged (a reviewer's decision shouldn't vanish on a rescore);
   * they are dropped, with a log entry, if the call was rescored against a
   * different rubric. Returns the final (reviewed) result.
   */
  saveScored(callId: string, rubric: Rubric, auto: ScoreResult): ScoreResult {
    // Read, log and save in one transaction: the append-only log must never record cleared
    // decisions that the call itself still carries (or miss ones it no longer does).
    return this.store.transaction(() => {
      const previous = this.store.getCall(callId);
      let review = previous?.review ?? null;
      // Decisions only carry over to the same rubric *version*: a new version may change what an item means.
      const sameVersion = review?.rubricId === rubric.id && (!previous?.autoResult || previous.autoResult.rubricVersion === auto.rubricVersion);
      if (review && !sameVersion) {
        const dropped = Object.keys(review.overrides).length;
        if (dropped) {
          this.log(
            callId,
            "revert",
            null,
            null,
            null,
            "system",
            `Rescored with rubric "${rubric.id}" v${auto.rubricVersion}; ${dropped} review decision(s) made against "${review.rubricId}"${previous?.autoResult ? ` v${previous.autoResult.rubricVersion}` : ""} were cleared.`,
          );
        }
        review = null;
      }
      const final = applyReview(rubric, auto, review);
      this.store.saveResult(callId, auto, review, summaryOf(final, review));
      return final;
    });
  }

  /** Everything the call page needs, with human overrides applied to the result. */
  detail(callId: string): CallDetail | null {
    const call = this.store.getCall(callId);
    if (!call) return null;
    return this.toDetail(call);
  }

  /** Every call's final (reviewed) result, without transcripts or review logs, for spreadsheets. */
  exportRows(): ExportCall[] {
    return this.store.listForExport().map((call) => {
      const { autoResult: _r, audioPath: _a, audioMime: _m, transcript: _t, review: _v, ...rest } = call;
      return { ...rest, result: this.finalResult(call) };
    });
  }

  setOverride(callId: string, criterionId: string, input: { status: string; fraction?: number; note: string; reviewer: string }): CallDetail {
    const { call, rubric, auto, review } = this.editable(callId);
    const criterion = auto.criteria.find((c) => c.criterionId === criterionId);
    if (!criterion || !rubric.criteria.some((c) => c.id === criterionId)) throw new ReviewError(404, "That item isn't part of this call's rubric.");
    if (!REVIEWED.has(input.status)) throw new ReviewError(400, "Choose pass, partial, fail or N/A.");
    const note = input.note.trim();
    const reviewer = input.reviewer.trim();
    if (!reviewer) throw new ReviewError(400, "Add your name so the decision is attributed.");
    if (!note) throw new ReviewError(400, "Add a short note explaining the decision.");
    const override: CriterionOverride = {
      status: input.status as ReviewedStatus,
      ...(input.status === "partial" && input.fraction !== undefined ? { fraction: Math.min(0.9, Math.max(0.1, input.fraction)) } : {}),
      note,
      reviewer,
      at: new Date().toISOString(),
    };
    const before = review.overrides[criterionId]?.status ?? criterion.status;
    review.overrides[criterionId] = override;
    return this.commitReview(call, rubric, auto, review, () => this.log(callId, "override", criterionId, before, override.status, reviewer, note));
  }

  clearOverride(callId: string, criterionId: string, reviewer: string, note: string): CallDetail {
    const { call, rubric, auto, review } = this.editable(callId);
    const prior = review.overrides[criterionId];
    if (!prior) throw new ReviewError(404, "There's no review decision on that item to undo.");
    if (!reviewer.trim()) throw new ReviewError(400, "Add your name so the change is attributed.");
    delete review.overrides[criterionId];
    return this.commitReview(call, rubric, auto, review, () =>
      this.log(callId, "revert", criterionId, null, null, reviewer.trim(), note.trim() || `Undid "${prior.status}" by ${prior.reviewer}; back to the automatic grade.`),
    );
  }

  /** Sign off: only once nothing is left waiting for a person. Locked calls can't be edited or rescored. */
  lock(callId: string, reviewer: string, note: string): CallDetail {
    const { call, rubric, auto, review } = this.editable(callId);
    if (!reviewer.trim()) throw new ReviewError(400, "Add your name to sign off.");
    const final = applyReview(rubric, auto, review);
    if (final.needsReview.length) {
      throw new ReviewError(409, `Grade the ${final.needsReview.length} item(s) still waiting for review before signing off.`);
    }
    review.locked = true;
    review.lockedBy = reviewer.trim();
    review.lockedAt = new Date().toISOString();
    const lockedBy = review.lockedBy;
    return this.commitReview(call, rubric, auto, review, () => this.log(callId, "lock", null, null, null, lockedBy, note.trim() || "Signed off."));
  }

  /** Reopen a signed-off call. A reason is required and recorded in the audit log. */
  unlock(callId: string, reviewer: string, note: string): CallDetail {
    const call = this.store.getCall(callId);
    if (!call) throw new ReviewError(404, "Call not found.");
    if (!call.review?.locked) throw new ReviewError(409, "This call isn't signed off.");
    if (!reviewer.trim() || !note.trim()) throw new ReviewError(400, "Add your name and the reason for reopening.");
    const rubric = call.autoResult ? this.rubricFor(call.autoResult) : undefined;
    if (!rubric || !call.autoResult) throw new ReviewError(409, "The rubric version this call was graded with is no longer available.");
    const review: CallReview = { ...call.review, locked: false, lockedBy: null, lockedAt: null };
    return this.commitReview(call, rubric, call.autoResult, review, () => this.log(callId, "unlock", null, null, null, reviewer.trim(), note.trim()));
  }

  isLocked(callId: string): boolean {
    return Boolean(this.store.getCall(callId)?.review?.locked);
  }

  calibration(rubricId: string): Calibration | null {
    const rubric = this.rubric(rubricId);
    return rubric ? calibrate(rubric, this.store.lockedCalls(rubricId)) : null;
  }

  private editable(callId: string): { call: StoredCall; rubric: Rubric; auto: ScoreResult; review: CallReview } {
    const call = this.store.getCall(callId);
    if (!call) throw new ReviewError(404, "Call not found.");
    if (call.status !== "scored" || !call.autoResult) throw new ReviewError(409, "This call hasn't finished scoring yet.");
    const rubric = this.rubricFor(call.autoResult);
    if (!rubric) throw new ReviewError(409, "The rubric version this call was graded with is no longer available.");
    const review = call.review && call.review.rubricId === rubric.id ? structuredClone(call.review) : emptyReview(rubric.id);
    if (review.locked) throw new ReviewError(409, `Signed off by ${review.lockedBy}. Reopen it to make changes.`);
    return { call, rubric, auto: call.autoResult, review };
  }

  /** Log the review event and save the review together, so the audit trail and the grade can't disagree. */
  private commitReview(call: StoredCall, rubric: Rubric, auto: ScoreResult, review: CallReview, logEvent: () => void): CallDetail {
    const final = applyReview(rubric, auto, review);
    this.store.transaction(() => {
      logEvent();
      this.store.saveReview(call.id, review, summaryOf(final, review));
    });
    return this.detail(call.id)!;
  }

  private log(
    callId: string,
    action: ReviewEvent["action"],
    criterionId: string | null,
    fromStatus: ReviewEvent["fromStatus"],
    toStatus: ReviewEvent["toStatus"],
    reviewer: string,
    note: string,
  ): void {
    this.store.addReviewEvent({ callId, action, criterionId, fromStatus, toStatus, reviewer, note, at: new Date().toISOString() });
  }

  private toDetail(call: StoredCall): CallDetail {
    const { autoResult: _r, audioPath: _a, audioMime: _m, ...rest } = call;
    return { ...rest, result: this.finalResult(call), reviewLog: this.store.reviewLog(call.id) };
  }

  /**
   * Automatic result + human overrides. Re-totalled only against the rubric version the call was
   * graded with; if that rubric has since been edited or deleted, the overrides are still shown
   * per item and the headline score/compliance come from the totals saved when the review was made.
   */
  private finalResult(call: StoredCall): ScoreResult | null {
    const auto = call.autoResult;
    if (!auto) return null;
    const rubric = this.rubricFor(auto);
    if (rubric) return applyReview(rubric, auto, call.review);
    const criteria = applyOverrides(auto, call.review);
    if (criteria === auto.criteria) return auto;
    // The complete reviewed totals were saved when the review was made; use them as a whole.
    if (call.finalTotals) return { ...auto, criteria, ...call.finalTotals };
    // Rows saved before totals were stored: best effort from the list columns.
    const status = new Map(criteria.map((c) => [c.criterionId, c.status]));
    const compliance = call.compliance ?? auto.compliance;
    return {
      ...auto,
      criteria,
      score: call.score ?? auto.score,
      compliance,
      passed: compliance === "pass" && auto.passed,
      criticalFailures: auto.criticalFailures.filter((id) => status.get(id) === "fail" || status.get(id) === "partial"),
      needsReview: auto.needsReview.filter((id) => status.get(id) === "needs_review"),
    };
  }

  private enqueue(callId: string, job: () => Promise<void>): void {
    this.queue.push(async () => {
      try {
        await job();
      } catch (err) {
        this.store.saveError(callId, err instanceof Error ? err.message : String(err));
      }
    });
    this.drain();
  }

  private drain(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void job().finally(() => {
        this.running--;
        this.drain();
        if (!this.running && !this.queue.length) this.idleWaiters.splice(0).forEach((r) => r());
      });
    }
  }
}

function totalsOf(final: ScoreResult): FinalTotals {
  return { score: final.score, passed: final.passed, compliance: final.compliance, criticalFailures: final.criticalFailures, needsReview: final.needsReview };
}

function summaryOf(final: ScoreResult, review: CallReview | null): FinalSummary {
  const touched = review && (review.locked || Object.keys(review.overrides).length > 0);
  return {
    totals: totalsOf(final),
    score: final.score,
    compliance: final.compliance,
    openReviewItems: final.needsReview.length,
    reviewState: review?.locked ? "locked" : touched ? "in_review" : "auto",
  };
}
