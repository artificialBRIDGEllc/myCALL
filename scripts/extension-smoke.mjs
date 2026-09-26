// Loads the built extension into Chromium and checks the service worker, popup and setup page.
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { chromium } from "playwright";

const ext = path.resolve("dist/extension");
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "mycall-ext-"));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const errors = [];
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10000 });
const id = new URL(sw.url()).host;
console.log("service worker:", sw.url());
for (const page of ["popup.html", "setup.html"]) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${page}: ${e}`));
  p.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(`${page}: ${m.text()}`));
  await p.goto(`chrome-extension://${id}/${page}`);
  await p.waitForTimeout(1500);
  console.log(page, "→", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 220));
}
console.log("errors:", errors);
await ctx.close();
