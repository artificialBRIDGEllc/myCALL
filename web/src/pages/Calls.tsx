import { useEffect, useMemo, useState } from "react";
import type { CallRecord } from "../../../src/core/types.js";
import { api } from "../api";
import { clock, ComplianceBadge, cx, Empty, ErrorBox, scoreTone, Spinner, Stat } from "../components/ui";

const SOURCE_LABEL: Record<CallRecord["source"], string> = { upload: "Recording", live: "Live", import: "Transcript", demo: "Demo" };

export function CallsPage() {
  const [calls, setCalls] = useState<CallRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "review" | "locked">(() => (window.location.hash.includes("review") ? "review" : "all"));

  useEffect(() => {
    let stop = false;
    const load = () =>
      api
        .calls()
        .then((c) => !stop && setCalls(c))
        .catch((e: Error) => !stop && setError(e.message));
    load();
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (calls ?? [])
      .filter((c) => (view === "review" ? c.status === "scored" && c.reviewState !== "locked" : view === "locked" ? c.reviewState === "locked" : true))
      .filter((c) => !q || `${c.title} ${c.agentName ?? ""}`.toLowerCase().includes(q));
  }, [calls, query, view]);

  const scored = (calls ?? []).filter((c) => c.status === "scored");
  const avg = scored.length ? Math.round(scored.reduce((s, c) => s + (c.score ?? 0), 0) / scored.length) : null;
  const fails = scored.filter((c) => c.compliance === "fail").length;
  const review = scored.filter((c) => c.openReviewItems > 0).length;
  const signedOff = scored.filter((c) => c.reviewState === "locked").length;

  if (error) return <ErrorBox message={error} />;
  if (!calls)
    return (
      <div className="flex items-center gap-2 text-slate-500">
        <Spinner /> Loading calls…
      </div>
    );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Calls</h1>
          <p className="text-sm text-slate-500">Every scored call, with the evidence behind each grade.</p>
        </div>
        <div className="flex gap-2">
          <a href="#/live" className="btn-ghost">
            Start live call
          </a>
          <a href="#/new" className="btn-primary">
            Score a recording
          </a>
        </div>
      </div>

      {calls.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Calls scored" value={scored.length} />
          <Stat label="Average quality" value={<span className={scoreTone(avg)}>{avg ?? "–"}</span>} />
          <Stat label="Compliance fails" value={<span className={fails ? "text-rose-600" : ""}>{fails}</span>} />
          <Stat label="Waiting for a reviewer" value={<span className={review ? "text-violet-600" : ""}>{review}</span>} />
        </div>
      )}

      {calls.length === 0 ? (
        <Empty title="No calls yet">
          Upload a recording or transcript, or start a live call. Want to see it first? Open <a className="font-semibold text-brand-700 underline" href="#/live">Live call</a> and press <b>Run demo call</b>.
        </Empty>
      ) : (
        <div className="card overflow-hidden">
          <div className="border-b border-slate-200 p-3 dark:border-slate-800">
            <div className="flex flex-wrap items-center gap-2">
              <input className="input max-w-xs" placeholder="Search by title or agent" value={query} onChange={(e) => setQuery(e.target.value)} />
              {(
                [
                  ["all", `All (${calls.length})`],
                  ["review", `To review (${scored.filter((c) => c.reviewState !== "locked").length})`],
                  ["locked", `Signed off (${signedOff})`],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  className={cx("rounded-lg px-3 py-1.5 text-xs font-semibold", view === v ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")}
                  onClick={() => setView(v)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase dark:bg-slate-800/50">
                <tr>
                  <th className="px-4 py-2">Call</th>
                  <th className="hidden px-4 py-2 sm:table-cell">Agent</th>
                  <th className="hidden px-4 py-2 md:table-cell">When</th>
                  <th className="hidden px-4 py-2 md:table-cell">Length</th>
                  <th className="px-4 py-2 text-right">Score</th>
                  <th className="px-4 py-2">Compliance</th>
                  <th className="px-4 py-2">Review</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filtered.map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40" onClick={() => (window.location.hash = `/calls/${c.id}`)}>
                    <td className="px-4 py-3">
                      <a href={`#/calls/${c.id}`} className="font-semibold hover:underline">
                        {c.title}
                      </a>
                      <div className="text-xs text-slate-500">
                        {SOURCE_LABEL[c.source]}
                        <span className="md:hidden"> · {new Date(c.createdAt).toLocaleDateString()}</span>
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">{c.agentName ?? <span className="text-slate-400">—</span>}</td>
                    <td className="hidden px-4 py-3 whitespace-nowrap text-slate-500 md:table-cell">{new Date(c.createdAt).toLocaleString()}</td>
                    <td className="hidden px-4 py-3 tabular-nums md:table-cell">{clock(c.durationSec)}</td>
                    <td className={cx("px-4 py-3 text-right text-base font-bold tabular-nums", scoreTone(c.score))}>
                      {c.status === "processing" ? <Spinner className="text-slate-400" /> : c.status === "error" ? <span className="text-xs font-semibold text-rose-600">Error</span> : c.score}
                    </td>
                    <td className="px-4 py-3">{c.status === "scored" ? <ComplianceBadge status={c.compliance} /> : <span className="text-xs text-slate-500">{c.status === "processing" ? "Processing…" : ""}</span>}</td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      {c.status !== "scored" ? null : c.reviewState === "locked" ? (
                        <span className="font-semibold text-emerald-700 dark:text-emerald-300">✓ Signed off</span>
                      ) : c.openReviewItems > 0 ? (
                        <span className="font-semibold text-violet-700 dark:text-violet-300">{c.openReviewItems} to grade</span>
                      ) : (
                        <span className="text-slate-500">{c.reviewState === "in_review" ? "Ready to sign off" : "Not reviewed"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
