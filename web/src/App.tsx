import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken, type ServerConfig } from "./api";
import { cx, ErrorBox } from "./components/ui";
import { CallsPage } from "./pages/Calls";
import { CallView } from "./pages/CallView";
import { LivePage } from "./pages/Live";
import { NewCallPage } from "./pages/NewCall";
import { RubricsPage } from "./pages/Rubrics";

export function navigate(hash: string) {
  window.location.hash = hash;
}

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

const NAV = [
  { to: "/", label: "Calls" },
  { to: "/new", label: "Score a recording" },
  { to: "/live", label: "Live call" },
  { to: "/rubrics", label: "Rubrics" },
];

export function App() {
  const route = useHash();
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .config()
      .then((c) => {
        setConfig(c);
        setNeedToken(false);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setNeedToken(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
  }, []);
  useEffect(load, [load]);

  if (needToken) return <TokenGate onSaved={load} />;

  const callMatch = route.match(/^\/calls\/([\w-]+)/);
  const active = callMatch ? "/" : route;

  return (
    <div className="min-h-screen">
      <header className="no-print sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <a href="#/" className="flex items-center gap-2 font-bold">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-700 text-white">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />
              </svg>
            </span>
            myCALL
          </a>
          <nav className="flex flex-wrap gap-1">
            {NAV.map((n) => (
              <a
                key={n.to}
                href={`#${n.to}`}
                className={cx(
                  "rounded-lg px-3 py-1.5 text-sm font-medium",
                  active === n.to ? "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-100" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                )}
              >
                {n.label}
              </a>
            ))}
          </nav>
          {config && (
            <div className="ml-auto flex flex-wrap gap-2 text-xs">
              <Capability on={config.transcription} label={config.transcription ? `Transcription: ${config.transcriptionModel}` : "Transcription off"} />
              <Capability on={Boolean(config.aiReviewer)} label={config.aiReviewer ? `AI reviewer: ${config.aiReviewer}` : "AI reviewer off"} />
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        {error && <ErrorBox message={error} />}
        {callMatch ? (
          <CallView id={callMatch[1]!} />
        ) : route === "/new" ? (
          <NewCallPage config={config} />
        ) : route === "/live" ? (
          <LivePage config={config} />
        ) : route === "/rubrics" ? (
          <RubricsPage />
        ) : (
          <CallsPage />
        )}
      </main>
    </div>
  );
}

function Capability({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium",
        on ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-slate-100 text-slate-500 dark:bg-slate-800",
      )}
      title={on ? "Configured on the server" : "Add the API key on the server to enable"}
    >
      <span className={cx("h-1.5 w-1.5 rounded-full", on ? "bg-emerald-500" : "bg-slate-400")} />
      {label}
    </span>
  );
}

function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState(getToken() ?? "");
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <form
        className="card w-full max-w-sm space-y-4 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value.trim() || null);
          onSaved();
        }}
      >
        <div>
          <div className="text-lg font-bold">myCALL</div>
          <p className="text-sm text-slate-500">Enter your team's access token.</p>
        </div>
        <input className="input" type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="Access token" />
        <button className="btn-primary w-full" type="submit">
          Continue
        </button>
      </form>
    </div>
  );
}
