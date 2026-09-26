import type { CallDetail, CallRecord, Rubric } from "../../src/core/types.js";

const TOKEN_KEY = "mycall.token";

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
  /** Short-lived signed URL for things that can't send headers (audio player, downloads). */
  signedUrl: async (path: string) => (await request<{ url: string }>("/api/sign", { method: "POST", body: JSON.stringify({ path }) })).url,
};
