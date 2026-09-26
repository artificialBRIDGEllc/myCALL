/**
 * Shared domain types for myCALL. Used by the server, the scoring engine,
 * the web app and the browser extension, so keep this file dependency-free.
 */

export type Role = "agent" | "customer" | "unknown";

/** One finalized stretch of speech by one speaker. Times are seconds from call start. */
export interface Utterance {
  id: number;
  start: number;
  end: number;
  /** Raw speaker label from the STT provider ("0", "1", "ch0"...). */
  speaker: string;
  role: Role;
  text: string;
  confidence?: number;
}

export interface Transcript {
  utterances: Utterance[];
  durationSec: number;
  source: "deepgram" | "import" | "live" | "demo";
  /** Raw speaker label -> role, so a reviewer can swap sides and rescore. */
  roleMap: Record<string, Role>;
}

// ---------------------------------------------------------------------------
// Rubrics
// ---------------------------------------------------------------------------

/**
 * critical = a failure fails the whole call (compliance gate), regardless of score.
 * major / minor only affect the quality score through points.
 */
export type Severity = "critical" | "major" | "minor";

/**
 * required   – something the speaker MUST say (disclosures, discovery questions).
 * prohibited – something the speaker must NOT say.
 * judgment   – qualitative skill only an AI (or human) reviewer can assess.
 */
export type CriterionKind = "required" | "prohibited" | "judgment";

/**
 * rules  – deterministic phrase rules only (instant, free, works live).
 * llm    – AI reviewer only.
 * hybrid – rules run first (and live); the AI reviewer confirms or catches paraphrases.
 */
export type Evaluator = "rules" | "llm" | "hybrid";

export interface PhraseComponent {
  id: string;
  label: string;
  /** Regex sources matched against normalized text (lowercase, no punctuation). */
  patterns: string[];
}

export interface Criterion {
  id: string;
  sectionId: string;
  name: string;
  description: string;
  /** Regulation or policy the criterion enforces, shown to reviewers. */
  citation?: string;
  points: number;
  severity: Severity;
  kind: CriterionKind;
  evaluator: Evaluator;
  /** Whose speech is checked. Default "agent". */
  speaker?: Role | "any";
  /** Required/prohibited: phrase patterns (any match counts). */
  patterns?: string[];
  /** Required: multi-part statements; every component must be found (or minComponents). */
  components?: PhraseComponent[];
  /** Required: how many components earn full credit (default all). Partial credit below. */
  minComponents?: number;
  /** Required: must be completed within N seconds of call start. */
  withinSeconds?: number;
  /** Extra instructions for the AI reviewer. */
  guidance?: string;
  /** Short coaching line shown live when the item is missing or violated. */
  liveHint?: string;
}

export interface RubricSection {
  id: string;
  name: string;
  description?: string;
}

export interface ExtractField {
  id: string;
  label: string;
  hint: string;
}

export interface Rubric {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Minimum quality score to pass (0-100). */
  passThreshold: number;
  sections: RubricSection[];
  criteria: Criterion[];
  /** Structured data the AI should pull out of the call (CRM fields). */
  extract?: ExtractField[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface Evidence {
  utteranceId: number;
  start: number;
  end: number;
  role: Role;
  quote: string;
  /** Which component of a multi-part requirement this proves, if any. */
  componentId?: string;
}

export type CriterionStatus = "pass" | "partial" | "fail" | "na" | "needs_review";

export interface CriterionResult {
  criterionId: string;
  status: CriterionStatus;
  /** 0..1 share of points earned. Ignored for na / needs_review. */
  fraction: number;
  earned: number;
  maxPoints: number;
  evidence: Evidence[];
  rationale: string;
  source: "rules" | "llm" | "rules+llm";
  coaching?: string;
  /** Required criteria with components: which were found. */
  componentsFound?: string[];
}

export interface CallMetrics {
  durationSec: number;
  agentTalkPct: number;
  customerTalkPct: number;
  silencePct: number;
  agentWordsPerMinute: number;
  agentQuestions: number;
  longestAgentMonologueSec: number;
  interruptions: number;
}

export interface CoachingPoint {
  point: string;
  utteranceId: number | null;
  betterPhrasing?: string | null;
}

export interface ExtractedValue {
  field: string;
  label: string;
  value: string | null;
  utteranceId: number | null;
}

export type ComplianceStatus = "pass" | "fail" | "review";

export interface ScoreResult {
  rubricId: string;
  rubricVersion: string;
  /** 0-100 weighted quality score over criteria that could be assessed. */
  score: number;
  passed: boolean;
  compliance: ComplianceStatus;
  criticalFailures: string[];
  needsReview: string[];
  criteria: CriterionResult[];
  metrics: CallMetrics;
  summary: string | null;
  callOutcome: string | null;
  customerSentiment: "positive" | "neutral" | "negative" | "mixed" | null;
  strengths: CoachingPoint[];
  improvements: CoachingPoint[];
  extracted: ExtractedValue[];
  /** Which AI model reviewed the call, or null for rules-only scoring. */
  aiReviewer: string | null;
  aiError: string | null;
  scoredAt: string;
}

// ---------------------------------------------------------------------------
// Live events (server -> browser)
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  criterionId: string;
  name: string;
  kind: CriterionKind;
  severity: Severity;
  state: "pending" | "done" | "overdue" | "violated";
  /** Seconds left before a time-boxed requirement becomes overdue. */
  secondsLeft?: number;
  componentsFound?: string[];
  componentsTotal?: number;
  hint?: string;
}

export interface LiveAlert {
  id: string;
  at: number;
  criterionId: string;
  level: "critical" | "warning" | "info";
  message: string;
  quote?: string;
}

export type LiveServerMessage =
  | { type: "ready"; callId: string; demo: boolean }
  | { type: "interim"; role: Role; text: string }
  | { type: "utterance"; utterance: Utterance }
  | { type: "alert"; alert: LiveAlert }
  | { type: "checklist"; items: ChecklistItem[]; provisionalScore: number; metrics: CallMetrics; elapsed: number }
  | { type: "scoring" }
  | { type: "final"; callId: string; result: ScoreResult }
  | { type: "error"; message: string };

export type LiveClientMessage =
  | {
      type: "start";
      rubricId: string;
      title?: string;
      agentName?: string;
      sampleRate: number;
      channels: 1 | 2;
      /** Replay a sample call through the live engine (no microphone, no STT key). */
      demo?: boolean;
    }
  | { type: "stop" };

export interface CallRecord {
  id: string;
  title: string;
  agentName: string | null;
  source: "upload" | "live" | "import" | "demo";
  status: "processing" | "scored" | "error";
  createdAt: string;
  durationSec: number | null;
  rubricId: string;
  hasAudio: boolean;
  score: number | null;
  compliance: ComplianceStatus | null;
  error: string | null;
}

export interface CallDetail extends CallRecord {
  transcript: Transcript | null;
  result: ScoreResult | null;
}
