import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Criterion, Rubric, Utterance } from "../core/types.js";
import type { RuleFinding } from "./rules.js";
import { formatClock } from "./text.js";
import { redactPHI } from "./redact.js";

// ---------------------------------------------------------------------------
// Output contract. Every judgment must point at utterance ids; the scorer
// verifies each quote against the real transcript before trusting it.
// ---------------------------------------------------------------------------

const AiEvidence = z.object({
  utteranceId: z.number().int(),
  quote: z.string().describe("Verbatim words copied from that utterance."),
});

const AiCriterion = z.object({
  criterionId: z.string(),
  status: z.enum(["pass", "partial", "fail", "na"]),
  scorePercent: z.number().describe("0-100. Use for partial credit; 100 for pass, 0 for fail."),
  rationale: z.string().describe("One or two sentences a QA manager can verify."),
  evidence: z.array(AiEvidence),
  coaching: z.string().nullable().describe("What the agent should do differently, or null if nothing."),
});

export const AiReviewSchema = z.object({
  criteria: z.array(AiCriterion),
  summary: z.string().describe("3-5 sentence neutral summary of the call."),
  callOutcome: z.string().describe("Short label, e.g. 'Enrolled in MAPD', 'Follow-up scheduled', 'Not interested'."),
  customerSentiment: z.enum(["positive", "neutral", "negative", "mixed"]),
  strengths: z.array(z.object({ point: z.string(), utteranceId: z.number().int().nullable() })),
  improvements: z.array(
    z.object({
      point: z.string(),
      utteranceId: z.number().int().nullable(),
      betterPhrasing: z.string().nullable().describe("Exact words the agent could have said instead."),
    }),
  ),
  extracted: z.array(z.object({ fieldId: z.string(), value: z.string().nullable(), utteranceId: z.number().int().nullable() })),
});

export type AiReview = z.infer<typeof AiReviewSchema>;

export interface ReviewInput {
  rubric: Rubric;
  utterances: Utterance[];
  durationSec: number;
  findings: RuleFinding[];
}

/** Anything that can review a transcript against a rubric. Swappable for tests or other vendors. */
export interface AiReviewer {
  readonly name: string;
  review(input: ReviewInput): Promise<AiReview>;
}

export class ReviewerError extends Error {}

// ---------------------------------------------------------------------------
// Prompt construction (pure, unit-testable)
// ---------------------------------------------------------------------------

const REVIEWER_INSTRUCTIONS = `You are a senior call-quality and compliance reviewer. You grade one recorded or live sales call against the rubric criteria listed below and return JSON in the required schema.

How to judge:
- Grade only the criteria listed. Return exactly one entry per criterion id.
- Every "pass", "partial" or "fail" that depends on something said must cite evidence: the utterance id(s) and a short verbatim quote copied from that utterance. Never invent or paraphrase quotes. If you cannot find supporting words, say so in the rationale instead of citing.
- "required" criteria: pass only if the transcript shows the item was actually said (a materially equivalent paraphrase is acceptable). If a time limit is given, the evidence must fall inside it. Absence of evidence is a fail, not a pass.
- "prohibited" criteria: pass means no violation. Fail only with cited evidence of the violation. Consider context: negation ("I can't promise..."), quoting a rule, or a customer saying it are not agent violations.
- "judgment" criteria: assess the skill across the whole call. Use "na" only when the criterion's guidance says the situation did not occur.
- Each criterion includes a deterministic "rules pre-check": phrase matches found by keyword rules. They are reliable when they found an exact phrase, but can miss paraphrases and can flag negated or harmless uses. Use them as hints, not verdicts.
- Speaker labels (AGENT/CUSTOMER) come from audio channels or diarization and are usually right; if the content clearly shows a label is swapped, judge by content and mention it.
- Some personal identifiers are redacted as [MBI], [SSN], [PHONE], [DATE]. That is expected.
- Coaching must be specific and kind: what to say or do next time, in the agent's own words where possible.
- Be calibrated and consistent: the same call should get the same grades every time.`;

function describeCriterion(c: Criterion, f: RuleFinding | undefined): string {
  const lines = [
    `### ${c.id} — ${c.name}`,
    `kind: ${c.kind} | severity: ${c.severity}${c.withinSeconds !== undefined ? ` | must occur within first ${c.withinSeconds}s` : ""} | speaker checked: ${c.speaker ?? "agent"}`,
    `what it means: ${c.description}`,
  ];
  if (c.citation) lines.push(`rule: ${c.citation}`);
  if (c.components?.length) lines.push(`elements: ${c.components.map((k) => `${k.id} = ${k.label}`).join("; ")}`);
  if (c.guidance) lines.push(`guidance: ${c.guidance}`);
  if (f) {
    const hits = f.evidence.map((e) => `u${e.utteranceId}${e.componentId ? ` (${e.componentId})` : ""}`).join(", ") || "none";
    if (c.kind === "prohibited") {
      lines.push(`rules pre-check: ${f.evidence.length ? `flagged at ${hits}${f.negatedOnly ? " (appears negated)" : ""}` : "no prohibited phrases found"}`);
    } else {
      const comp = f.componentsTotal ? ` elements found: ${f.componentsFound.join(", ") || "none"} of ${f.componentsTotal}.` : "";
      lines.push(
        `rules pre-check: ${f.satisfied ? `found at ${hits}` : f.late ? `found only AFTER the time limit (${hits})` : "exact phrasing not found"}.${comp}`,
      );
    }
  }
  return lines.join("\n");
}

/** Stable per-rubric system prompt (cache-friendly: no per-call content). */
export function buildSystemPrompt(rubric: Rubric): string {
  const extract = rubric.extract?.length
    ? `\n\n## Fields to extract\nReturn one "extracted" entry per field id (value null if not mentioned):\n${rubric.extract
        .map((f) => `- ${f.id}: ${f.label}${f.hint ? ` — ${f.hint}` : ""}`)
        .join("\n")}`
    : "";
  return `${REVIEWER_INSTRUCTIONS}\n\n# Rubric: ${rubric.name} (v${rubric.version})\n${rubric.description}${extract}`;
}

export function aiCriteria(rubric: Rubric): Criterion[] {
  return rubric.criteria.filter((c) => c.evaluator !== "rules");
}

export function buildUserPrompt(input: ReviewInput): string {
  const byId = new Map(input.findings.map((f) => [f.criterionId, f]));
  const criteria = aiCriteria(input.rubric)
    .map((c) => describeCriterion(c, byId.get(c.id)))
    .join("\n\n");
  const transcript = input.utterances
    .map((u) => `u${u.id} [${formatClock(u.start)}] ${u.role.toUpperCase()}: ${redactPHI(u.text)}`)
    .join("\n");
  return `## Criteria to grade\n\n${criteria}\n\n## Transcript (${formatClock(input.durationSec)} long)\n\n${transcript}`;
}

// ---------------------------------------------------------------------------
// Claude implementation
// ---------------------------------------------------------------------------

export interface ClaudeReviewerOptions {
  apiKey?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  client?: Anthropic;
}

export class ClaudeReviewer implements AiReviewer {
  readonly name: string;
  private client: Anthropic;
  private effort: ClaudeReviewerOptions["effort"];

  constructor(opts: ClaudeReviewerOptions = {}) {
    this.name = opts.model ?? "claude-opus-5";
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.effort = opts.effort;
  }

  async review(input: ReviewInput): Promise<AiReview> {
    const response = await this.client.beta.messages.parse({
      model: this.name,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      ...(this.effort ? { output_config: { effort: this.effort, format: betaZodOutputFormat(AiReviewSchema) } } : { output_config: { format: betaZodOutputFormat(AiReviewSchema) } }),
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: buildSystemPrompt(input.rubric), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    });

    if (response.stop_reason === "refusal") throw new ReviewerError("The AI reviewer declined to review this call.");
    if (response.stop_reason === "max_tokens") throw new ReviewerError("The AI review was cut off (call too long for one pass).");
    if (!response.parsed_output) throw new ReviewerError("The AI reviewer returned output that did not match the schema.");
    return response.parsed_output;
  }
}

/** Build the default reviewer from environment variables, or null when no key is configured. */
export function reviewerFromEnv(env: NodeJS.ProcessEnv = process.env): AiReviewer | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  const effort = env.CLAUDE_EFFORT as ClaudeReviewerOptions["effort"] | undefined;
  return new ClaudeReviewer({ apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL || "claude-opus-5", effort });
}
