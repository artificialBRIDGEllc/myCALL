import { useEffect, useRef, useState } from "react";
import { getMicrophone, pickCallTab, startCapture, type CaptureHandle } from "../../../src/capture/capture.js";
import { LiveClient } from "../../../src/capture/live-client.js";
import type { CallMetrics, ChecklistItem, LiveAlert, LiveServerMessage, Role, Rubric, ScoreResult, Utterance } from "../../../src/core/types.js";
import { api, getToken, type ServerConfig } from "../api";
import { clock, ComplianceBadge, cx, ErrorBox, ScoreRing, Spinner } from "../components/ui";

type Phase = "setup" | "connecting" | "live" | "scoring" | "done";
type Mode = "tab+mic" | "mic";

export function LivePage({ config }: { config: ServerConfig | null }) {
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [rubricId, setRubricId] = useState("");
  const [agentName, setAgentName] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<Mode>("tab+mic");
  const [phase, setPhase] = useState<Phase>("setup");
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [interim, setInterim] = useState<{ role: Role; text: string } | null>(null);
  const [alerts, setAlerts] = useState<LiveAlert[]>([]);
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [provisional, setProvisional] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<CallMetrics | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [final, setFinal] = useState<{ callId: string; result: ScoreResult } | null>(null);
  const [levels, setLevels] = useState({ agent: 0, customer: 0 });

  const client = useRef<LiveClient | null>(null);
  const capture = useRef<CaptureHandle | null>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .rubrics()
      .then((r) => {
        setRubrics(r);
        setRubricId((cur) => cur || r[0]?.id || "");
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      void capture.current?.stop();
      client.current?.close();
    };
  }, []);

  useEffect(() => transcriptEnd.current?.scrollIntoView({ block: "nearest" }), [utterances.length, interim]);

  useEffect(() => {
    if (phase !== "live" || !capture.current) return;
    let raf = 0;
    const loop = () => {
      if (capture.current) setLevels(capture.current.levels());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  const reset = () => {
    setUtterances([]);
    setInterim(null);
    setAlerts([]);
    setItems([]);
    setProvisional(null);
    setMetrics(null);
    setElapsed(0);
    setFinal(null);
    setError(null);
  };

  const onMessage = (m: LiveServerMessage) => {
    switch (m.type) {
      case "ready":
        setPhase("live");
        break;
      case "interim":
        setInterim({ role: m.role, text: m.text });
        break;
      case "utterance":
        setInterim(null);
        setUtterances((prev) => [...prev, m.utterance]);
        break;
      case "alert":
        setAlerts((prev) => [m.alert, ...prev].slice(0, 50));
        break;
      case "checklist":
        setItems(m.items);
        setProvisional(m.provisionalScore);
        setMetrics(m.metrics);
        setElapsed(m.elapsed);
        break;
      case "scoring":
        setPhase("scoring");
        void capture.current?.stop();
        capture.current = null;
        break;
      case "final":
        setFinal({ callId: m.callId, result: m.result });
        setPhase("done");
        break;
      case "error":
        setError(m.message);
        break;
    }
  };

  const start = async (asDemo: boolean) => {
    reset();
    setDemo(asDemo);
    setPhase("connecting");
    const base = { type: "start" as const, rubricId, agentName, title: title || undefined, sampleRate: 16000, channels: 2 as const, demo: asDemo };
    const onClose = () => setPhase((p) => (p === "done" ? p : p === "scoring" ? "done" : "setup"));
    try {
      if (asDemo) {
        client.current = new LiveClient(window.location.origin, getToken(), base, onMessage, onClose);
        return;
      }
      // Ask for permissions first so the agent sees the browser prompts before anything starts.
      const mic = await getMicrophone();
      let call: MediaStream | null = null;
      if (mode === "tab+mic") {
        try {
          call = await pickCallTab();
        } catch (e) {
          mic.getTracks().forEach((t) => t.stop());
          throw e;
        }
      }
      const lc = new LiveClient(window.location.origin, getToken(), base, onMessage, onClose);
      client.current = lc;
      capture.current = await startCapture({ mic, call }, "/pcm-worklet.js", (pcm) => lc.sendAudio(pcm));
      // If the agent clicks "Stop sharing" in Chrome's bar, end the call cleanly.
      call?.getAudioTracks()[0]?.addEventListener("ended", () => lc.stop());
    } catch (e) {
      const err = e as Error;
      setError(err.name === "NotAllowedError" ? "Permission was denied. Allow the microphone (and tab sharing) to score a live call." : err.message);
      setPhase("setup");
      client.current?.close();
    }
  };

  const stop = () => client.current?.stop();

  const required = items.filter((i) => i.kind === "required");
  const watch = items.filter((i) => i.kind === "prohibited");
  const canStart = Boolean(rubricId) && phase === "setup";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Live call</h1>
          <p className="text-sm text-slate-500">Real-time compliance coaching for calls in your browser — softphones, dialers, Zoom, Meet, Teams.</p>
        </div>
        {(phase === "live" || phase === "connecting") && (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 font-mono text-lg tabular-nums">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" /> {clock(elapsed)}
            </span>
            {!demo && (
              <div className="hidden w-40 space-y-1 sm:block">
                <Meter label="You" value={levels.agent} />
                <Meter label="Caller" value={levels.customer} />
              </div>
            )}
            <button className="btn-danger" onClick={stop} disabled={phase !== "live"}>
              End & score
            </button>
          </div>
        )}
      </div>

      {error && <ErrorBox message={error} />}

      {phase === "setup" && (
        <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
          <div className="card space-y-4 p-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="label" htmlFor="lrubric">
                  Rubric
                </label>
                <select id="lrubric" className="input" value={rubricId} onChange={(e) => setRubricId(e.target.value)}>
                  {rubrics.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="lagent">
                  Agent name
                </label>
                <input id="lagent" className="input" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="e.g. Dana Brooks" />
              </div>
              <div className="md:col-span-2">
                <label className="label" htmlFor="ltitle">
                  Call label (optional)
                </label>
                <input id="ltitle" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Inbound — plan review" />
              </div>
            </div>
            <fieldset className="space-y-2">
              <legend className="label">What to listen to</legend>
              <ModeOption checked={mode === "tab+mic"} onChange={() => setMode("tab+mic")} title="The call's browser tab + my microphone" body="For softphones, web dialers, Zoom, Meet or Teams in the browser. You'll pick the tab — tick “Also share tab audio”. Best accuracy: the caller and you are recorded separately." />
              <ModeOption checked={mode === "mic"} onChange={() => setMode("mic")} title="Just my microphone" body="For desk phones or in-person meetings. Only your side is checked; disclosures still count." />
            </fieldset>
            <div className="flex flex-wrap gap-2 pt-1">
              <button className="btn-primary" disabled={!canStart || !config?.transcription} onClick={() => void start(false)}>
                Start live call
              </button>
              <button className="btn-ghost" disabled={!canStart} onClick={() => void start(true)}>
                Run demo call
              </button>
            </div>
            {!config?.transcription && <p className="text-xs text-amber-700 dark:text-amber-300">Live transcription needs DEEPGRAM_API_KEY on the server. The demo call works without it.</p>}
          </div>
          <div className="card space-y-3 p-5 text-sm">
            <div className="font-semibold">How it works</div>
            <ol className="list-decimal space-y-2 pl-5 text-slate-600 dark:text-slate-300">
              <li>Your mic and the call audio are captured as two separate channels, so we always know who said what.</li>
              <li>Speech is transcribed live. Every sentence is checked against the rubric the moment it's said.</li>
              <li>You get a live checklist, countdowns for time-limited disclosures, and instant alerts for risky phrases.</li>
              <li>When you end the call, the full AI review runs and the recording, transcript and evidence are saved.</li>
            </ol>
            <p className="text-xs text-slate-500">Use a headset for best results. Make sure recording the call is permitted and disclosed where required.</p>
          </div>
        </div>
      )}

      {phase === "connecting" && (
        <div className="card flex items-center gap-3 p-5">
          <Spinner className="text-brand-600" /> Connecting…
        </div>
      )}

      {(phase === "live" || phase === "scoring" || phase === "done") && (
        <div className="grid gap-5 lg:grid-cols-[20rem_1fr]">
          <div className="space-y-5">
            <div className="card flex items-center gap-4 p-4">
              {phase === "done" && final ? <ScoreRing score={final.result.score} size={96} label="Final" /> : <ScoreRing score={provisional} size={96} label="Live" />}
              <div className="text-sm">
                {phase === "done" && final ? (
                  <>
                    <ComplianceBadge status={final.result.compliance} />
                    <a className="mt-2 block font-semibold text-brand-700 hover:underline" href={`#/calls/${final.callId}`}>
                      Open full report →
                    </a>
                  </>
                ) : phase === "scoring" ? (
                  <span className="flex items-center gap-2 text-slate-500">
                    <Spinner /> Running full review…
                  </span>
                ) : (
                  <span className="text-slate-500">Provisional score from rule-checked items. Coaching skills are graded when the call ends.</span>
                )}
              </div>
            </div>

            <div className="card p-4">
              <div className="label">Must do</div>
              <ul className="space-y-2">
                {required.map((i) => (
                  <ChecklistRow key={i.criterionId} item={i} />
                ))}
              </ul>
              {watch.length > 0 && (
                <>
                  <div className="label mt-4">Must not say</div>
                  <ul className="space-y-2">
                    {watch.map((i) => (
                      <ChecklistRow key={i.criterionId} item={i} />
                    ))}
                  </ul>
                </>
              )}
            </div>

            {metrics && (
              <div className="card p-4 text-sm">
                <div className="label">Talk time</div>
                <div className="flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className="bg-brand-600" style={{ width: `${metrics.agentTalkPct}%` }} />
                  <div className="bg-indigo-400" style={{ width: `${metrics.customerTalkPct}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-xs text-slate-500">
                  <span>Agent {metrics.agentTalkPct}%</span>
                  <span>Customer {metrics.customerTalkPct}%</span>
                </div>
                {metrics.agentTalkPct > 70 && utterances.length > 6 && <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">You're doing most of the talking — ask an open question.</div>}
              </div>
            )}
          </div>

          <div className="space-y-5">
            <div className="card p-4">
              <div className="label">Alerts</div>
              {alerts.length === 0 ? (
                <div className="text-sm text-slate-500">No alerts yet.</div>
              ) : (
                <ul className="max-h-56 space-y-2 overflow-y-auto">
                  {alerts.map((a) => (
                    <li
                      key={a.id}
                      className={cx(
                        "rounded-lg px-3 py-2 text-sm",
                        a.level === "critical" ? "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-100" : a.level === "warning" ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100" : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
                      )}
                    >
                      <span className="mr-2 font-mono text-xs opacity-70">{clock(a.at)}</span>
                      <b>{a.message}</b>
                      {a.quote && <div className="mt-0.5 text-xs italic opacity-80">“{a.quote}”</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="card p-4">
              <div className="label">Live transcript</div>
              <div className="max-h-[50vh] space-y-1.5 overflow-y-auto text-sm">
                {utterances.map((u) => (
                  <div key={u.id} className="flex gap-3">
                    <span className="w-10 shrink-0 font-mono text-xs text-slate-400">{clock(u.start)}</span>
                    <span className={cx("w-20 shrink-0 text-xs font-bold uppercase", u.role === "agent" ? "text-brand-700 dark:text-brand-100" : "text-indigo-600 dark:text-indigo-300")}>{u.role}</span>
                    <span>{u.text}</span>
                  </div>
                ))}
                {interim && (
                  <div className="flex gap-3 text-slate-400">
                    <span className="w-10 shrink-0" />
                    <span className="w-20 shrink-0 text-xs font-bold uppercase">{interim.role}</span>
                    <span className="italic">{interim.text}…</span>
                  </div>
                )}
                <div ref={transcriptEnd} />
              </div>
            </div>
            {phase === "done" && (
              <button className="btn-ghost" onClick={() => setPhase("setup")}>
                Start another call
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ModeOption({ checked, onChange, title, body }: { checked: boolean; onChange: () => void; title: string; body: string }) {
  return (
    <label className={cx("flex cursor-pointer gap-3 rounded-xl border p-3", checked ? "border-brand-500 bg-brand-50 dark:bg-brand-900/20" : "border-slate-200 dark:border-slate-800")}>
      <input type="radio" className="mt-1" checked={checked} onChange={onChange} />
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-slate-500">{body}</span>
      </span>
    </label>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 text-[10px] text-slate-500">
      <span className="w-9">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div className="h-full bg-emerald-500 transition-[width] duration-75" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  );
}

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const icon = item.state === "done" ? "✓" : item.state === "violated" ? "✗" : item.state === "overdue" ? "!" : "•";
  return (
    <li className="text-sm">
      <div className="flex items-start gap-2">
        <span
          className={cx(
            "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold",
            item.state === "done" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : item.state === "pending" ? "bg-slate-100 text-slate-500 dark:bg-slate-800" : "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className={cx("font-medium", item.state === "done" && "text-slate-500")}>
            {item.name}
            {item.secondsLeft !== undefined && (
              <span className={cx("ml-2 rounded px-1.5 font-mono text-xs", item.secondsLeft <= 15 ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")}>{item.secondsLeft}s</span>
            )}
          </div>
          {item.componentsTotal !== undefined && item.state !== "done" && (
            <div className="text-xs text-slate-500">
              {item.componentsFound?.length ?? 0} of {item.componentsTotal} parts
            </div>
          )}
          {item.hint && (item.state === "overdue" || item.state === "violated" || (item.secondsLeft !== undefined && item.secondsLeft <= 20)) && <div className="text-xs text-rose-700 dark:text-rose-300">{item.hint}</div>}
        </div>
      </div>
    </li>
  );
}
