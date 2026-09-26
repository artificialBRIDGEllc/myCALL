import { useEffect, useState } from "react";
import type { Rubric } from "../../../src/core/types.js";
import { api } from "../api";
import { cx, ErrorBox } from "../components/ui";

const BUILT_IN = new Set(["medicare-tpmo", "general-sales"]);
const EVALUATOR_LABEL = { rules: "Phrase rules (instant, live)", llm: "AI reviewer", hybrid: "Phrase rules + AI check" } as const;

export function RubricsPage() {
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = () =>
    api
      .rubrics()
      .then((r) => {
        setRubrics(r);
        setSelected((cur) => cur || r[0]?.id || "");
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const rubric = rubrics.find((r) => r.id === selected);

  const save = async () => {
    setError(null);
    setSaved(null);
    try {
      const r = await api.saveRubric(JSON.parse(json));
      setSaved(`Saved “${r.name}”.`);
      setSelected(r.id);
      setJson("");
      await load();
    } catch (e) {
      setError(e instanceof SyntaxError ? `That isn't valid JSON: ${e.message}` : (e as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Rubrics</h1>
        <p className="text-sm text-slate-500">What every call is graded against. Each criterion shows the rule it enforces and how it's checked.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {rubrics.map((r) => (
          <button key={r.id} className={cx("rounded-xl px-3 py-1.5 text-sm font-medium", r.id === selected ? "bg-brand-600 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-800")} onClick={() => setSelected(r.id)}>
            {r.name}
          </button>
        ))}
      </div>

      {rubric && (
        <div className="card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">{rubric.name}</h2>
              <p className="max-w-3xl text-sm text-slate-500">{rubric.description}</p>
              <p className="mt-1 text-xs text-slate-400">
                v{rubric.version} · pass at {rubric.passThreshold}+ with no critical failures · {rubric.criteria.length} criteria
              </p>
            </div>
            <div className="flex gap-2">
              <button className="btn-ghost" onClick={() => setJson(JSON.stringify({ ...rubric, id: `${rubric.id}-custom`, name: `${rubric.name} (custom)` }, null, 2))}>
                Copy as template
              </button>
              {!BUILT_IN.has(rubric.id) && (
                <button
                  className="btn-ghost text-rose-600"
                  onClick={async () => {
                    if (!window.confirm(`Delete rubric “${rubric.name}”?`)) return;
                    await api.deleteRubric(rubric.id).catch((e: Error) => setError(e.message));
                    setSelected("");
                    await load();
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
          {rubric.sections.map((s) => (
            <div key={s.id} className="mt-5">
              <h3 className="mb-2 font-semibold">{s.name}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {rubric.criteria
                      .filter((c) => c.sectionId === s.id)
                      .map((c) => (
                        <tr key={c.id} className="align-top">
                          <td className="py-2 pr-4">
                            <div className="font-medium">
                              {c.name}
                              {c.severity === "critical" && <span className="ml-2 rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-bold text-white uppercase dark:bg-slate-100 dark:text-slate-900">Critical</span>}
                            </div>
                            <div className="text-xs text-slate-500">{c.description}</div>
                            {c.citation && <div className="mt-0.5 text-xs text-slate-400">Rule: {c.citation}</div>}
                          </td>
                          <td className="py-2 pr-4 text-xs whitespace-nowrap text-slate-500">
                            {c.kind === "prohibited" ? "Must not say" : c.kind === "required" ? "Must do" : "Skill"}
                            {c.withinSeconds !== undefined && ` · within ${c.withinSeconds}s`}
                          </td>
                          <td className="py-2 pr-4 text-xs whitespace-nowrap text-slate-500">{EVALUATOR_LABEL[c.evaluator]}</td>
                          <td className="py-2 text-right tabular-nums">{c.points} pts</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card space-y-3 p-5">
        <div>
          <div className="font-semibold">Add or update a custom rubric</div>
          <p className="text-xs text-slate-500">Paste rubric JSON (start from “Copy as template”). Phrase patterns are regular expressions matched against lowercase text without punctuation.</p>
        </div>
        <textarea className="input min-h-64 font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} placeholder='{ "id": "my-rubric", "name": "...", ... }' />
        <button className="btn-primary" disabled={!json.trim()} onClick={() => void save()}>
          Save rubric
        </button>
        {saved && <div className="text-sm text-emerald-700">{saved}</div>}
        {error && <ErrorBox message={error} />}
      </div>
    </div>
  );
}
