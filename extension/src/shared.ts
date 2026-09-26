import type { ChecklistItem, LiveAlert, ScoreResult, Utterance } from "../../src/core/types.js";

export interface Settings {
  serverUrl: string;
  token: string;
  rubricId: string;
  agentName: string;
}

export const DEFAULT_SETTINGS: Settings = { serverUrl: "http://localhost:8787", token: "", rubricId: "medicare-tpmo", agentName: "" };

export async function loadSettings(): Promise<Settings> {
  const s = (await chrome.storage.local.get("settings")) as { settings?: Partial<Settings> };
  return { ...DEFAULT_SETTINGS, ...s.settings };
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ settings: s });
}

/** Live state kept by the service worker so the popup can be closed and reopened mid-call. */
export interface CallState {
  phase: "idle" | "connecting" | "live" | "scoring" | "done" | "error";
  tabTitle?: string;
  callId?: string;
  startedAt?: number;
  items: ChecklistItem[];
  alerts: LiveAlert[];
  lastUtterances: Utterance[];
  provisionalScore: number | null;
  result?: Pick<ScoreResult, "score" | "compliance" | "criticalFailures">;
  error?: string;
}

export const IDLE: CallState = { phase: "idle", items: [], alerts: [], lastUtterances: [], provisionalScore: null };

/** Messages between popup <-> service worker <-> offscreen document. */
export type ExtMessage =
  | { to: "worker"; type: "start"; tabId: number; tabTitle: string }
  | { to: "worker"; type: "stop" }
  | { to: "worker"; type: "state?" }
  | { to: "worker"; type: "live"; payload: import("../../src/core/types.js").LiveServerMessage }
  | { to: "worker"; type: "closed" }
  | { to: "offscreen"; type: "start"; streamId: string; settings: Settings; title: string }
  | { to: "offscreen"; type: "stop" }
  | { to: "popup"; type: "state"; state: CallState };
