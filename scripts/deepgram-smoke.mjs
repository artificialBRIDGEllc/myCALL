// Real-Deepgram smoke test. Needs DEEPGRAM_API_KEY; exits 0 with "skipped" without it.
//
// 1. Speaks the sample Medicare call aloud with Deepgram text-to-speech: agent and
//    customer get different voices, on separate channels of a 16 kHz stereo track.
// 2. Scores the same call four ways through the real server:
//      reference  the known-correct written transcript (no speech-to-text)
//      stereo     uploaded recording, one party per channel
//      mono       uploaded recording, both parties mixed (diarization + agent detection)
//      live       streamed over /api/live like the browser does
// 3. Fails if any speech path grades a phrase-rule item differently from the reference,
//    or puts the wrong person in the agent seat.
//
// Run after `npm run build`:  DEEPGRAM_API_KEY=... node scripts/deepgram-smoke.mjs
// Writes the full report to $REPORT (default deepgram-smoke-report.json).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { buildApp } from "../dist/server/server/app.js";
import { deepgramFromEnv } from "../dist/server/stt/deepgram.js";
import { sampleUtterances } from "../dist/server/rubrics/sample-call.js";

const RATE = 16000;
const RUBRIC = "medicare-tpmo";
const LIVE_SPEED = Number(process.env.LIVE_SPEED) || 2;
const VOICES = {
  agent: [process.env.AGENT_VOICE || "aura-2-thalia-en", "aura-asteria-en"],
  customer: [process.env.CUSTOMER_VOICE || "aura-2-apollo-en", "aura-orion-en"],
};

const dg = deepgramFromEnv();
if (!dg) {
  console.log("skipped: DEEPGRAM_API_KEY is not set");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Synthesize the call
// ---------------------------------------------------------------------------
async function speak(text, voices) {
  let last = "";
  for (const model of voices) {
    const res = await fetch(`${dg.baseUrl}/v1/speak?model=${model}&encoding=linear16&sample_rate=${RATE}&container=none`, {
      method: "POST",
      headers: { Authorization: `Token ${dg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    last = `${model}: ${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status === 401 || res.status === 403) break;
  }
  throw new Error(`Deepgram text-to-speech failed (${last})`);
}

const lines = sampleUtterances.map((u) => ({ role: u.role, start: u.start, text: u.text }));
const clips = [];
for (let i = 0; i < lines.length; i += 4) {
  clips.push(...(await Promise.all(lines.slice(i, i + 4).map((l) => speak(l.text, VOICES[l.role])))));
}

// Keep the script's timing, but never let a line start before the previous one ends.
let cursor = 0;
const placed = lines.map((l, i) => {
  const start = Math.max(l.start, cursor + 0.4);
  const seconds = clips[i].length / 2 / RATE;
  cursor = start + seconds;
  return { ...l, start, end: start + seconds, pcm: clips[i] };
});
const totalFrames = Math.ceil((cursor + 1) * RATE);
const stereo = Buffer.alloc(totalFrames * 4);
const mono = Buffer.alloc(totalFrames * 2);
for (const p of placed) {
  const ch = p.role === "agent" ? 0 : 1;
  const at = Math.round(p.start * RATE);
  for (let f = 0; f < p.pcm.length / 2; f++) {
    const s = p.pcm.readInt16LE(f * 2);
    stereo.writeInt16LE(s, (at + f) * 4 + ch * 2);
    mono.writeInt16LE(s, (at + f) * 2);
  }
}
const wav = (pcm, channels) => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};
console.log(`synthesized ${lines.length} lines, ${cursor.toFixed(1)} s of audio`);

// ---------------------------------------------------------------------------
// 2. Score it four ways
// ---------------------------------------------------------------------------
process.env.LOG_LEVEL = "silent";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mycall-dg-"));
const { app } = await buildApp({ port: 0, host: "127.0.0.1", dataDir, apiToken: null, reviewer: null, maxUploadMb: 50, webDir: null, demoSpeed: 1, deepgram: dg });
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${app.server.address().port}`;

async function waitScored(id) {
  for (let i = 0; i < 180; i++) {
    const d = await (await fetch(`${base}/api/calls/${id}`)).json();
    if (d.call?.status === "scored" || d.status === "scored") return d;
    if (d.call?.status === "error" || d.status === "error") throw new Error(`call ${id} failed: ${d.call?.error ?? d.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`call ${id} was not scored in time`);
}

async function upload(name, buf, separateChannels) {
  const form = new FormData();
  form.set("rubricId", RUBRIC);
  form.set("title", name);
  form.set("separateChannels", String(separateChannels));
  form.set("file", new Blob([buf], { type: "audio/wav" }), `${name}.wav`);
  const res = await fetch(`${base}/api/calls`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`${name} upload: ${res.status} ${await res.text()}`);
  return waitScored((await res.json()).id);
}

async function reference() {
  const transcript = lines.map((l) => `${l.role === "agent" ? "Agent" : "Customer"}: ${l.text}`).join("\n");
  const res = await fetch(`${base}/api/calls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcript, rubricId: RUBRIC, title: "reference" }) });
  if (!res.ok) throw new Error(`reference: ${res.status} ${await res.text()}`);
  return waitScored((await res.json()).id);
}

async function live() {
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/live`);
  const events = { utterances: 0, alerts: [], interims: 0, errors: [] };
  const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("live call timed out")), (cursor / LIVE_SPEED + 90) * 1000);
    ws.on("message", async (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === "ready") stream(m.callId);
      else if (m.type === "utterance") events.utterances++;
      else if (m.type === "interim") events.interims++;
      else if (m.type === "alert") events.alerts.push(m.alert.criterionId);
      else if (m.type === "error") events.errors.push(m.message);
      else if (m.type === "final") {
        clearTimeout(t);
        ws.close();
        resolve(m.callId);
      }
    });
    ws.on("error", reject);
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "start", rubricId: RUBRIC, title: "live", sampleRate: RATE, channels: 2 }));
  async function stream() {
    const chunk = RATE * 4 * 0.1; // 100 ms of stereo audio
    for (let o = 0; o < stereo.length; o += chunk) {
      ws.send(stereo.subarray(o, o + chunk));
      await new Promise((r) => setTimeout(r, 100 / LIVE_SPEED));
    }
    ws.send(JSON.stringify({ type: "stop" }));
  }
  const id = await done;
  return { detail: await waitScored(id), events };
}

const runs = {};
runs.reference = await reference();
[runs.stereo, runs.mono] = await Promise.all([upload("stereo", wav(stereo, 2), true), upload("mono", wav(mono, 1), false)]);
const liveRun = await live();
runs.live = liveRun.detail;

// ---------------------------------------------------------------------------
// 3. Compare
// ---------------------------------------------------------------------------
const rubric = (await (await fetch(`${base}/api/rubrics`)).json()).find((r) => r.id === RUBRIC);
const ruleIds = new Set(rubric.criteria.filter((c) => c.evaluator !== "llm").map((c) => c.id));
const statusOf = (d) => Object.fromEntries(d.result.criteria.map((c) => [c.criterionId, c.status]));
const ref = statusOf(runs.reference);
const problems = [];
const report = { audioSeconds: +cursor.toFixed(1), liveSpeed: LIVE_SPEED, liveEvents: liveRun.events, paths: {} };

for (const [name, d] of Object.entries(runs)) {
  const st = statusOf(d);
  const us = d.transcript.utterances;
  const agentText = us.filter((u) => u.role === "agent").map((u) => u.text).join(" ").toLowerCase();
  const customerText = us.filter((u) => u.role === "customer").map((u) => u.text).join(" ").toLowerCase();
  // Only the agent says "licensed insurance agent"; only the customer says "Thursday at two".
  const roleOk = agentText.includes("licensed") && !customerText.includes("licensed") && customerText.includes("thursday") && !agentText.includes("thursday at two");
  const diffs = [...ruleIds].filter((id) => st[id] !== ref[id]).map((id) => `${id}: ${st[id]} (reference ${ref[id]})`);
  report.paths[name] = {
    score: d.result.score,
    compliance: d.result.compliance,
    utterances: us.length,
    roleMap: d.transcript.roleMap,
    agentSeatCorrect: roleOk,
    ruleGradesDifferingFromReference: diffs,
    criteria: st,
    transcript: us.map((u) => `[${u.start.toFixed(1)}] ${u.role}: ${u.text}`),
  };
  if (name === "reference") continue;
  if (!roleOk) problems.push(`${name}: agent and customer are mixed up (roleMap ${JSON.stringify(d.transcript.roleMap)})`);
  for (const x of diffs) problems.push(`${name}: ${x}`);
}
if (liveRun.events.errors.length) problems.push(`live: server errors ${JSON.stringify(liveRun.events.errors)}`);
if (!liveRun.events.interims) problems.push("live: no interim captions arrived");
report.problems = problems;

fs.writeFileSync(process.env.REPORT || "deepgram-smoke-report.json", JSON.stringify(report, null, 2));
for (const [name, p] of Object.entries(report.paths)) {
  console.log(`\n== ${name}: score ${p.score}, ${p.compliance}, ${p.utterances} utterances, agent seat ${p.agentSeatCorrect ? "ok" : "WRONG"}`);
  for (const d of p.ruleGradesDifferingFromReference) console.log(`   differs: ${d}`);
  if (name !== "reference") for (const t of p.transcript) console.log(`   ${t}`);
}
console.log(`\nlive: ${liveRun.events.utterances} utterances, ${liveRun.events.interims} interim captions, alerts: ${liveRun.events.alerts.join(", ") || "none"}`);
console.log(problems.length ? `\nFAIL\n- ${problems.join("\n- ")}` : "\nPASS: every speech path matches the reference grades");
await app.close();
process.exit(problems.length ? 1 : 0);
