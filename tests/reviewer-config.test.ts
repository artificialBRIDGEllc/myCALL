import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeReviewer, type ReviewInput, DEFAULT_CLAUDE_EFFORT, DEFAULT_CLAUDE_MODEL, reviewerFromEnv } from "../src/engine/reviewer.js";
import { builtInRubrics } from "../src/rubrics/index.js";

function capturingClient() {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push(params);
          return { stop_reason: "end_turn", parsed_output: { items: [] } };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("AI reviewer configuration", () => {
  it("is off without an API key", () => {
    expect(reviewerFromEnv({})).toBeNull();
  });

  it("defaults to the current Opus model", () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-5-5");
    expect(reviewerFromEnv({ ANTHROPIC_API_KEY: "test" })?.name).toBe("claude-opus-5-5");
    expect(reviewerFromEnv({ ANTHROPIC_API_KEY: "test", CLAUDE_MODEL: "claude-sonnet-5-5" })?.name).toBe("claude-sonnet-5-5");
  });

  it("rejects an unknown CLAUDE_EFFORT instead of sending it to the API", () => {
    expect(() => reviewerFromEnv({ ANTHROPIC_API_KEY: "test", CLAUDE_EFFORT: "extreme" })).toThrow(/CLAUDE_EFFORT/);
  });

  it("always sends an explicit effort (high unless overridden)", async () => {
    const rubric = builtInRubrics[0];
    const input: ReviewInput = { rubric, utterances: [], durationSec: 0, findings: [] };

    const a = capturingClient();
    await new ClaudeReviewer({ client: a.client }).review(input);
    expect((a.calls[0]?.output_config as { effort?: string })?.effort).toBe(DEFAULT_CLAUDE_EFFORT);
    expect(a.calls[0]?.model).toBe("claude-opus-5-5");

    const b = capturingClient();
    await new ClaudeReviewer({ client: b.client, effort: "medium" }).review(input);
    expect((b.calls[0]?.output_config as { effort?: string })?.effort).toBe("medium");
  });
});
