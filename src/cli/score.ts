import fs from "node:fs/promises";
import path from "node:path";
import type { Rubric } from "../core/types.js";
import { parseRubric } from "../engine/rubric-schema.js";
import { reviewerFromEnv } from "../engine/reviewer.js";
import { scoreCall } from "../engine/score.js";
import { formatClock } from "../engine/text.js";
import { builtInRubrics } from "../rubrics/index.js";
import { deepgramFromEnv, transcribeRecording, wavChannels } from "../stt/deepgram.js";
import { importTranscript } from "../stt/import.js";

/**
 * Score calls from the command line — handy for batch back-testing a folder of recordings.
 *   npm run score -- call1.mp3 call2.vtt [--rubric medicare-tpmo | --rubric ./my-rubric.json] [--json]
 */
const args = process.argv.slice(2);
const json = args.includes("--json");
const rIdx = args.indexOf("--rubric");
const rubricArg = rIdx >= 0 ? args[rIdx + 1] : "medicare-tpmo";
const files = args.filter((a, i) => !a.startsWith("--") && (rIdx < 0 || i !== rIdx + 1));

if (!files.length) {
  console.error("Usage: npm run score -- <audio-or-transcript files...> [--rubric <id|file.json>] [--json]");
  process.exit(2);
}

async function loadRubric(arg: string): Promise<Rubric> {
  const builtIn = builtInRubrics.find((r) => r.id === arg);
  if (builtIn) return builtIn;
  return parseRubric(JSON.parse(await fs.readFile(arg, "utf8")));
}

const rubric = await loadRubric(rubricArg!);
const reviewer = reviewerFromEnv();
const deepgram = deepgramFromEnv();
const MIME: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".webm": "audio/webm", ".flac": "audio/flac" };

let failures = 0;
for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  let transcript;
  if ([".txt", ".vtt", ".srt", ".json"].includes(ext)) {
    transcript = importTranscript(await fs.readFile(file, "utf8"), file);
  } else {
    if (!deepgram) throw new Error("Set DEEPGRAM_API_KEY to transcribe audio files.");
    const audio = await fs.readFile(file);
    transcript = await transcribeRecording(deepgram, audio, MIME[ext] ?? "application/octet-stream", wavChannels(audio) === 2);
  }
  const result = await scoreCall({ rubric, transcript, reviewer });
  if (!result.passed) failures++;
  if (json) {
    console.log(JSON.stringify({ file, result }));
    continue;
  }
  console.log(`\n${file}  —  score ${result.score}/100 · compliance ${result.compliance.toUpperCase()} · ${result.passed ? "PASS" : "FAIL"}`);
  for (const c of result.criteria) {
    if (c.status === "pass" || c.status === "na") continue;
    const name = rubric.criteria.find((x) => x.id === c.criterionId)?.name ?? c.criterionId;
    const ev = c.evidence[0] ? `  [${formatClock(c.evidence[0].start)}] “${c.evidence[0].quote.slice(0, 90)}”` : "";
    console.log(`  ${c.status.toUpperCase().padEnd(12)} ${name}${ev}`);
  }
  if (result.aiError) console.log(`  (AI review failed: ${result.aiError})`);
}
process.exit(failures ? 1 : 0);
