import type { Calibration, CallDetail, CallRecord, ReviewedStatus, Rubric } from "../../src/core/types.js";

const TOKEN_KEY = "mycall.token";
const REVIEWER_KEY = "mycall.reviewer";

/** The name review decisions are signed with (remembered on this device). */
export function getReviewer(): string {
  try {
    return localStorage.getItem(REVIEWER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setReviewer(name: string): void {
  try {
    localStorage.setItem(REVIEWER_KEY, name);
  } catch {
    /* storage unavailable — the name is kept for this page only */
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) — token lives for this page only */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
  const res = await fetch(path, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; details?: string[] | string };
    const details = Array.isArray(b.details) ? `\n${b.details.join("\n")}` : "";
    throw new ApiError((b.error ?? `Request failed (${res.status})`) + details, res.status);
  }
  return body as T;
}

export interface ServerConfig {
  transcription: boolean;
  transcriptionModel: string | null;
  aiReviewer: string | null;
  authRequired: boolean;
  maxUploadMb: number;
}

export const api = {
  config: () => request<ServerConfig>("/api/config"),
  rubrics: () => request<Rubric[]>("/api/rubrics"),
  saveRubric: (r: unknown) => request<Rubric>("/api/rubrics", { method: "POST", body: JSON.stringify(r) }),
  deleteRubric: (id: string) => request<void>(`/api/rubrics/${encodeURIComponent(id)}`, { method: "DELETE" }),
  calls: () => request<CallRecord[]>("/api/calls"),
  call: (id: string) => request<CallDetail>(`/api/calls/${id}`),
  upload: (form: FormData) => request<{ id: string }>("/api/calls", { method: "POST", body: form }),
  importText: (body: { transcript: string; rubricId: string; title?: string; agentName?: string; filename?: string }) =>
    request<{ id: string }>("/api/calls", { method: "POST", body: JSON.stringify(body) }),
  rescore: (id: string, body: { rubricId?: string; swapRoles?: boolean }) =>
    request<{ id: string }>(`/api/calls/${id}/rescore`, { method: "POST", body: JSON.stringify(body) }),
  remove: (id: string) => request<void>(`/api/calls/${id}`, { method: "DELETE" }),
  review: (id: string, criterionId: string, body: { status: ReviewedStatus; fraction?: number; note: string; reviewer: string }) =>
    request<CallDetail>(`/api/calls/${id}/review/${encodeURIComponent(criterionId)}`, { method: "PUT", body: JSON.stringify(body) }),
  undoReview: (id: string, criterionId: string, reviewer: string) =>
    request<CallDetail>(`/api/calls/${id}/review/${encodeURIComponent(criterionId)}`, { method: "DELETE", body: JSON.stringify({ reviewer }) }),
  lock: (id: string, reviewer: string, note: string) => request<CallDetail>(`/api/calls/${id}/lock`, { method: "POST", body: JSON.stringify({ reviewer, note }) }),
  unlock: (id: string, reviewer: string, note: string) => request<CallDetail>(`/api/calls/${id}/unlock`, { method: "POST", body: JSON.stringify({ reviewer, note }) }),
  calibration: (rubricId: string) => request<Calibration>(`/api/calibration/${encodeURIComponent(rubricId)}`),
  /** Download every call's results as a CSV spreadsheet. */
  downloadResults: async () => {
    const token = getToken();
    const res = await fetch("/api/calls.csv", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new ApiError(`Download failed (${res.status})`, res.status);
    const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "mycall-results.csv";
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  /** Short-lived signed URL for things that can't send headers (audio player, downloads). */
  signedUrl: async (path: string) => (await request<{ url: string }>("/api/sign", { method: "POST", body: JSON.stringify({ path }) })).url,
};
