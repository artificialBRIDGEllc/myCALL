// Drives the human-review workflow in Chromium: grade open items, override one, sign off, check calibration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { buildApp } from "../dist/server/server/app.js";

const shots = process.env.SHOTS || os.tmpdir();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mycall-rev-"));
process.env.LOG_LEVEL = "silent";
const { app } = await buildApp({ port: 0, host: "127.0.0.1", dataDir, apiToken: null, deepgram: null, reviewer: null, maxUploadMb: 10, webDir: path.resolve("dist/web"), demoSpeed: 1 });
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${app.server.address().port}`;

const { sampleUtterances } = await import("../dist/server/rubrics/sample-call.js");
const transcript = sampleUtterances.map((u) => `[${Math.floor(u.start / 60)}:${String(Math.floor(u.start % 60)).padStart(2, "0")}] ${u.role === "agent" ? "Agent" : "Customer"}: ${u.text}`).join("\n");
const { id } = await (await fetch(`${base}/api/calls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript, rubricId: "medicare-tpmo", title: "Plan review — Dana", agentName: "Dana Brooks" }) })).json();
await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept("Needs re-check after carrier audit"));
await page.goto(`${base}/#/calls/${id}`);
await page.getByLabel("Reviewer name").fill("Pat Reviewer");
await page.screenshot({ path: `${shots}/review-1-open.png`, fullPage: true });

// Grade every open item as Pass (N/A for objection handling).
for (let guard = 0; guard < 20; guard++) {
  const grade = page.getByRole("button", { name: "Grade this item" }).first();
  const editors = page.getByPlaceholder("Why? (required — this goes in the audit log)");
  if ((await editors.count()) === 0 && (await grade.count()) === 0) break;
  if ((await editors.count()) === 0) await grade.click();
  const editor = editors.first();
  const box = editor.locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
  await box.getByRole("radio", { name: "Pass" }).click();
  await editor.fill("Listened to the recording; done well.");
  await box.getByRole("button", { name: "Save decision" }).click();
  await page.waitForTimeout(250);
}

// Override the superlative flag: reviewer decides it was a fair, sourced statement.
const card = page.locator("div.rounded-xl", { hasText: "No unsubstantiated superlatives" }).first();
await card.getByRole("button", { name: /Override this grade/ }).click();
await card.getByRole("radio", { name: "Partial" }).click();
await card.getByPlaceholder(/Why\?/).fill("Said 'best plan' but immediately tied it to her doctors and drugs.");
await card.getByRole("button", { name: "Save decision" }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "Sign off & lock" }).click();
await page.getByText("✓ Signed off").waitFor();
await page.getByRole("button", { name: /Show audit log/ }).click();
await page.screenshot({ path: `${shots}/review-2-signed.png`, fullPage: true });

await page.goto(`${base}/#/`);
await page.waitForTimeout(600);
await page.screenshot({ path: `${shots}/review-3-list.png` });
await page.goto(`${base}/#/calibration`);
await page.getByText("Signed-off calls").waitFor();
await page.screenshot({ path: `${shots}/review-4-calibration.png`, fullPage: true });

const detail = await (await fetch(`${base}/api/calls/${id}`)).json();
console.log(JSON.stringify({ reviewState: detail.reviewState, open: detail.openReviewItems, score: detail.result.score, compliance: detail.result.compliance, logEntries: detail.reviewLog.length, errors }, null, 1));
await browser.close();
await app.close();
process.exit(detail.reviewState === "locked" && !errors.length ? 0 : 1);
