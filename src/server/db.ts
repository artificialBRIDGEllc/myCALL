import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CallDetail, CallRecord, ComplianceStatus, Rubric, ScoreResult, Transcript } from "../core/types.js";

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
    `);
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

  saveResult(id: string, r: ScoreResult): void {
    this.db
      .prepare(`UPDATE calls SET status = 'scored', result_json = ?, score = ?, compliance = ?, rubric_id = ?, error = NULL WHERE id = ? AND org_id = ?`)
      .run(JSON.stringify(r), r.score, r.compliance, r.rubricId, id, this.orgId);
  }

  saveError(id: string, message: string): void {
    this.db.prepare(`UPDATE calls SET status = 'error', error = ? WHERE id = ? AND org_id = ?`).run(message, id, this.orgId);
  }

  listCalls(limit = 200): CallRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, agent_name, source, status, created_at, duration_sec, rubric_id, audio_path, score, compliance, error
         FROM calls WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(this.orgId, limit) as unknown as CallRow[];
    return rows.map(toRecord);
  }

  getCall(id: string): (CallDetail & { audioPath: string | null; audioMime: string | null }) | null {
    const row = this.db.prepare(`SELECT * FROM calls WHERE id = ? AND org_id = ?`).get(id, this.orgId) as unknown as CallRow | undefined;
    if (!row) return null;
    return {
      ...toRecord(row),
      transcript: row.transcript_json ? (JSON.parse(row.transcript_json) as Transcript) : null,
      result: row.result_json ? (JSON.parse(row.result_json) as ScoreResult) : null,
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
  };
}
