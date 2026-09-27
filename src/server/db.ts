import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CallRecord, CallReview, ComplianceStatus, ReviewEvent, ReviewState, Rubric, ScoreResult, Transcript } from "../core/types.js";

/**
 * Storage on SQLite (built into Node 22 — no database server to run or pay for).
 * Every row carries org_id so the schema is ready for multi-tenant hosting;
 * swap this class for a Postgres implementation with the same methods to scale.
 */
export interface NewCall {
  id: string;
  title: string;
  agentName: string | null;
  source: CallRecord["source"];
  rubricId: string;
  audioPath?: string | null;
  audioMime?: string | null;
}

interface CallRow {
  id: string;
  title: string;
  agent_name: string | null;
  source: CallRecord["source"];
  status: CallRecord["status"];
  created_at: string;
  duration_sec: number | null;
  rubric_id: string;
  audio_path: string | null;
  audio_mime: string | null;
  score: number | null;
  compliance: ComplianceStatus | null;
  error: string | null;
  transcript_json: string | null;
  result_json: string | null;
  review_json: string | null;
  review_state: ReviewState | null;
  open_review: number | null;
}

/** A call as stored: the automatic result and the human review are kept separately. */
export interface StoredCall extends CallRecord {
  transcript: Transcript | null;
  autoResult: ScoreResult | null;
  review: CallReview | null;
  audioPath: string | null;
  audioMime: string | null;
}

/** The headline numbers shown in lists, taken from the final (reviewed) result. */
export interface FinalSummary {
  score: number;
  compliance: ComplianceStatus;
  openReviewItems: number;
  reviewState: ReviewState;
}

export class Store {
  private db: DatabaseSync;
  readonly audioDir: string;

  constructor(dataDir: string, private orgId = "default") {
    fs.mkdirSync(dataDir, { recursive: true });
    this.audioDir = path.join(dataDir, "audio");
    fs.mkdirSync(this.audioDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "mycall.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        title TEXT NOT NULL,
        agent_name TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        duration_sec REAL,
        rubric_id TEXT NOT NULL,
        audio_path TEXT,
        audio_mime TEXT,
        score INTEGER,
        compliance TEXT,
        error TEXT,
        transcript_json TEXT,
        result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS calls_org_created ON calls (org_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS rubrics (
        id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, id)
      );
      CREATE TABLE IF NOT EXISTS review_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        action TEXT NOT NULL,
        criterion_id TEXT,
        from_status TEXT,
        to_status TEXT,
        reviewer TEXT NOT NULL,
        note TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS review_events_call ON review_events (org_id, call_id, id);
      -- The review log is an audit trail: rows can be added, never changed or removed.
      CREATE TRIGGER IF NOT EXISTS review_events_no_update BEFORE UPDATE ON review_events
        BEGIN SELECT RAISE(ABORT, 'review_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS review_events_no_delete BEFORE DELETE ON review_events
        BEGIN SELECT RAISE(ABORT, 'review_events is append-only'); END;
    `);
    // Forward-only migrations for databases created before human review existed.
    const cols = new Set((this.db.prepare(`PRAGMA table_info(calls)`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has("review_json")) this.db.exec(`ALTER TABLE calls ADD COLUMN review_json TEXT`);
    if (!cols.has("review_state")) this.db.exec(`ALTER TABLE calls ADD COLUMN review_state TEXT NOT NULL DEFAULT 'auto'`);
    if (!cols.has("open_review")) this.db.exec(`ALTER TABLE calls ADD COLUMN open_review INTEGER NOT NULL DEFAULT 0`);
    // A server restart interrupts in-flight jobs; surface them instead of leaving them spinning.
    this.db
      .prepare(`UPDATE calls SET status = 'error', error = 'Interrupted by a server restart — click Rescore.' WHERE status = 'processing'`)
      .run();
  }

  createCall(c: NewCall): void {
    this.db
      .prepare(
        `INSERT INTO calls (id, org_id, title, agent_name, source, status, created_at, rubric_id, audio_path, audio_mime)
         VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)`,
      )
      .run(c.id, this.orgId, c.title, c.agentName, c.source, new Date().toISOString(), c.rubricId, c.audioPath ?? null, c.audioMime ?? null);
  }

  setAudio(id: string, audioPath: string, mime: string): void {
    this.db.prepare(`UPDATE calls SET audio_path = ?, audio_mime = ? WHERE id = ? AND org_id = ?`).run(audioPath, mime, id, this.orgId);
  }

  setProcessing(id: string, rubricId: string): void {
    this.db.prepare(`UPDATE calls SET status = 'processing', error = NULL, rubric_id = ? WHERE id = ? AND org_id = ?`).run(rubricId, id, this.orgId);
  }

  saveTranscript(id: string, t: Transcript): void {
    this.db
      .prepare(`UPDATE calls SET transcript_json = ?, duration_sec = ? WHERE id = ? AND org_id = ?`)
      .run(JSON.stringify(t), t.durationSec, id, this.orgId);
  }

  /** Save a new automatic result plus the review that now applies to it, and the final headline numbers. */
  saveResult(id: string, auto: ScoreResult, review: CallReview | null, final: FinalSummary): void {
    this.db
      .prepare(
        `UPDATE calls SET status = 'scored', result_json = ?, review_json = ?, score = ?, compliance = ?, open_review = ?, review_state = ?,
         rubric_id = ?, error = NULL WHERE id = ? AND org_id = ?`,
      )
      .run(JSON.stringify(auto), review ? JSON.stringify(review) : null, final.score, final.compliance, final.openReviewItems, final.reviewState, auto.rubricId, id, this.orgId);
  }

  saveReview(id: string, review: CallReview, final: FinalSummary): void {
    this.db
      .prepare(`UPDATE calls SET review_json = ?, score = ?, compliance = ?, open_review = ?, review_state = ? WHERE id = ? AND org_id = ?`)
      .run(JSON.stringify(review), final.score, final.compliance, final.openReviewItems, final.reviewState, id, this.orgId);
  }

  addReviewEvent(e: Omit<ReviewEvent, "id">): void {
    this.db
      .prepare(`INSERT INTO review_events (org_id, call_id, action, criterion_id, from_status, to_status, reviewer, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(this.orgId, e.callId, e.action, e.criterionId, e.fromStatus, e.toStatus, e.reviewer, e.note, e.at);
  }

  reviewLog(callId: string): ReviewEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM review_events WHERE org_id = ? AND call_id = ? ORDER BY id`)
      .all(this.orgId, callId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      callId: String(r.call_id),
      action: r.action as ReviewEvent["action"],
      criterionId: (r.criterion_id as string | null) ?? null,
      fromStatus: (r.from_status as ReviewEvent["fromStatus"]) ?? null,
      toStatus: (r.to_status as ReviewEvent["toStatus"]) ?? null,
      reviewer: String(r.reviewer),
      note: String(r.note),
      at: String(r.at),
    }));
  }

  /** Automatic results + reviews of every signed-off call for a rubric (calibration input). */
  lockedCalls(rubricId: string): Array<{ auto: ScoreResult; review: CallReview }> {
    const rows = this.db
      .prepare(`SELECT result_json, review_json FROM calls WHERE org_id = ? AND rubric_id = ? AND review_state = 'locked' AND result_json IS NOT NULL AND review_json IS NOT NULL`)
      .all(this.orgId, rubricId) as Array<{ result_json: string; review_json: string }>;
    return rows.map((r) => ({ auto: JSON.parse(r.result_json) as ScoreResult, review: JSON.parse(r.review_json) as CallReview }));
  }

  saveError(id: string, message: string): void {
    this.db.prepare(`UPDATE calls SET status = 'error', error = ? WHERE id = ? AND org_id = ?`).run(message, id, this.orgId);
  }

  listCalls(limit = 200): CallRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, agent_name, source, status, created_at, duration_sec, rubric_id, audio_path, score, compliance, error, review_state, open_review
         FROM calls WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(this.orgId, limit) as unknown as CallRow[];
    return rows.map(toRecord);
  }

  getCall(id: string): StoredCall | null {
    const row = this.db.prepare(`SELECT * FROM calls WHERE id = ? AND org_id = ?`).get(id, this.orgId) as unknown as CallRow | undefined;
    if (!row) return null;
    return {
      ...toRecord(row),
      transcript: row.transcript_json ? (JSON.parse(row.transcript_json) as Transcript) : null,
      autoResult: row.result_json ? (JSON.parse(row.result_json) as ScoreResult) : null,
      review: row.review_json ? (JSON.parse(row.review_json) as CallReview) : null,
      audioPath: row.audio_path,
      audioMime: row.audio_mime,
    };
  }

  deleteCall(id: string): string | null {
    const row = this.db.prepare(`SELECT audio_path FROM calls WHERE id = ? AND org_id = ?`).get(id, this.orgId) as { audio_path: string | null } | undefined;
    if (!row) return null;
    this.db.prepare(`DELETE FROM calls WHERE id = ? AND org_id = ?`).run(id, this.orgId);
    return row.audio_path ?? "";
  }

  listRubrics(): Rubric[] {
    const rows = this.db.prepare(`SELECT json FROM rubrics WHERE org_id = ? ORDER BY id`).all(this.orgId) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as Rubric);
  }

  saveRubric(r: Rubric): void {
    this.db
      .prepare(`INSERT INTO rubrics (id, org_id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`)
      .run(r.id, this.orgId, JSON.stringify(r), new Date().toISOString());
  }

  deleteRubric(id: string): boolean {
    return Number(this.db.prepare(`DELETE FROM rubrics WHERE id = ? AND org_id = ?`).run(id, this.orgId).changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(r: CallRow): CallRecord {
  return {
    id: r.id,
    title: r.title,
    agentName: r.agent_name,
    source: r.source,
    status: r.status,
    createdAt: r.created_at,
    durationSec: r.duration_sec,
    rubricId: r.rubric_id,
    hasAudio: Boolean(r.audio_path),
    score: r.score,
    compliance: r.compliance,
    error: r.error,
    reviewState: r.review_state ?? "auto",
    openReviewItems: r.open_review ?? 0,
  };
}
