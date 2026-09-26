import { IDLE, loadSettings, type CallState, type ExtMessage } from "./shared.js";

/**
 * Coordinates a live call: gets a tab-capture stream id for the call's tab,
 * hands it to an offscreen document (MV3 service workers can't hold audio),
 * and keeps the latest call state for the popup.
 */
let state: CallState = { ...IDLE };

const publish = () => {
  void chrome.storage.session.set({ state });
  chrome.runtime.sendMessage({ to: "popup", type: "state", state } satisfies ExtMessage).catch(() => undefined);
  void chrome.action.setBadgeText({ text: state.phase === "live" ? "REC" : "" });
  void chrome.action.setBadgeBackgroundColor({ color: "#e11d48" });
};

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Capture the call tab's audio and the agent's microphone for live transcription and scoring.",
  });
}

async function start(tabId: number, tabTitle: string): Promise<void> {
  if (state.phase === "live" || state.phase === "connecting") return;
  state = { ...IDLE, phase: "connecting", tabTitle, startedAt: Date.now() };
  publish();
  try {
    const settings = await loadSettings();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ to: "offscreen", type: "start", streamId, settings, title: tabTitle } satisfies ExtMessage);
  } catch (err) {
    state = { ...state, phase: "error", error: (err as Error).message };
    publish();
  }
}

function onLive(msg: Extract<ExtMessage, { type: "live" }>["payload"]): void {
  switch (msg.type) {
    case "ready":
      state = { ...state, phase: "live", callId: msg.callId, startedAt: Date.now() };
      break;
    case "utterance":
      state = { ...state, lastUtterances: [...state.lastUtterances, msg.utterance].slice(-6) };
      break;
    case "alert":
      state = { ...state, alerts: [msg.alert, ...state.alerts].slice(0, 20) };
      if (msg.alert.level === "critical") void chrome.action.setBadgeBackgroundColor({ color: "#7f1d1d" });
      break;
    case "checklist":
      state = { ...state, items: msg.items, provisionalScore: msg.provisionalScore };
      break;
    case "scoring":
      state = { ...state, phase: "scoring" };
      break;
    case "final":
      state = { ...state, phase: "done", callId: msg.callId, result: { score: msg.result.score, compliance: msg.result.compliance, criticalFailures: msg.result.criticalFailures } };
      void chrome.offscreen.closeDocument().catch(() => undefined);
      break;
    case "error":
      state = { ...state, phase: "error", error: msg.message };
      break;
    default:
      return;
  }
  publish();
}

chrome.runtime.onMessage.addListener((raw: ExtMessage, _sender, reply) => {
  if (raw.to !== "worker") return false;
  if (raw.type === "start") void start(raw.tabId, raw.tabTitle);
  else if (raw.type === "stop") chrome.runtime.sendMessage({ to: "offscreen", type: "stop" } satisfies ExtMessage).catch(() => undefined);
  else if (raw.type === "live") onLive(raw.payload);
  else if (raw.type === "closed") {
    if (state.phase === "live" || state.phase === "connecting") {
      state = { ...state, phase: "error", error: state.error ?? "Connection to the myCALL server closed." };
      publish();
    }
    void chrome.offscreen.closeDocument().catch(() => undefined);
  } else if (raw.type === "state?") {
    reply(state);
    return true;
  }
  return false;
});

// Service workers can be restarted; restore the last known state.
void chrome.storage.session.get("state").then((s) => {
  if (s.state) state = s.state as CallState;
});
