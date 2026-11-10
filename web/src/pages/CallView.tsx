import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CallDetail, CriterionResult, Evidence, ReviewedStatus, ReviewEvent, Rubric, Utterance } from "../../../src/core/types.js";
import { api, getReviewer, setReviewer } from "../api";
import { clock, ComplianceBadge, cx, ErrorBox, ScoreRing, Spinner, Stat, StatusChip } from "../components/ui";

export function CallView({ id }: { id: string }) {
  const [call, setCall] = useState<CallDetail | null>(null);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);

  const load = useCallback(() => api.call(id).then(setCall).catch((e: Error) => setError(e.message)), [id]);

  useEffect(() => {
    void load();
    api.rubrics().then(setRubrics).catch(() => undefined);
  }, [load]);

  // Poll while the call is being transcribed / scored.
  useEffect(() => {
    if (call?.status !== "processing") return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [call?.status, load]);

  useEffect(() => {
    if (!call?.hasAudio) return;
    api.signedUrl(`/api/calls/${call.id}/audio`).then(setAudioSrc).catch(() => setAudioSrc(null));
  }, [call?.id, call?.hasAudio]);

  // Show the call against the rubric version it was graded with; fall back to the current one.
  const gradedId = call?.result?.rubricId;
  const gradedVersion = call?.result?.rubricVersion;
  const [gradedRubric, setGradedRubric] = useState<Rubric | null>(null);
  useEffect(() => {
    setGradedRubric(null);
    if (!gradedId || !gradedVersion) return;
    let live = true;
    api
      .rubricVersion(gradedId, gradedVersion)
      .then((r) => live && setGradedRubric(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [gradedId, gradedVersion]);
  const rubric = gradedRubric ?? rubrics.find((r) => r.id === call?.rubricId);
  const utterances = call?.transcript?.utterances ?? [];
  const byId = useMemo(() => new Map(utterances.map((u) => [u.id, u])), [utterances]);

  const jump = (utteranceId: number, start?: number) => {
    setFocus(utteranceId);
    document.getElementById(`u-${utteranceId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (audio.current && start !== undefined) {
      audio.current.currentTime = Math.max(0, start - 0.5);
      void audio.current.play().catch(() => undefined);
    }
  };

  // Which utterances are cited as problems / as proof, for transcript highlighting.
  const marks = useMemo(() => {
    const m = new Map<number, "bad" | "good">();
    for (const c of call?.result?.criteria ?? []) {
      const bad = c.status === "fail" || c.status === "partial" || c.status === "needs_review";
      for (const e of c.evidence) {
        const crit = rubric?.criteria.find((x) => x.id === c.criterionId);
        const isViolation = crit?.kind === "prohibited";
        if (bad && (isViolation || c.status !== "partial")) m.set(e.utteranceId, "bad");
        else if (!m.has(e.utteranceId)) m.set(e.utteranceId, "good");
      }
    }
    return m;
  }, [call?.result, rubric]);

  if (error) return <ErrorBox message={error} />;
  if (!call)
    return (
      <div className="flex items-center gap-2 text-slate-500">
        <Spinner /> Loading…
      </div>
    );

  const r = call.result;

  const rescore = async (body: { rubricId?: string; swapRoles?: boolean; latest?: boolean }) => {
    try {
      await api.rescore(call.id, body);
      setCall({ ...call, status: "processing" });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <a href="#/" className="no-print text-sm text-slate-500 hover:underline">
            ← All calls
          </a>
          <h1 className="text-2xl font-bold">{call.title}</h1>
          <div className="text-sm text-slate-500">
            {call.agentName ? `${call.agentName} · ` : ""}
            {new Date(call.createdAt).toLocaleString()} · {clock(call.durationSec)} · {rubric?.name ?? call.rubricId}
          </div>
        </div>
        <Actions call={call} rubrics={rubrics} onRescore={rescore} />
      </div>

      {call.status === "processing" && (
        <div className="card flex items-center gap-3 p-5">
          <Spinner className="text-brand-600" />
          <div>
            <div className="font-semibold">{call.transcript ? "Scoring…" : "Transcribing and scoring…"}</div>
            <div className="text-sm text-slate-500">This page updates automatically.</div>
          </div>
        </div>
      )}
      {call.status === "error" && <ErrorBox message={call.error ?? "Processing failed."} />}

      {r && <ReviewBar call={call} rubric={rubric} onChange={setCall} onError={setError} />}

      {r && (
        <>
          {/* Verdict */}
          <div className="card grid gap-5 p-5 md:grid-cols-[auto_1fr]">
            <div className="flex items-center gap-5">
              <ScoreRing score={r.score} />
              <div className="space-y-2">
                <ComplianceBadge status={r.compliance} />
                <div className={cx("text-sm font-semibold", r.passed ? "text-emerald-600" : "text-rose-600")}>{r.passed ? "Meets the bar" : "Below the bar"}</div>
                {r.callOutcome && <div className="text-sm text-slate-500">Outcome: {r.callOutcome}</div>}
              </div>
            </div>
            <div className="space-y-3 text-sm">
              {r.criticalFailures.length > 0 && (
                <div className="rounded-xl bg-rose-50 p-3 text-rose-900 dark:bg-rose-950/60 dark:text-rose-100">
                  <b>Critical compliance failures:</b> {r.criticalFailures.map((id) => nameOf(rubric, id)).join(", ")}
                </div>
              )}
              {r.needsReview.length > 0 && (
                <div className="rounded-xl bg-violet-50 p-3 text-violet-900 dark:bg-violet-950/60 dark:text-violet-100">
                  <b>Needs a human reviewer:</b> {r.needsReview.map((id) => nameOf(rubric, id)).join(", ")}
                </div>
              )}
              {r.summary ? <p className="leading-relaxed">{r.summary}</p> : <p className="text-slate-500">Scored with phrase rules only{r.aiError ? "" : " — add an AI reviewer to grade judgment skills, write a summary and coaching"}.</p>}
              {r.aiError && <p className="text-amber-700 dark:text-amber-300">AI review failed ({r.aiError}); judgment items were sent to human review.</p>}
              <div className="text-xs text-slate-400">
                Scored {new Date(r.scoredAt).toLocaleString()} · rubric v{r.rubricVersion} · {r.aiReviewer ? `AI reviewer ${r.aiReviewer}` : "phrase rules only"}
              </div>
            </div>
          </div>

          {call.hasAudio && audioSrc && (
            <div className="no-print card sticky top-16 z-10 p-3">
              <audio
                ref={audio}
                controls
                preload="metadata"
                className="w-full"
                src={audioSrc}
                onTimeUpdate={(e) => {
                  const t = e.currentTarget.currentTime;
                  const u = utterances.find((x) => t >= x.start && t <= x.end + 0.3);
                  setPlaying(u?.id ?? null);
                }}
              />
            </div>
          )}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            {/* Criteria */}
            <div className="space-y-5">
              {(rubric?.sections ?? []).map((s) => {
                const items = r.criteria.filter((c) => rubric?.criteria.find((x) => x.id === c.criterionId)?.sectionId === s.id);
                if (!items.length) return null;
                const earned = items.reduce((a, c) => a + c.earned, 0);
                const max = items.filter((c) => c.status !== "na" && c.status !== "needs_review").reduce((a, c) => a + c.maxPoints, 0);
                return (
                  <section key={s.id} className="card p-4">
                    <div className="mb-3 flex items-baseline justify-between">
                      <h2 className="font-bold">{s.name}</h2>
                      <span className="text-sm text-slate-500 tabular-nums">
                        {Math.round(earned * 10) / 10} / {max} pts
                      </span>
                    </div>
                    <div className="space-y-3">
                      {items.map((c) => (
                        <CriterionCard key={c.criterionId} result={c} rubric={rubric} onJump={jump} call={call} onChange={setCall} />
                      ))}
                    </div>
                  </section>
                );
              })}

              {(r.strengths.length > 0 || r.improvements.length > 0) && (
                <section className="card space-y-4 p-4">
                  <h2 className="font-bold">Coaching</h2>
                  {r.strengths.length > 0 && (
                    <div>
                      <div className="label">What went well</div>
                      <ul className="space-y-1 text-sm">
                        {r.strengths.map((s, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="text-emerald-600">✓</span>
                            <span>
                              {s.point} {s.utteranceId !== null && <JumpLink u={byId.get(s.utteranceId)} onJump={jump} />}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {r.improvements.length > 0 && (
                    <div>
                      <div className="label">Do differently next time</div>
                      <ul className="space-y-3 text-sm">
                        {r.improvements.map((s, i) => (
                          <li key={i}>
                            <div className="flex gap-2">
                              <span className="text-amber-600">→</span>
                              <span>
                                {s.point} {s.utteranceId !== null && <JumpLink u={byId.get(s.utteranceId)} onJump={jump} />}
                              </span>
                            </div>
                            {s.betterPhrasing && <div className="mt-1 ml-5 rounded-lg bg-brand-50 px-3 py-2 text-brand-900 italic dark:bg-brand-900/30 dark:text-brand-100">Try: “{s.betterPhrasing}”</div>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )}
            </div>

            {/* Transcript + metrics */}
            <div className="space-y-5">
              <section className="card p-4">
                <h2 className="mb-3 font-bold">Conversation stats</h2>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat label="Agent talk" value={`${r.metrics.agentTalkPct}%`} hint="Share of talk time. 40–60% is typical for consultative sales." />
                  <Stat label="Customer talk" value={`${r.metrics.customerTalkPct}%`} />
                  <Stat label="Agent questions" value={r.metrics.agentQuestions} />
                  <Stat label="Longest monologue" value={clock(r.metrics.longestAgentMonologueSec)} hint="Longest stretch the agent spoke without the customer." />
                  <Stat label="Words / min" value={r.metrics.agentWordsPerMinute} hint="Agent speaking pace. 140–170 is comfortable for seniors." />
                  <Stat label="Interruptions" value={r.metrics.interruptions} />
                </div>
                {r.customerSentiment && <div className="mt-3 text-sm text-slate-500">Customer sentiment: <b className="capitalize">{r.customerSentiment}</b></div>}
              </section>

              {r.extracted.some((e) => e.value) && (
                <section className="card p-4">
                  <h2 className="mb-3 font-bold">Captured details</h2>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    {r.extracted
                      .filter((e) => e.value)
                      .map((e) => (
                        <div key={e.field} className="contents">
                          <dt className="text-slate-500">{e.label}</dt>
                          <dd>
                            {e.value} {e.utteranceId !== null && <JumpLink u={byId.get(e.utteranceId)} onJump={jump} />}
                          </dd>
                        </div>
                      ))}
                  </dl>
                </section>
              )}

              <section className="card p-4">
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="font-bold">Transcript</h2>
                  <span className="text-xs text-slate-500">{utterances.length} turns</span>
                </div>
                <div className="max-h-[70vh] space-y-1 overflow-y-auto pr-1">
                  {utterances.map((u) => (
                    <TranscriptLine key={u.id} u={u} mark={marks.get(u.id)} focused={focus === u.id} playing={playing === u.id} onJump={jump} />
                  ))}
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function nameOf(rubric: Rubric | undefined, id: string) {
  return rubric?.criteria.find((c) => c.id === id)?.name ?? id;
}

function Actions({ call, rubrics, onRescore }: { call: CallDetail; rubrics: Rubric[]; onRescore: (b: { rubricId?: string; swapRoles?: boolean; latest?: boolean }) => void }) {
  const [rubricId, setRubricId] = useState(call.rubricId);
  const locked = Boolean(call.review?.locked);
  const busy = call.status === "processing" || locked;
  // Rescore keeps the version the call was graded with; offer the newer version explicitly.
  const gradedVersion = call.result?.rubricId === rubricId ? call.result.rubricVersion : null;
  const currentVersion = rubrics.find((r) => r.id === rubricId)?.version ?? null;
  const newerAvailable = Boolean(gradedVersion && currentVersion && gradedVersion !== currentVersion);
  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <select className="input w-auto" value={rubricId} onChange={(e) => setRubricId(e.target.value)} aria-label="Rubric">
        {rubrics.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <button className="btn-ghost" disabled={busy} title={gradedVersion ? `Rescore with v${gradedVersion}, the version this call was graded with` : undefined} onClick={() => onRescore({ rubricId })}>
        Rescore
      </button>
      {newerAvailable && (
        <button
          className="btn-ghost"
          disabled={busy}
          title={`Grade this call with v${currentVersion} instead of v${gradedVersion}. Review decisions made against v${gradedVersion} are cleared and logged.`}
          onClick={() => {
            if (window.confirm(`Rescore with v${currentVersion}? Review decisions made against v${gradedVersion} will be cleared (the audit log keeps a record).`)) onRescore({ rubricId, latest: true });
          }}
        >
          Rescore with v{currentVersion}
        </button>
      )}
      {call.transcript && (
        <button className="btn-ghost" disabled={busy} title="Use if the agent and customer were detected the wrong way round" onClick={() => onRescore({ rubricId, swapRoles: true })}>
          Swap speakers
        </button>
      )}
      {call.result && (
        <>
          <button className="btn-ghost" onClick={async () => (window.location.href = await api.signedUrl(`/api/calls/${call.id}/export`))}>
            Export evidence
          </button>
          <button className="btn-ghost" onClick={() => window.print()}>
            Print
          </button>
        </>
      )}
      <button
        className="btn-ghost text-rose-600"
        disabled={locked}
        title={locked ? "Signed-off calls can't be deleted" : undefined}
        onClick={async () => {
          if (!window.confirm("Delete this call, its transcript and recording? This cannot be undone.")) return;
          await api.remove(call.id);
          window.location.hash = "/";
        }}
      >
        Delete
      </button>
    </div>
  );
}

function CriterionCard({
  result: c,
  rubric,
  onJump,
  call,
  onChange,
}: {
  result: CriterionResult;
  rubric: Rubric | undefined;
  onJump: (id: number, start?: number) => void;
  call: CallDetail;
  onChange: (c: CallDetail) => void;
}) {
  const def = rubric?.criteria.find((x) => x.id === c.criterionId);
  const [open, setOpen] = useState(c.status !== "pass" || Boolean(c.review));
  return (
    <div className={cx("rounded-xl border p-3", c.status === "fail" ? "border-rose-200 dark:border-rose-900" : "border-slate-200 dark:border-slate-800")}>
      <button className="flex w-full items-start gap-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <StatusChip status={c.status} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {def?.name ?? c.criterionId}
            {def?.severity === "critical" && <span className="ml-2 rounded bg-slate-900 px-1.5 py-0.5 align-middle text-[10px] font-bold tracking-wide text-white uppercase dark:bg-slate-100 dark:text-slate-900">Critical</span>}
          </div>
          {!open && <div className="truncate text-sm text-slate-500">{c.rationale}</div>}
        </div>
        <span className="shrink-0 text-sm text-slate-500 tabular-nums">
          {c.status === "na" || c.status === "needs_review" ? "–" : `${c.earned}/${c.maxPoints}`}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 pl-1 text-sm">
          <p>{c.rationale}</p>
          {def?.components && (
            <div className="flex flex-wrap gap-1.5">
              {def.components.map((k) => {
                const found = c.componentsFound?.includes(k.id);
                return (
                  <span key={k.id} className={cx("rounded-md px-2 py-0.5 text-xs", found ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-slate-100 text-slate-500 line-through dark:bg-slate-800")}>
                    {found ? "✓" : "✗"} {k.label}
                  </span>
                );
              })}
            </div>
          )}
          {c.evidence.map((e, i) => (
            <EvidenceQuote key={i} e={e} onJump={onJump} />
          ))}
          {c.coaching && <div className="rounded-lg bg-brand-50 px-3 py-2 text-brand-900 dark:bg-brand-900/30 dark:text-brand-100">Coaching: {c.coaching}</div>}
          <div className="text-xs text-slate-400">
            {def?.citation && <>Rule: {def.citation} · </>}Graded by {SOURCE_LABEL[c.source]}
          </div>
          <ReviewControls c={c} call={call} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<CriterionResult["source"], string> = {
  rules: "phrase rules",
  llm: "AI reviewer",
  "rules+llm": "phrase rules + AI reviewer",
  human: "a human reviewer",
};

const STATUS_WORD: Record<string, string> = { pass: "Pass", partial: "Partial", fail: "Fail", na: "N/A", needs_review: "Needs review" };

/** Grade or override one item, or undo a previous decision. Every change needs a name and a note. */
function ReviewControls({ c, call, onChange }: { c: CriterionResult; call: CallDetail; onChange: (c: CallDetail) => void }) {
  const locked = Boolean(call.review?.locked);
  const [editing, setEditing] = useState(c.status === "needs_review");
  const [status, setStatus] = useState<ReviewedStatus | null>(null);
  const [fraction, setFraction] = useState(50);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reviewer = () => {
    let name = getReviewer();
    if (!name) {
      name = window.prompt("Your name (shown on review decisions):")?.trim() ?? "";
      if (name) setReviewer(name);
    }
    return name;
  };

  const run = async (fn: (name: string) => Promise<CallDetail>) => {
    const name = reviewer();
    if (!name) return;
    setBusy(true);
    setErr(null);
    try {
      onChange(await fn(name));
      setEditing(false);
      setStatus(null);
      setNote("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="no-print space-y-2 border-t border-slate-100 pt-2 dark:border-slate-800">
      {c.review && (
        <div className="rounded-lg bg-violet-50 px-3 py-2 text-violet-900 dark:bg-violet-950/50 dark:text-violet-100">
          <div className="text-xs">
            Automatic grade: <b>{STATUS_WORD[c.review.auto.status]}</b>
            {c.review.auto.status !== "needs_review" && <> ({SOURCE_LABEL[c.review.auto.source]})</>} → changed to <b>{STATUS_WORD[c.status]}</b> by{" "}
            <b>{c.review.reviewer}</b> · {new Date(c.review.at).toLocaleString()}
          </div>
          {!locked && (
            <button className="mt-1 text-xs font-semibold underline" disabled={busy} onClick={() => void run((name) => api.undoReview(call.id, c.criterionId, name))}>
              Undo — go back to the automatic grade
            </button>
          )}
        </div>
      )}
      {!locked && !editing && (
        <button className="text-xs font-semibold text-brand-700 hover:underline dark:text-brand-100" onClick={() => setEditing(true)}>
          {c.status === "needs_review" ? "Grade this item" : c.review ? "Change decision" : "Disagree? Override this grade"}
        </button>
      )}
      {!locked && editing && (
        <div className="space-y-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Your grade">
            {(["pass", "partial", "fail", "na"] as const).map((s) => (
              <button
                key={s}
                role="radio"
                aria-checked={status === s}
                className={cx("rounded-lg px-3 py-1 text-xs font-bold ring-1", status === s ? "bg-brand-600 text-white ring-brand-600" : "ring-slate-300 dark:ring-slate-700")}
                onClick={() => setStatus(s)}
              >
                {STATUS_WORD[s]}
              </button>
            ))}
          </div>
          {status === "partial" && (
            <label className="flex items-center gap-2 text-xs">
              Credit
              <input type="range" min={10} max={90} step={10} value={fraction} onChange={(e) => setFraction(Number(e.target.value))} />
              <span className="tabular-nums">{fraction}%</span>
            </label>
          )}
          <textarea className="input min-h-16 text-xs" placeholder="Why? (required — this goes in the audit log)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex items-center gap-2">
            <button
              className="btn-primary px-3 py-1 text-xs"
              disabled={!status || !note.trim() || busy}
              onClick={() => void run((name) => api.review(call.id, c.criterionId, { status: status!, fraction: status === "partial" ? fraction / 100 : undefined, note, reviewer: name }))}
            >
              {busy && <Spinner />} Save decision
            </button>
            {c.status !== "needs_review" && (
              <button className="text-xs text-slate-500 hover:underline" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      {err && <div className="text-xs text-rose-600">{err}</div>}
    </div>
  );
}

/** Review status of the whole call: open items, sign-off, reopen, and the audit trail. */
function ReviewBar({ call, rubric, onChange, onError }: { call: CallDetail; rubric: Rubric | undefined; onChange: (c: CallDetail) => void; onError: (m: string) => void }) {
  const [name, setName] = useState(getReviewer());
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const open = call.result?.needsReview ?? [];
  const locked = Boolean(call.review?.locked);
  const decisions = Object.keys(call.review?.overrides ?? {}).length;

  const act = async (fn: () => Promise<CallDetail>) => {
    if (!name.trim()) return onError("Enter your name first — review decisions are signed.");
    setReviewer(name.trim());
    setBusy(true);
    try {
      onChange(await fn());
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx("card p-4", locked ? "border-emerald-300 dark:border-emerald-800" : open.length ? "border-violet-300 dark:border-violet-800" : "")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          {locked ? (
            <>
              <span className="font-bold text-emerald-700 dark:text-emerald-300">✓ Signed off</span> by {call.review!.lockedBy} · {new Date(call.review!.lockedAt!).toLocaleString()}
              <div className="text-xs text-slate-500">Locked: grades can't be changed, and the call can't be rescored or deleted.</div>
            </>
          ) : open.length ? (
            <>
              <span className="font-bold text-violet-700 dark:text-violet-300">{open.length} item{open.length > 1 ? "s" : ""} need a human decision</span>
              <div className="text-xs text-slate-500">{open.map((id) => nameOf(rubric, id)).join(" · ")}</div>
            </>
          ) : (
            <>
              <span className="font-bold">Ready to sign off</span>
              <div className="text-xs text-slate-500">
                {decisions ? `${decisions} grade${decisions > 1 ? "s" : ""} changed by a reviewer. ` : ""}Signing off confirms every grade on this call and locks it.
              </div>
            </>
          )}
        </div>
        <div className="no-print flex flex-wrap items-center gap-2">
          <input
            className="input w-40 text-xs"
            placeholder="Your name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setReviewer(e.target.value.trim());
            }}
            aria-label="Reviewer name"
          />
          {locked ? (
            <button
              className="btn-ghost"
              disabled={busy}
              onClick={() => {
                const why = window.prompt("Reason for reopening this signed-off call (recorded in the audit log):")?.trim();
                if (why) void act(() => api.unlock(call.id, name.trim(), why));
              }}
            >
              Reopen
            </button>
          ) : (
            <button className="btn-primary" disabled={busy || open.length > 0} title={open.length ? "Grade the open items first" : undefined} onClick={() => void act(() => api.lock(call.id, name.trim(), ""))}>
              {busy && <Spinner />} Sign off & lock
            </button>
          )}
          {call.reviewLog.length > 0 && (
            <button className="text-xs font-semibold text-slate-500 hover:underline" onClick={() => setShowLog(!showLog)}>
              {showLog ? "Hide" : "Show"} audit log ({call.reviewLog.length})
            </button>
          )}
        </div>
      </div>
      {showLog && <ReviewLog events={call.reviewLog} rubric={rubric} />}
    </div>
  );
}

const ACTION_WORD: Record<ReviewEvent["action"], string> = { override: "Graded", revert: "Undid", lock: "Signed off", unlock: "Reopened" };

function ReviewLog({ events, rubric }: { events: ReviewEvent[]; rubric: Rubric | undefined }) {
  return (
    <ol className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
      {[...events].reverse().map((e) => (
        <li key={e.id} className="flex flex-wrap gap-x-2">
          <span className="text-slate-400 tabular-nums">{new Date(e.at).toLocaleString()}</span>
          <b>{e.reviewer}</b>
          <span>
            {ACTION_WORD[e.action]}
            {e.criterionId && <> “{nameOf(rubric, e.criterionId)}”</>}
            {e.fromStatus && e.toStatus && (
              <>
                {" "}
                {STATUS_WORD[e.fromStatus]} → {STATUS_WORD[e.toStatus]}
              </>
            )}
          </span>
          <span className="text-slate-500 italic">— {e.note}</span>
        </li>
      ))}
    </ol>
  );
}

function EvidenceQuote({ e, onJump }: { e: Evidence; onJump: (id: number, start?: number) => void }) {
  return (
    <button className="flex w-full gap-2 rounded-lg bg-slate-50 px-3 py-2 text-left hover:bg-slate-100 dark:bg-slate-800/60 dark:hover:bg-slate-800" onClick={() => onJump(e.utteranceId, e.start)}>
      <span className="shrink-0 font-mono text-xs text-brand-700 tabular-nums dark:text-brand-100">{clock(e.start)}</span>
      <span className="shrink-0 text-xs font-bold text-slate-500 uppercase">{e.role}</span>
      <span className="italic">“{e.quote}”</span>
    </button>
  );
}

function JumpLink({ u, onJump }: { u: Utterance | undefined; onJump: (id: number, start?: number) => void }) {
  if (!u) return null;
  return (
    <button className="font-mono text-xs text-brand-700 hover:underline dark:text-brand-100" onClick={() => onJump(u.id, u.start)}>
      [{clock(u.start)}]
    </button>
  );
}

function TranscriptLine({ u, mark, focused, playing, onJump }: { u: Utterance; mark?: "bad" | "good"; focused: boolean; playing: boolean; onJump: (id: number, start?: number) => void }) {
  return (
    <div
      id={`u-${u.id}`}
      className={cx(
        "flex gap-3 rounded-lg border-l-4 px-2 py-1.5 text-sm transition",
        mark === "bad" ? "border-rose-400 bg-rose-50/60 dark:bg-rose-950/30" : mark === "good" ? "border-emerald-400" : "border-transparent",
        focused && "ring-2 ring-brand-500",
        playing && "bg-brand-50 dark:bg-brand-900/30",
      )}
    >
      <button className="w-12 shrink-0 text-left font-mono text-xs text-slate-400 tabular-nums hover:text-brand-700" onClick={() => onJump(u.id, u.start)}>
        {clock(u.start)}
      </button>
      <div className="min-w-0">
        <span className={cx("mr-2 text-xs font-bold uppercase", u.role === "agent" ? "text-brand-700 dark:text-brand-100" : u.role === "customer" ? "text-indigo-600 dark:text-indigo-300" : "text-slate-500")}>{u.role === "unknown" ? `Speaker ${u.speaker}` : u.role}</span>
        {u.text}
      </div>
    </div>
  );
}
