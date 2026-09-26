// Drives the real browser capture pipeline (mic -> AudioWorklet -> 16 kHz stereo PCM -> WebSocket)
// using Chromium's fake audio device, against a fake Deepgram that counts the audio it receives.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";
import { buildApp } from "../dist/server/server/app.js";

let received = 0;
let query = "";
const dg = http.createServer();
const wss = new WebSocketServer({ server: dg });
wss.on("connection", (ws, req) => {
  query = req.url;
  let said = false;
  ws.on("message", (d, bin) => {
    if (bin) {
      received += d.length;
      if (!said && received > 32000) {
        said = true;
        ws.send(JSON.stringify({ type: "Results", channel_index: [0, 2], start: 0.5, duration: 2, is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "This call is being recorded.", confidence: 0.9 }] } }));
      }
    } else if (JSON.parse(d.toString()).type === "CloseStream") ws.close();
  });
});
await new Promise((r) => dg.listen(0, "127.0.0.1", r));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mycall-cap-"));
process.env.LOG_LEVEL = "silent";
const { app } = await buildApp({
  port: 0, host: "127.0.0.1", dataDir, apiToken: null, reviewer: null, maxUploadMb: 10, webDir: path.resolve("dist/web"), demoSpeed: 1,
  deepgram: { apiKey: "x", model: "nova-3", language: "en-US", baseUrl: `http://127.0.0.1:${dg.address().port}` },
});
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/#/live`);
await page.getByText("Just my microphone").click();
await page.getByRole("button", { name: "Start live call" }).click();
await page.getByRole("button", { name: "End & score" }).waitFor();
await page.waitForTimeout(4000);
await page.getByRole("button", { name: "End & score" }).click();
await page.getByText("Open full report").waitFor({ timeout: 20000 });
const transcriptText = await page.locator("text=This call is being recorded.").count();
await browser.close();

const call = (await (await fetch(`${base}/api/calls`)).json())[0];
const wav = fs.readFileSync(path.join(dataDir, "audio", `${call.id}.wav`));
const seconds = received / (16000 * 2 * 2);
console.log(JSON.stringify({ deepgramQuery: query.includes("multichannel=true") && query.includes("sample_rate=16000"), bytesStreamed: received, secondsOfAudio: seconds.toFixed(2), wavChannels: wav.readUInt16LE(22), wavRate: wav.readUInt32LE(24), wavBytesMatch: wav.length - 44 === received, transcriptShown: transcriptText > 0, recordingNoticePassed: (await (await fetch(`${base}/api/calls/${call.id}`)).json()).result.criteria.find((c) => c.criterionId === "recording_notice").status, errors }, null, 1));
await app.close();
dg.close();
process.exit(seconds > 3 && seconds < 6 ? 0 : 1);
