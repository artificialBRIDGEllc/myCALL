# myCALL — call scoring for recorded and live calls

myCALL listens to sales calls and grades them, in two ways:

- **Past calls.** Upload recordings or transcripts, one at a time or in bulk, and get a scored report for each.
- **Live calls in the browser.** While an agent is on a call in a web dialer, Zoom, Meet or Teams, myCALL coaches them in real time. It shows a checklist, countdowns for time-limited disclosures, and instant alerts on risky phrases. When the call ends it saves a fully scored report.

Every grade is backed by **the exact words and the timestamp**. Click a finding to jump to that moment in the recording. Nothing is graded on vibes, and the AI is never allowed to invent evidence.

It ships with a **Medicare / CMS-TPMO compliance rubric**, which covers:
- the TPMO disclaimer within the first minute
- scope of appointment
- no claims of government affiliation
- no superlatives, pressure or "free money" claims
- needs analysis
- informed enrollment

It also ships with a **general sales rubric**. You can add your own rubrics as JSON.

> Try it without any API keys: run the app, open **Live call**, press **Run demo call**.

---

## How scoring works

```
 audio / transcript ──► speech-to-text (Deepgram, speakers separated)
                              │
                              ▼
        ┌────────────── phrase-rule engine ──────────────┐   instant · free · runs live
        │ required disclosures (with time limits)       │
        │ prohibited phrases (negation-aware)            │
        └───────────────────────┬────────────────────────┘
                                ▼
        AI reviewer (Claude) — judgment skills, paraphrases,     only at end of call
        summary, coaching, CRM fields — every claim must cite
        utterance ids; quotes are verified against the transcript
                                ▼
        merge policy (fail-closed) ──► score 0-100 + compliance pass / fail / review
```

**Three kinds of criteria**
- **required**: things the agent must say.
- **prohibited**: things the agent must not say.
- **judgment**: skills like rapport and listening.

**Three ways to evaluate them**
- **rules**: phrase patterns only.
- **llm**: the AI reviewer only.
- **hybrid**: phrase rules first, confirmed by the AI reviewer.

**Compliance is a gate, not an average.** A failed *critical* item fails the call whatever its score.

**Fail-closed**
- A required disclosure with no evidence is a fail.
- If the AI claims evidence that isn't in the transcript, the item goes to human review.
- If the AI clears a flagged phrase on a critical item, the item goes to human review.
- If the AI is unavailable, judgment items are marked "needs review", never passed silently.

**Speaker separation**
- **Live calls** capture the agent's mic and the call tab on **separate audio channels**, so we always know who said what.
- **Live call final grade.** When a live call ends, the saved recording is transcribed again in one pass, and the final grade uses that. Streaming is used only for in-call coaching: in real-key tests it dropped a word or two per call (once from the TPMO disclaimer), while whole-file transcription matched the script every time. This costs about half a cent more per call. If it fails, the grade falls back to the streamed transcript.
- **Stereo recordings** use one channel per party.
- **Mono recordings** use diarization, plus automatic agent detection. A **Swap speakers** button fixes wrong guesses.

**Privacy**
- The AI reviewer only sees the transcript. MBI, SSN, phone numbers, card numbers, emails and dates are redacted first.
- Deepgram and Anthropic keys stay on the server. Browsers and the extension never see them.

## Human review and calibration

Automatic grading is a first pass. People make the final call, and their decisions tune the system.

1. **Grade what's open.** Every call lists the items the automatic grader couldn't decide. Without an AI reviewer that's all the judgment skills; with one it's only the uncertain ones. A reviewer picks Pass / Partial / Fail / N/A and must write a note.
2. **Override anything.** Every automatic grade has an "Override" option. The original grade stays visible next to the human one, and the score and compliance gate are recalculated.
3. **Sign off & lock.** This is only possible once nothing is left open. A locked call can't be edited, rescored or deleted. Reopening it requires a reason.
4. **Audit trail.** Every decision, sign-off and reopen is logged with who, when and why. The log is append-only at the database level, and it's included in the evidence export alongside the untouched automatic result.
5. **Calibration** (`/#/calibration`). For each criterion, it shows how often reviewers agreed with the automatic grade on signed-off calls, plus false alarms (flagged, but a reviewer cleared it) and misses (passed, but a reviewer failed it). It also suggests what to tune. Use it to tighten phrase patterns until the automatic grade can be trusted.

Reviewer names are entered on the page and remembered per browser. There are no user accounts yet, so names aren't verified. Put SSO in front of the app if attribution must be authenticated.

API: `PUT/DELETE /api/calls/:id/review/:criterionId`, `POST /api/calls/:id/lock`, `POST /api/calls/:id/unlock`, `GET /api/calibration/:rubricId`.

## Run it

Requires Node 22.13 or newer.

```bash
npm install
cp .env.example .env        # add DEEPGRAM_API_KEY / ANTHROPIC_API_KEY / MYCALL_API_TOKEN
npm run build
npm start                   # http://localhost:8787
```

- **Development:** `npm run dev` runs the API on :8787 and Vite on :5173.
- **Docker:**
  ```bash
  docker build -t mycall . && docker run -p 8787:8787 -v mycall-data:/data --env-file .env mycall
  ```

| Variable | Needed for |
|---|---|
| `DEEPGRAM_API_KEY` | Audio uploads and live calls. Transcript uploads and the demo work without it. |
| `ANTHROPIC_API_KEY` | AI review of judgment skills, paraphrase confirmation, summary, coaching and CRM fields. Default model is `claude-opus-5`; set `CLAUDE_MODEL=claude-sonnet-5` for lower cost per call. |
| `MYCALL_API_TOKEN` | **Required before exposing the server.** Every API call must present it. |

## Chrome extension (live calls without screen-share prompts)

The web app's **Live call** page works in any Chromium browser: pick the call's tab, and tick "share tab audio". The extension is smoother. One click captures the current tab, and it keeps working while the agent switches tabs.

```bash
npm run build:extension     # → dist/extension
```

1. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and choose `dist/extension`.
2. Open the extension's **Setup** page. Enter the server address and token, then click **Allow microphone**. Click **Save**, and when Chrome asks, allow access to your server. The extension only ever asks for that one site, never all websites.
3. On a call tab, click the myCALL icon, then **Score this tab's call**.

## Formats

- **Audio:** mp3, wav, m4a, ogg, webm, flac (and more).
- **Transcripts:**
  - WebVTT/SRT (Zoom, Teams and Meet exports)
  - plain text lines like `Agent: …` / `Customer: …` (with optional `[mm:ss]`)
  - Deepgram JSON

**Command line** (batch back-testing):

```bash
npm run score -- calls/*.mp3 --rubric medicare-tpmo
```

It exits non-zero if any call fails.

## API

| Method & path | What it does |
|---|---|
| `POST /api/calls` | Multipart `file` + `rubricId` (+ `title`, `agentName`, `separateChannels`), or JSON `{transcript, rubricId}`. Returns `{id}`. Processing happens in the background. |
| `GET /api/calls`, `GET /api/calls/:id` | List calls, or get one call's detail (transcript + result). |
| `POST /api/calls/:id/rescore` | `{rubricId?, swapRoles?}` |
| `POST /api/sign` | `{path}` returns a short-lived signed URL for audio, export or the live WebSocket (places that can't send an Authorization header). The token itself never goes in a URL. |
| `GET /api/calls/:id/audio` | Recording (supports seeking). |
| `GET /api/calls/:id/export` | Evidence packet (JSON) with an `X-Content-SHA256` header. |
| `GET/POST/DELETE /api/rubrics` | Custom rubrics (validated). |
| `WS /api/live` | Live calls. Send `{type:"start",…}`, then 16-bit PCM stereo at 16 kHz (ch0 = agent mic, ch1 = call), then `{type:"stop"}`. The server streams back `utterance` / `alert` / `checklist` / `final` messages. |

## Tests

```bash
npm test                          # 45 unit + integration tests (engine, importers, API, live WebSocket with a fake Deepgram)
npm run typecheck
node scripts/e2e-smoke.mjs        # browser walkthrough (needs a running server)
node scripts/capture-smoke.mjs    # real browser mic → worklet → WebSocket → WAV pipeline with a fake Deepgram
node scripts/extension-smoke.mjs  # loads the extension in Chromium
node scripts/review-smoke.mjs     # grade, override, sign off and calibrate in Chromium (after npm run build)
npm run smoke:deepgram            # (after npm run build) REAL Deepgram: speaks a sample call, scores it as stereo upload, mono upload and live stream
```

**Real Deepgram check.** `smoke:deepgram` uses Deepgram's own text-to-speech to voice the sample Medicare call, with a different voice for the agent and the customer. It then pushes that audio through every speech path and fails if any path grades a phrase-rule item differently from the known-correct transcript, or seats the wrong person as the agent. It needs `DEEPGRAM_API_KEY` and costs about ten cents per run. On GitHub the **Deepgram smoke test** workflow uses the `DEEPGRAM_API_KEY` repository secret. It runs automatically when speech or scoring code lands on `main`, and anyone with write access can run it on any branch from the Actions tab. It never runs automatically on pull requests, because the key would then be available to unreviewed code.

## What's verified, and what isn't yet

**Verified**
- The scoring engine, importers, API and live protocol pass automated tests.
- The browser capture pipeline was driven in Chromium with a fake microphone. It produced correct 16 kHz stereo PCM and a byte-exact WAV.
- The extension loads without errors.

**Not yet verified**
- **Deepgram:** covered by `smoke:deepgram` (see Tests). Check the latest **Deepgram smoke test** run on GitHub for the current result.
- **Claude reviewer:** calls to the real Claude API are written to the documented formats, but have not been run against a real key.
- **Tab-audio sharing** through a real Chrome share prompt.

Run one real call of each type before going live.

**Compliance content**
- Citations are given at the level we're confident of.
- Have a compliance officer review the Medicare rubric before using it in audits.
- myCALL is a QA tool, not legal advice.

**For production PHI**
- Sign BAAs with Deepgram and Anthropic.
- Host on HIPAA-eligible infrastructure.
- Set `MYCALL_API_TOKEN`, or put SSO in front of the app.
- Encrypt the `/data` volume.

**Scale path**
- SQLite plus the in-process queue suits one server.
- For multiple servers, move to Postgres and a job queue. Every row already carries `org_id`.

## How this was chosen: audit of the nine call repos (Sept 2026)

None of the nine repos could actually score a real call. Each fell short in at least one of these ways:
- It fabricated transcripts, for example by asking an LLM to "create a transcript" without the audio.
- It used random or hard-coded scores.
- It captured only one side of the call.
- It existed only as a spec.

myCALL was rebuilt from scratch in one TypeScript stack, carrying forward the best ideas:

| Repo | What it had | Carried into myCALL |
|---|---|---|
| callscore | Configurable weighted rubric, AI-then-human review | Rubric-as-data, per-criterion reasoning, CRM field extraction |
| masterBRIDGE | Cited CMS taxonomy, PHI redaction, append-only audit | Citation discipline, PHI redaction before AI |
| Callanalyze | Evidence format (quote + timestamp + "should have said") | Evidence-anchored results, "Try:" better phrasing |
| call-analyzer-pro | Rich analysis views, Deepgram/AssemblyAI clients (unused) | Report layout ideas, server-side STT |
| servicebridge | 8-dimension needs analysis, compliance enums | Needs-analysis components, severity model |
| agencySHIELD | Evidence-packet concept | Hash-stamped evidence export |
| Callcomplu | Polished UI, GHL client | UI patterns (GHL push is a next step) |
| myCALL | The product spec (extension + live + CMS) | Became the home of the build |
| call-score | Express hardening, deploy configs | Security headers, health check |

**Next steps**
- GoHighLevel push of extracted fields (port the client from Callcomplu).
- SSO and multi-org.
- Manager dashboards with per-agent trends.
- Chrome Web Store listing.

## License

Proprietary — theBRIDGE / INSUREitALL
