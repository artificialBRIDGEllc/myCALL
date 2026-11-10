import { useEffect, useState } from "react";
import type { Calibration, CalibrationRow, Rubric } from "../../../src/core/types.js";
import { api } from "../api";
import { cx, Empty, ErrorBox, Spinner, Stat } from "../components/ui";

/** Below this many signed-off decisions, an accuracy figure is too noisy to act on. */
const MIN_SAMPLE = 5;

function advice(r: CalibrationRow): { tone: "good" | "warn" | "info"; text: string } | null {
  if (!r.decided && r.resolvedByHuman) {
    return { tone: "info", text: "Always graded by people. Turn on the AI reviewer, or turn the reviewers' reasoning into a phrase rule." };
  }
  if (!r.decided) return null;
  if (r.decided < MIN_SAMPLE) return { tone: "info", text: `Only ${r.decided} signed-off call${r.decided > 1 ? "s" : ""} so far. Needs ${MIN_SAMPLE}+ before this number means much.` };
  if ((r.accuracy ?? 0) >= 95) return { tone: "good", text: "Reliable. Reviewers almost always agree." };
  if (r.falseAlarms >= r.misses) {
    return { tone: "warn", text: "Raises false alarms. Narrow the phrase patterns or add the exceptions reviewers keep clearing (see their notes on those calls)." };
  }
  return { tone: "warn", text: "Misses real problems. Add the wording reviewers are catching to this criterion's patterns." };
}

export function CalibrationPage() {
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [rubricId, setRubricId] = useState("");
  const [data, setData] = useState<Calibration | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .rubrics()
      .then((r) => {
        setRubrics(r);
        setRubricId((cur) => cur || r[0]?.id || "");
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!rubricId) return;
    setData(null);
    api.calibration(rubricId).then(setData).catch((e: Error) => setError(e.message));
  }, [rubricId]);

  const decided = data?.rows.reduce((s, r) => s + r.decided, 0) ?? 0;
  const agreed = data?.rows.reduce((s, r) => s + r.agreed, 0) ?? 0;
  const human = data?.rows.reduce((s, r) => s + r.resolvedByHuman, 0) ?? 0;
  const rows = [...(data?.rows ?? [])].sort((a, b) => (a.accuracy ?? 101) - (b.accuracy ?? 101) || b.resolvedByHuman - a.resolvedByHuman);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Calibration</h1>
          <p className="max-w-2xl text-sm text-slate-500">
            How often reviewers agree with the automatic grade, item by item. Uses signed-off calls only: signing off confirms every grade the reviewer didn't change. The least reliable items are listed first; tune those.
          </p>
        </div>
        <select className="input w-auto" value={rubricId} onChange={(e) => setRubricId(e.target.value)} aria-label="Rubric">
          {rubrics.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      {error && <ErrorBox message={error} />}
      {data && data.otherVersionCalls > 0 && (
        <p className="text-sm text-slate-500">
          Showing calls graded with v{data.rubricVersion} only. {data.otherVersionCalls} signed-off call{data.otherVersionCalls > 1 ? "s" : ""} graded with older
          versions {data.otherVersionCalls > 1 ? "aren't" : "isn't"} counted, because an item can mean something different in another version.
        </p>
      )}
      {!data ? (
        !error && (
          <div className="flex items-center gap-2 text-slate-500">
            <Spinner /> Loading…
          </div>
        )
      ) : data.lockedCalls === 0 ? (
        <Empty title="No signed-off calls yet">
          Open a scored call, grade anything marked <b>Review</b>, fix any grade you disagree with, then press <b>Sign off & lock</b>. Each signed-off call makes this report more accurate.
        </Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Signed-off calls" value={data.lockedCalls} />
            <Stat label="Automatic grades checked" value={decided} />
            <Stat label="Agreement" value={decided ? `${Math.round((agreed / decided) * 100)}%` : "–"} hint="Share of automatic grades that reviewers kept." />
            <Stat label="Graded by people" value={human} hint="Items the automatic grader left for review." />
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase dark:bg-slate-800/50">
                <tr>
                  <th className="px-4 py-2">Item</th>
                  <th className="px-4 py-2">Agreement</th>
                  <th className="px-4 py-2 text-right" title="Automatic fail that a reviewer passed">False alarms</th>
                  <th className="px-4 py-2 text-right" title="Automatic pass that a reviewer failed">Misses</th>
                  <th className="px-4 py-2 text-right">Graded by people</th>
                  <th className="px-4 py-2">What to do</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((r) => {
                  const tip = advice(r);
                  return (
                    <tr key={r.criterionId} className="align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {r.name}
                          {r.severity === "critical" && <span className="ml-2 rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-bold text-white uppercase dark:bg-slate-100 dark:text-slate-900">Critical</span>}
                        </div>
                        <div className="text-xs text-slate-500">{r.evaluator === "rules" ? "Phrase rules" : r.evaluator === "llm" ? "AI reviewer" : "Phrase rules + AI check"}</div>
                      </td>
                      <td className="px-4 py-3">
                        {r.accuracy === null ? (
                          <span className="text-slate-400">–</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                              <div className={cx("h-full", r.accuracy >= 95 ? "bg-emerald-500" : r.accuracy >= 80 ? "bg-amber-500" : "bg-rose-500")} style={{ width: `${r.accuracy}%` }} />
                            </div>
                            <span className="tabular-nums">{r.accuracy}%</span>
                            <span className="text-xs text-slate-400">
                              ({r.agreed}/{r.decided})
                            </span>
                          </div>
                        )}
                      </td>
                      <td className={cx("px-4 py-3 text-right tabular-nums", r.falseAlarms ? "font-semibold text-amber-700 dark:text-amber-300" : "text-slate-400")}>{r.falseAlarms}</td>
                      <td className={cx("px-4 py-3 text-right tabular-nums", r.misses ? "font-semibold text-rose-700 dark:text-rose-300" : "text-slate-400")}>{r.misses}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{r.resolvedByHuman || <span className="text-slate-400">0</span>}</td>
                      <td className={cx("px-4 py-3 text-xs", tip?.tone === "warn" ? "text-amber-800 dark:text-amber-200" : tip?.tone === "good" ? "text-emerald-700 dark:text-emerald-300" : "text-slate-500")}>
                        {tip?.text ?? ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
