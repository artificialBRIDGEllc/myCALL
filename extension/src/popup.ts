import { IDLE, loadSettings, type CallState, type ExtMessage } from "./shared.js";

const app = document.getElementById("app")!;
const phaseEl = document.getElementById("phase")!;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

async function render(state: CallState): Promise<void> {
  const settings = await loadSettings();
  const labels: Record<CallState["phase"], string> = { idle: "Ready", connecting: "Connecting…", live: "● Live", scoring: "Scoring…", done: "Scored", error: "Error" };
  phaseEl.textContent = labels[state.phase];
  phaseEl.className = `pill ${state.phase === "live" ? "live" : ""}`;
  const notice = state.error ? `<p class="err">${esc(state.error)}</p>` : "";

  if (state.phase === "idle" || state.phase === "error" || state.phase === "done") {
    const done =
      state.phase === "done" && state.result
        ? `<div><div class="score">${state.result.score}</div><div class="muted">Compliance: ${esc(state.result.compliance)}${state.result.criticalFailures.length ? ` · ${state.result.criticalFailures.length} critical` : ""}</div>
           <a target="_blank" href="${esc(settings.serverUrl)}/#/calls/${esc(state.callId ?? "")}">Open full report →</a></div>`
        : "";
    app.innerHTML = `${done}${notice}
      <p class="muted">Open the tab with your call (softphone, dialer, Zoom, Meet, Teams), then start. Scoring against <b>${esc(settings.rubricId)}</b> on ${esc(settings.serverUrl)}.</p>
      <div class="row"><button class="primary" id="start">Score this tab's call</button><button id="setup">Setup</button></div>`;
    document.getElementById("start")!.onclick = async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      await chrome.runtime.sendMessage({ to: "worker", type: "start", tabId: tab.id, tabTitle: tab.title ?? "Browser call" } satisfies ExtMessage);
    };
    document.getElementById("setup")!.onclick = () => chrome.runtime.openOptionsPage();
    return;
  }

  const elapsed = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
  const items = state.items
    .map((i) => {
      const icon = i.state === "done" ? "✓" : i.state === "pending" ? "•" : "✗";
      const extra = i.secondsLeft !== undefined ? ` <span class="muted">${i.secondsLeft}s</span>` : "";
      return `<li class="${i.state}"><span class="dot">${icon}</span><span>${esc(i.name)}${extra}</span></li>`;
    })
    .join("");
  const alerts = state.alerts
    .filter((a) => a.level !== "info")
    .slice(0, 4)
    .map((a) => `<div class="alert ${a.level}"><b>${esc(a.message)}</b>${a.quote ? `<div class="muted">“${esc(a.quote)}”</div>` : ""}</div>`)
    .join("");
  app.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center">
      <div><div class="score">${state.provisionalScore ?? "–"}</div><div class="muted">${esc(state.tabTitle ?? "")} · ${clock(elapsed)}</div></div>
      <button class="danger" id="stop" ${state.phase !== "live" ? "disabled" : ""}>End & score</button>
    </div>
    ${notice}${alerts}
    <ul>${items}</ul>`;
  document.getElementById("stop")!.onclick = () => chrome.runtime.sendMessage({ to: "worker", type: "stop" } satisfies ExtMessage);
}

chrome.runtime.onMessage.addListener((m: ExtMessage) => {
  if (m.to === "popup" && m.type === "state") void render(m.state);
});
chrome.runtime.sendMessage({ to: "worker", type: "state?" } satisfies ExtMessage).then((s: CallState | undefined) => render(s ?? IDLE), () => render(IDLE));
