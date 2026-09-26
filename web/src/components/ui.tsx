import type { ReactNode } from "react";
import type { ComplianceStatus, CriterionStatus } from "../../../src/core/types.js";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function scoreTone(score: number | null | undefined): string {
  if (score === null || score === undefined) return "text-slate-400";
  if (score >= 85) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 70) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

export function ScoreRing({ score, size = 120, label = "Quality" }: { score: number | null; size?: number; label?: string }) {
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score ?? 0));
  const stroke = score === null ? "#94a3b8" : pct >= 85 ? "#059669" : pct >= 70 ? "#d97706" : "#e11d48";
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="10" className="stroke-slate-200 dark:stroke-slate-800" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          stroke={stroke}
          strokeDasharray={c}
          strokeDashoffset={c - (pct / 100) * c}
          style={{ transition: "stroke-dashoffset 600ms ease" }}
        />
      </svg>
      <div className="absolute text-center">
        <div className={cx("font-bold tabular-nums", size > 100 ? "text-3xl" : "text-xl", scoreTone(score))}>{score ?? "–"}</div>
        <div className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase">{label}</div>
      </div>
    </div>
  );
}

const complianceStyle: Record<ComplianceStatus, string> = {
  pass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  fail: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  review: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};
const complianceLabel: Record<ComplianceStatus, string> = { pass: "Compliant", fail: "Compliance fail", review: "Needs review" };

export function ComplianceBadge({ status }: { status: ComplianceStatus | null }) {
  if (!status) return <span className="text-xs text-slate-400">—</span>;
  return <span className={cx("rounded-full px-2.5 py-0.5 text-xs font-semibold", complianceStyle[status])}>{complianceLabel[status]}</span>;
}

const statusStyle: Record<CriterionStatus, string> = {
  pass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  partial: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  fail: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  na: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  needs_review: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
};
const statusLabel: Record<CriterionStatus, string> = { pass: "Pass", partial: "Partial", fail: "Fail", na: "N/A", needs_review: "Review" };

export function StatusChip({ status }: { status: CriterionStatus }) {
  return <span className={cx("shrink-0 rounded-md px-2 py-0.5 text-xs font-bold", statusStyle[status])}>{statusLabel[status]}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60" title={hint}>
      <div className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">{label}</div>
      <div className="mt-1 text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-2 p-10 text-center">
      <div className="text-lg font-semibold">{title}</div>
      <div className="max-w-md text-sm text-slate-500">{children}</div>
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm whitespace-pre-line text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">{message}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx("inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent", className)} />;
}

export function clock(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "–";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
