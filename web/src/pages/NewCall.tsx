import { useEffect, useRef, useState } from "react";
import type { Rubric } from "../../../src/core/types.js";
import { api, type ServerConfig } from "../api";
import { cx, ErrorBox, Spinner } from "../components/ui";

const TRANSCRIPT = /\.(txt|vtt|srt|json)$/i;

interface Job {
  name: string;
  state: "queued" | "uploading" | "done" | "error";
  id?: string;
  error?: string;
}

export function NewCallPage({ config }: { config: ServerConfig | null }) {
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [rubricId, setRubricId] = useState("");
  const [agentName, setAgentName] = useState("");
  const [separate, setSeparate] = useState<"auto" | "true" | "false">("auto");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .rubrics()
      .then((r) => {
        setRubrics(r);
        setRubricId((cur) => cur || r[0]?.id || "");
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    setBusy(true);
    const list: Job[] = files.map((f) => ({ name: f.name, state: "queued" }));
    setJobs(list);
    const update = (i: number, j: Partial<Job>) => setJobs((prev) => prev.map((x, k) => (k === i ? { ...x, ...j } : x)));
    let firstId: string | null = null;
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      if (!TRANSCRIPT.test(f.name) && !config?.transcription) {
        update(i, { state: "error", error: "Audio needs transcription (DEEPGRAM_API_KEY). Upload a transcript instead." });
        continue;
      }
      update(i, { state: "uploading" });
      const form = new FormData();
      // Fields first, then the file (the server reads the stream in order).
      form.append("rubricId", rubricId);
      if (agentName) form.append("agentName", agentName);
      form.append("title", f.name.replace(/\.[^.]+$/, ""));
      if (separate !== "auto") form.append("separateChannels", separate);
      form.append("file", f, f.name);
      try {
        const { id } = await api.upload(form);
        update(i, { state: "done", id });
        firstId ??= id;
      } catch (e) {
        update(i, { state: "error", error: (e as Error).message });
      }
    }
    setBusy(false);
    if (files.length === 1 && firstId) window.location.hash = `/calls/${firstId}`;
  };

  const submitPaste = async () => {
    setError(null);
    setBusy(true);
    try {
      const { id } = await api.importText({ transcript: paste, rubricId, agentName: agentName || undefined, title: "Pasted transcript" });
      window.location.hash = `/calls/${id}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rubric = rubrics.find((r) => r.id === rubricId);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Score a recording</h1>
        <p className="text-sm text-slate-500">Upload past calls — one or a whole batch. Audio is transcribed with speaker separation, then scored against your rubric.</p>
      </div>

      <div className="card grid gap-4 p-5 md:grid-cols-3">
        <div className="md:col-span-2">
          <label className="label" htmlFor="rubric">
            Rubric
          </label>
          <select id="rubric" className="input" value={rubricId} onChange={(e) => setRubricId(e.target.value)}>
            {rubrics.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {rubric && <p className="mt-1 text-xs text-slate-500">{rubric.criteria.length} criteria · pass at {rubric.passThreshold}+ with no critical compliance failures</p>}
        </div>
        <div>
          <label className="label" htmlFor="agent">
            Agent name (optional)
          </label>
          <input id="agent" className="input" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="e.g. Dana Brooks" />
        </div>
        <div className="md:col-span-3">
          <label className="label" htmlFor="sep">
            Speaker separation
          </label>
          <select id="sep" className="input" value={separate} onChange={(e) => setSeparate(e.target.value as typeof separate)}>
            <option value="auto">Automatic (stereo WAV = one party per channel; otherwise detect voices)</option>
            <option value="true">Stereo recording — agent and customer on separate channels (most accurate)</option>
            <option value="false">Single mixed track — detect voices</option>
          </select>
        </div>
      </div>

      <div
        className={cx(
          "card flex cursor-pointer flex-col items-center gap-2 border-2 border-dashed p-10 text-center transition",
          drag ? "border-brand-500 bg-brand-50 dark:bg-brand-900/20" : "border-slate-300 dark:border-slate-700",
        )}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void upload([...e.dataTransfer.files]);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            input.current?.click();
          }
        }}
      >
        <svg viewBox="0 0 24 24" className="h-10 w-10 text-brand-600" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="font-semibold">Drop recordings or transcripts here, or click to choose</div>
        <div className="text-xs text-slate-500">
          Audio: MP3, WAV, M4A, OGG, WEBM, FLAC (up to {config?.maxUploadMb ?? 200} MB) · Transcripts: TXT, VTT/SRT (Zoom, Teams, Meet), Deepgram JSON
        </div>
        {!config?.transcription && <div className="mt-2 rounded-lg bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">Audio transcription is off on this server — transcripts still work.</div>}
        <input ref={input} type="file" multiple hidden accept="audio/*,video/*,.txt,.vtt,.srt,.json" onChange={(e) => void upload([...(e.target.files ?? [])])} />
      </div>

      {jobs.length > 0 && (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {jobs.map((j, i) => (
            <div key={i} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
              <span className="truncate">{j.name}</span>
              {j.state === "uploading" || j.state === "queued" ? (
                <span className="flex items-center gap-2 text-slate-500">
                  <Spinner /> {j.state === "queued" ? "Waiting" : "Uploading"}
                </span>
              ) : j.state === "done" ? (
                <a className="font-semibold text-brand-700 hover:underline" href={`#/calls/${j.id}`}>
                  View →
                </a>
              ) : (
                <span className="text-right text-xs text-rose-600">{j.error}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card space-y-3 p-5">
        <div>
          <div className="font-semibold">Or paste a transcript</div>
          <p className="text-xs text-slate-500">One turn per line, like “Agent: …” / “Customer: …”. Timestamps like [01:23] are optional.</p>
        </div>
        <textarea className="input min-h-40 font-mono text-xs" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"Agent: Thanks for calling, my name is Dana, I'm a licensed agent.\nCustomer: Hi Dana, I have a question about my plan."} />
        <button className="btn-primary" disabled={!paste.trim() || !rubricId || busy} onClick={() => void submitPaste()}>
          {busy && <Spinner />} Score transcript
        </button>
      </div>
      {error && <ErrorBox message={error} />}
    </div>
  );
}
