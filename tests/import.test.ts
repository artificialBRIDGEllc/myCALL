import { describe, expect, it } from "vitest";
import { SegmentAssembler, wavChannels } from "../src/stt/deepgram.js";
import { importTranscript } from "../src/stt/import.js";
import { header } from "../src/server/wav.js";

describe("transcript import", () => {
  it("parses a Zoom-style VTT with named speakers and infers the agent", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Dana Brooks: Thanks for calling, my name is Dana, I'm a licensed agent.

2
00:00:04.500 --> 00:00:06.000
Pat Lee: Hi Dana.

3
00:00:06.100 --> 00:00:09.000
Dana Brooks: This call is being recorded.`;
    const t = importTranscript(vtt, "meeting.vtt");
    expect(t.utterances).toHaveLength(3);
    expect(t.roleMap).toEqual({ "Dana Brooks": "agent", "Pat Lee": "customer" });
    expect(t.utterances[2]!.start).toBe(6.1);
  });

  it("parses plain text with Agent/Customer labels and timestamps", () => {
    const t = importTranscript("[00:05] Customer: I have a question\n[00:09] Agent: Sure, how can I help?\nThis continues.", "call.txt");
    expect(t.utterances.map((u) => u.role)).toEqual(["customer", "agent"]);
    expect(t.utterances[1]!.text).toBe("Sure, how can I help? This continues.");
    expect(t.utterances[0]!.end).toBeLessThanOrEqual(9);
  });

  it("parses a stereo Deepgram JSON by channel", () => {
    const json = JSON.stringify({
      results: {
        channels: [{}, {}],
        utterances: [
          { start: 0, end: 2, channel: 1, transcript: "hello?" },
          { start: 2, end: 5, channel: 0, transcript: "Hi, my name is Al, a licensed agent." },
        ],
      },
    });
    const t = importTranscript(json, "dg.json");
    expect(t.roleMap).toEqual({ ch0: "agent", ch1: "customer" });
  });

  it("rejects empty input", () => {
    expect(() => importTranscript("   ")).toThrow(/empty/);
  });
});

describe("deepgram streaming assembler", () => {
  it("joins is_final fragments until speech_final, per channel", () => {
    const out: string[] = [];
    const a = new SegmentAssembler({ onUtterance: (s) => out.push(`${s.channel}:${s.text}`), onInterim: () => undefined });
    const res = (ch: number, t: string, sf: boolean) => ({ type: "Results", channel_index: [ch, 2], start: 0, duration: 1, is_final: true, speech_final: sf, channel: { alternatives: [{ transcript: t }] } });
    a.handle(res(0, "we do not offer", false));
    a.handle(res(1, "uh huh", false));
    a.handle(res(0, "every plan", true));
    a.handle({ type: "UtteranceEnd", channel: [1, 2] });
    expect(out).toEqual(["0:we do not offer every plan", "1:uh huh"]);
  });

  it("reads WAV channel counts", () => {
    expect(wavChannels(Buffer.concat([header(16000, 2, 0), Buffer.alloc(4)]))).toBe(2);
    expect(wavChannels(Buffer.from("ID3 not a wav at all, definitely more than forty four bytes long"))).toBeNull();
  });
});
