import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { CallDetail, LiveServerMessage } from "../src/core/types.js";
import { buildApp, type App } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { header } from "../src/server/wav.js";

/** A stand-in for Deepgram: REST prerecorded + WebSocket live, speaking its real message shapes. */
function startFakeDeepgram(): Promise<{ url: string; close: () => Promise<void>; lastQuery: () => string; failRest: (on: boolean) => void }> {
  let lastQuery = "";
  let restFails = false;
  const server = http.createServer((req, res) => {
    lastQuery = req.url ?? "";
    req.resume();
    req.on("end", () => {
      if (restFails) {
        res.statusCode = 503;
        res.end("unavailable");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (lastQuery.includes("multichannel=true")) {
        // Whole-file transcript of a stereo live recording: it also catches the line the stream missed.
        res.end(
          JSON.stringify({
            results: {
              channels: [{}, {}],
              utterances: [
                { start: 0, end: 3, channel: 0, transcript: "Hello, this is Sam, a licensed agent.", confidence: 0.98 },
                { start: 3, end: 6, channel: 0, transcript: "This call is being recorded. Honestly you have to decide today.", confidence: 0.97 },
                { start: 7, end: 9, channel: 1, transcript: "Um, okay, I guess.", confidence: 0.95 },
              ],
            },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          results: {
            channels: [{}],
            utterances: [
              { start: 0.5, end: 4, speaker: 1, transcript: "Hi, thanks for calling, my name is Jo, a licensed insurance agent. This call is recorded.", confidence: 0.98 },
              { start: 4.5, end: 6, speaker: 0, transcript: "Hi Jo.", confidence: 0.97 },
              { start: 6.5, end: 14, speaker: 1, transcript: "We do not offer every plan available in your area. We represent 4 organizations which offer 20 products in your area. Please contact Medicare.gov or 1-800-MEDICARE for all your options.", confidence: 0.95 },
            ],
          },
        }),
      );
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    lastQuery = req.url ?? "";
    let sent = false;
    ws.on("message", (data, isBinary) => {
      if (isBinary && !sent) {
        sent = true;
        const result = (channel: number, start: number, transcript: string, speechFinal: boolean) =>
          JSON.stringify({ type: "Results", channel_index: [channel, 2], start, duration: 3, is_final: true, speech_final: speechFinal, channel: { alternatives: [{ transcript, confidence: 0.9 }] } });
        ws.send(JSON.stringify({ type: "Results", channel_index: [0, 2], start: 0, duration: 1, is_final: false, channel: { alternatives: [{ transcript: "hello this is" }] } }));
        ws.send(result(0, 0, "Hello, this is Sam, a licensed agent.", false));
        ws.send(result(0, 3, "Honestly you have to decide today.", true));
        ws.send(result(1, 7, "Um, okay, I guess.", true));
        return;
      }
      if (!isBinary && JSON.parse(data.toString()).type === "CloseStream") ws.close();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, lastQuery: () => lastQuery, failRest: (on) => (restFails = on), close: () => new Promise((r) => { wss.close(); server.close(() => r()); }) });
    }),
  );
}

let fake: Awaited<ReturnType<typeof startFakeDeepgram>>;
let ctx: App;
let base: string;
let dataDir: string;

async function waitScored(id: string): Promise<CallDetail> {
  for (let i = 0; i < 100; i++) {
    const call = (await (await fetch(`${base}/api/calls/${id}`, { headers: auth })).json()) as CallDetail;
    if (call.status !== "processing") return call;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("timed out");
}
const auth = { Authorization: "Bearer test-token" };

beforeAll(async () => {
  fake = await startFakeDeepgram();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mycall-"));
  const config: AppConfig = {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    apiToken: "test-token",
    deepgram: { apiKey: "dg-test", model: "nova-3", language: "en-US", baseUrl: fake.url, mipOptOut: true },
    reviewer: null,
    maxUploadMb: 5,
    webDir: null,
    demoSpeed: 200,
  };
  process.env.LOG_LEVEL = "silent";
  ctx = await buildApp(config);
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(ctx.app.server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await ctx.app.close();
  await fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("API", () => {
  it("requires the API token", async () => {
    expect((await fetch(`${base}/api/calls`)).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const cfg = await (await fetch(`${base}/api/config`, { headers: auth })).json();
    expect(cfg).toMatchObject({ transcription: true, aiReviewer: null, authRequired: true });
  });

  it("scores an imported transcript (JSON)", async () => {
    const transcript = [
      "Agent: Hi, my name is Pat, I'm a licensed insurance agent and this call is being recorded.",
      "Customer: Okay.",
      "Agent: I'm calling from Medicare about your benefits.",
    ].join("\n");
    const res = await fetch(`${base}/api/calls`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, rubricId: "medicare-tpmo", title: "Imported", agentName: "Pat" }),
    });
    expect(res.status).toBe(202);
    const call = await waitScored(((await res.json()) as { id: string }).id);
    expect(call.status).toBe("scored");
    expect(call.transcript!.utterances[0]!.role).toBe("agent");
    const gov = call.result!.criteria.find((c) => c.criterionId === "no_government_affiliation")!;
    expect(gov.status).toBe("fail");
    expect(gov.evidence[0]!.quote).toContain("calling from Medicare");
    expect(call.result!.compliance).toBe("fail");

    const exp = await fetch(`${base}/api/calls/${call.id}/export`, { headers: auth });
    expect(exp.headers.get("x-content-sha256")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("transcribes an uploaded recording, detects the agent speaker, and serves the audio", async () => {
    const form = new FormData();
    form.append("rubricId", "medicare-tpmo");
    form.append("agentName", "Jo");
    form.append("file", new Blob([new Uint8Array(Buffer.from("ID3fake-mp3-bytes"))], { type: "audio/mpeg" }), "call.mp3");
    const res = await fetch(`${base}/api/calls`, { method: "POST", headers: auth, body: form });
    expect(res.status).toBe(202);
    const call = await waitScored(((await res.json()) as { id: string }).id);
    expect(call.status).toBe("scored");
    expect(fake.lastQuery()).toContain("diarize=true");
    expect(fake.lastQuery()).toContain("mip_opt_out=true");
    // Diarized speaker 1 says the agent lines -> detected as the agent.
    expect(call.transcript!.roleMap).toEqual({ "1": "agent", "0": "customer" });
    const tpmo = call.result!.criteria.find((c) => c.criterionId === "tpmo_disclaimer")!;
    expect(tpmo.status).toBe("pass");
    const audio = await fetch(`${base}/api/calls/${call.id}/audio`, { headers: auth });
    expect(audio.status).toBe(200);
    // The <audio> element uses a signed URL instead of the token.
    expect((await fetch(`${base}${await signed(`/api/calls/${call.id}/audio`)}`)).status).toBe(200);
    expect((await fetch(`${base}/api/calls/${call.id}/audio?token=test-token`)).status).toBe(401);

    // Swap speakers and rescore: the disclosures now belong to the customer, so they fail.
    await fetch(`${base}/api/calls/${call.id}/rescore`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ swapRoles: true }) });
    const again = await waitScored(call.id);
    expect(again.result!.criteria.find((c) => c.criterionId === "tpmo_disclaimer")!.status).toBe("fail");
  });

  it("rejects bad uploads and bad rubrics", async () => {
    const form = new FormData();
    form.append("rubricId", "medicare-tpmo");
    form.append("file", new Blob(["x"], { type: "application/x-msdownload" }), "virus.exe");
    expect((await fetch(`${base}/api/calls`, { method: "POST", headers: auth, body: form })).status).toBe(415);
    const bad = await fetch(`${base}/api/rubrics`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ id: "x" }) });
    expect(bad.status).toBe(400);
  });

  it("saves a custom rubric and lists it", async () => {
    const rubric = {
      id: "acme-intro",
      name: "Acme intro",
      version: "1",
      description: "",
      passThreshold: 70,
      sections: [{ id: "s", name: "S" }],
      criteria: [{ id: "hello", sectionId: "s", name: "Says hello", description: "Greets", points: 5, severity: "minor", kind: "required", evaluator: "rules", patterns: ["hello"] }],
    };
    const res = await fetch(`${base}/api/rubrics`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(rubric) });
    expect(res.status).toBe(201);
    const list = (await (await fetch(`${base}/api/rubrics`, { headers: auth })).json()) as Array<{ id: string }>;
    expect(list.map((r) => r.id)).toContain("acme-intro");
  });

  it("keeps showing and exporting a call against the rubric version it was graded with", async () => {
    const v1 = {
      id: "acme-versioned",
      name: "Acme versioned",
      version: "1",
      description: "",
      passThreshold: 70,
      sections: [{ id: "s", name: "S" }],
      criteria: [{ id: "hello", sectionId: "s", name: "Says hello", description: "Greets", points: 5, severity: "minor", kind: "required", evaluator: "rules", patterns: ["hello"] }],
    };
    const post = (r: object) => fetch(`${base}/api/rubrics`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(r) });
    expect((await post(v1)).status).toBe(201);
    const res = await fetch(`${base}/api/calls`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: "Agent: Hello there.\nCustomer: Hi.", rubricId: "acme-versioned" }),
    });
    const call = await waitScored(((await res.json()) as { id: string }).id);
    expect(call.result!.rubricVersion).toBe("1");

    // A newer version changes what the item is called; the old call must still use v1.
    expect((await post({ ...v1, version: "2", criteria: [{ ...v1.criteria[0], name: "Greets warmly" }] })).status).toBe(201);
    const current = (await (await fetch(`${base}/api/rubrics/acme-versioned`, { headers: auth })).json()) as { version: string };
    expect(current.version).toBe("2");

    const graded = await fetch(`${base}/api/rubrics/acme-versioned/versions/1`, { headers: auth });
    expect(graded.status).toBe(200);
    expect(((await graded.json()) as { criteria: Array<{ name: string }> }).criteria[0]!.name).toBe("Says hello");
    expect((await fetch(`${base}/api/rubrics/acme-versioned/versions/9`, { headers: auth })).status).toBe(404);

    const packet = (await (await fetch(`${base}/api/calls/${call.id}/export`, { headers: auth })).json()) as { rubric: { version: string } };
    expect(packet.rubric.version).toBe("1");
  });
});

async function signed(path: string): Promise<string> {
  const res = await fetch(`${base}/api/sign`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  return ((await res.json()) as { url: string }).url;
}

async function collectLive(start: object, audioFrames: Buffer[]): Promise<LiveServerMessage[]> {
  const ws = new WebSocket(`${base.replace("http", "ws")}${await signed("/api/live")}`);
  const msgs: LiveServerMessage[] = [];
  return new Promise((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify(start)));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as LiveServerMessage;
      msgs.push(m);
      if (m.type === "ready" && audioFrames.length) {
        for (const f of audioFrames) ws.send(f);
        setTimeout(() => ws.send(JSON.stringify({ type: "stop" })), 150);
      }
      if (m.type === "error") reject(new Error(m.message));
    });
    ws.on("close", () => resolve(msgs));
    ws.on("error", reject);
  });
}

describe("live calls", () => {
  it("rejects a live connection without a valid signature, and never accepts the raw token in the URL", async () => {
    for (const path of ["/api/live", "/api/live?token=test-token", "/api/live?exp=9999999999&sig=deadbeef"]) {
      const ws = new WebSocket(`${base.replace("http", "ws")}${path}`);
      const outcome = await new Promise<string>((resolve) => {
        ws.on("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
        ws.on("open", () => resolve("opened"));
        ws.on("error", () => resolve("error"));
      });
      expect(outcome).toBe("401");
    }
  });

  it("signed URLs are scoped to one path and expire", async () => {
    const url = await signed("/api/live");
    const sig = new URL(url, base).searchParams.get("sig");
    const expiredOrMoved = [`/api/calls?exp=9999999999&sig=${sig}`, `/api/live?exp=1&sig=${sig}`];
    for (const p of expiredOrMoved) expect((await fetch(`${base}${p}`)).status).toBe(401);
    const bad = await fetch(`${base}/api/sign`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ path: "/api/calls" }) });
    expect(bad.status).toBe(400);
  });

  it("streams stereo audio, separates agent/customer by channel, alerts, and scores at the end", async () => {
    const pcm = Buffer.alloc(16000 * 2 * 2 * 0.5); // 0.5 s of stereo silence
    const msgs = await collectLive({ type: "start", rubricId: "medicare-tpmo", sampleRate: 16000, channels: 2, agentName: "Sam" }, [pcm]);
    expect(fake.lastQuery()).toContain("multichannel=true");
    expect(fake.lastQuery()).toContain("mip_opt_out=true");
    const utts = msgs.filter((m) => m.type === "utterance").map((m) => (m as Extract<LiveServerMessage, { type: "utterance" }>).utterance);
    expect(utts.map((u) => [u.role, u.text])).toEqual([
      ["agent", "Hello, this is Sam, a licensed agent. Honestly you have to decide today."],
      ["customer", "Um, okay, I guess."],
    ]);
    const alert = msgs.find((m) => m.type === "alert" && m.alert.criterionId === "no_pressure");
    expect(alert).toBeTruthy();
    expect(msgs.some((m) => m.type === "interim")).toBe(true);
    const final = msgs.find((m) => m.type === "final") as Extract<LiveServerMessage, { type: "final" }>;
    expect(final.result.criteria.find((c) => c.criterionId === "no_pressure")!.status).toBe("fail");
    // The final grade uses the whole-recording transcript, which caught what the stream missed.
    expect(msgs.some((m) => m.type === "alert" && m.alert.criterionId === "recording_notice")).toBe(false);
    expect(final.result.criteria.find((c) => c.criterionId === "recording_notice")!.status).toBe("pass");

    // The call was recorded as a playable stereo WAV.
    const call = await waitScored(final.callId);
    expect(call.source).toBe("live");
    expect(call.hasAudio).toBe(true);
    const wav = Buffer.from(await (await fetch(`${base}/api/calls/${call.id}/audio`, { headers: auth })).arrayBuffer());
    expect(wav.subarray(0, 44)).toEqual(header(16000, 2, pcm.length));
    expect(call.transcript!.utterances.map((u) => [u.role, u.text])).toEqual([
      ["agent", "Hello, this is Sam, a licensed agent."],
      ["agent", "This call is being recorded. Honestly you have to decide today."],
      ["customer", "Um, okay, I guess."],
    ]);
  });

  it("falls back to the streamed transcript if re-transcribing the recording fails", async () => {
    fake.failRest(true);
    try {
      const pcm = Buffer.alloc(16000 * 2 * 2 * 0.5);
      const msgs = await collectLive({ type: "start", rubricId: "medicare-tpmo", sampleRate: 16000, channels: 2 }, [pcm]);
      const final = msgs.find((m) => m.type === "final") as Extract<LiveServerMessage, { type: "final" }>;
      expect(final.result.criteria.find((c) => c.criterionId === "no_pressure")!.status).toBe("fail");
      const call = await waitScored(final.callId);
      expect(call.transcript!.utterances.map((u) => u.text)).toEqual(["Hello, this is Sam, a licensed agent. Honestly you have to decide today.", "Um, okay, I guess."]);
    } finally {
      fake.failRest(false);
    }
  });

  it("runs the demo call without a microphone or STT", async () => {
    const msgs = await collectLive({ type: "start", rubricId: "medicare-tpmo", sampleRate: 16000, channels: 2, demo: true }, []);
    const final = msgs.find((m) => m.type === "final") as Extract<LiveServerMessage, { type: "final" }>;
    expect(final).toBeTruthy();
    expect(final.result.criteria.find((c) => c.criterionId === "no_superlatives")!.status).toBe("fail");
    expect(msgs.filter((m) => m.type === "alert").length).toBeGreaterThan(2);
  });
});

describe("results spreadsheet", () => {
  it("exports every call as CSV with one column per checklist item, and needs auth", async () => {
    expect((await fetch(`${base}/api/calls.csv`)).status).toBe(401);
    const transcript = "Agent: Hi, I'm calling from Medicare about your benefits.\nCustomer: Oh okay?\nAgent: You have to decide today.";
    const { id } = (await (await fetch(`${base}/api/calls`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ transcript, rubricId: "medicare-tpmo", title: "=HYPERLINK(\"x\")" }) })).json()) as { id: string };
    await waitScored(id);
    const res = await fetch(`${base}/api/calls.csv`, { headers: auth });
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    const [head, ...rows] = text.replace(/^﻿/, "").trim().split("\r\n");
    expect(head).toContain("Score,Compliance");
    expect(head).toContain("TPMO disclaimer within the first minute");
    const row = rows.find((r) => r.includes("HYPERLINK"))!;
    expect(row.startsWith(`"'=HYPERLINK(""x"")"`)).toBe(true); // never runs as a formula
    expect(row).toContain("fail");
    expect(row).toContain("No high-pressure or scare tactics: \"");
  });
});
