import path from "node:path";
import { reviewerFromEnv, type AiReviewer } from "../engine/reviewer.js";
import { deepgramFromEnv, type DeepgramConfig } from "../stt/deepgram.js";

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  /** When set, every /api request must carry this token (Authorization: Bearer header, or a short-lived signed URL from POST /api/sign). */
  apiToken: string | null;
  deepgram: DeepgramConfig | null;
  reviewer: AiReviewer | null;
  maxUploadMb: number;
  /** Directory with the built web app (vite build output). */
  webDir: string | null;
  demoSpeed: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT) || 8787,
    host: env.HOST || "0.0.0.0",
    dataDir: path.resolve(env.MYCALL_DATA_DIR || "data"),
    apiToken: env.MYCALL_API_TOKEN || null,
    deepgram: deepgramFromEnv(env),
    reviewer: reviewerFromEnv(env),
    maxUploadMb: Number(env.MYCALL_MAX_UPLOAD_MB) || 200,
    webDir: env.MYCALL_WEB_DIR === "" ? null : path.resolve(env.MYCALL_WEB_DIR || "dist/web"),
    demoSpeed: Number(env.MYCALL_DEMO_SPEED) || 2,
  };
}
