import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { parseRubric } from "../engine/rubric-schema.js";
import { builtInRubrics } from "../rubrics/index.js";
import { importTranscript, ImportError } from "../stt/import.js";
import type { AppConfig } from "./config.js";
import { Store } from "./db.js";
import { handleLiveSocket } from "./live.js";
import { Pipeline } from "./pipeline.js";

const AUDIO_EXT = /\.(wav|mp3|m4a|mp4|aac|ogg|oga|opus|webm|flac|wma|amr|mpeg|mpga)$/i;
const TRANSCRIPT_EXT = /\.(txt|vtt|srt|json)$/i;

const ImportBody = z.object({
  transcript: z.string().min(1).max(2_000_000),
  filename: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  agentName: z.string().max(120).optional(),
  rubricId: z.string().max(64),
});

/** Paths that may be opened with a signed URL instead of the Authorization header. */
const SIGNABLE = /^\/api\/(calls\/[0-9a-f-]{36}\/(audio|export)|live)$/;

const RescoreBody = z.object({ rubricId: z.string().max(64).optional(), swapRoles: z.boolean().optional() });

export interface App {
  app: FastifyInstance;
  store: Store;
  pipeline: Pipeline;
}

export async function buildApp(config: AppConfig): Promise<App> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      // Signed URLs carry a short-lived signature; keep it out of logs anyway.
      serializers: { req: (req) => ({ method: req.method, url: String(req.url).replace(/([?&]sig=)[^&]*/g, "$1[redacted]") }) },
    },
    bodyLimit: 5 * 1024 * 1024,
  });
  const store = new Store(config.dataDir);
  const pipeline = new Pipeline(store, config);

  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // ---- Auth: optional shared token (set MYCALL_API_TOKEN in production) ----
  // The token only ever travels in the Authorization header. Places that can't
  // send headers (<audio src>, downloads, WebSocket) use short-lived signed URLs
  // from POST /api/sign, scoped to one path.
  const bearerOk = (req: FastifyRequest) => {
    if (!config.apiToken) return true;
    const given = Buffer.from(req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "");
    const want = Buffer.from(config.apiToken);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const signature = (pathname: string, exp: number) => createHmac("sha256", config.apiToken ?? "").update(`${pathname}|${exp}`).digest("hex");
  const signedOk = (req: FastifyRequest) => {
    if (!config.apiToken) return false;
    const url = new URL(req.url, "http://x");
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig") ?? "";
    if (!SIGNABLE.test(url.pathname) || !Number.isFinite(exp) || exp < Date.now() / 1000) return false;
    const want = Buffer.from(signature(url.pathname, exp));
    const given = Buffer.from(sig);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  // The Chrome extension's setup page calls the API from a chrome-extension:// origin.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin?.startsWith("chrome-extension://") && req.url.startsWith("/api/")) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      reply.header("Access-Control-Allow-Methods", "GET, POST, DELETE");
      reply.header("Vary", "Origin");
      if (req.method === "OPTIONS") return reply.code(204).send();
    }
  });
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/health")) return;
    if (!bearerOk(req) && !signedOk(req)) return reply.code(401).send({ error: "Unauthorized" });
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });

  // ---- Meta ----
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/config", async () => ({
    transcription: Boolean(config.deepgram),
    transcriptionModel: config.deepgram?.model ?? null,
    aiReviewer: config.reviewer?.name ?? null,
    authRequired: Boolean(config.apiToken),
    maxUploadMb: config.maxUploadMb,
  }));

  /** Exchange the bearer token for a short-lived URL (audio player, download, live WebSocket). */
  app.post("/api/sign", async (req, reply) => {
    const path = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof path !== "string" || !SIGNABLE.test(path)) return reply.code(400).send({ error: "This path can't be signed." });
    if (!config.apiToken) return { url: path };
    const ttl = path === "/api/live" ? 60 : path.endsWith("/audio") ? 3600 : 300;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return { url: `${path}?exp=${exp}&sig=${signature(path, exp)}` };
  });

  // ---- Rubrics ----
  app.get("/api/rubrics", async () => pipeline.rubrics());
  app.get<{ Params: { id: string } }>("/api/rubrics/:id", async (req, reply) => pipeline.rubric(req.params.id) ?? reply.code(404).send({ error: "Rubric not found" }));
  app.post("/api/rubrics", async (req, reply) => {
    try {
      const rubric = parseRubric(req.body);
      store.saveRubric(rubric);
      return reply.code(201).send(rubric);
    } catch (err) {
      return reply.code(400).send({ error: "Invalid rubric", details: err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) : String(err) });
    }
  });
  app.delete<{ Params: { id: string } }>("/api/rubrics/:id", async (req, reply) => {
    if (!store.deleteRubric(req.params.id)) {
      const builtIn = builtInRubrics.some((r) => r.id === req.params.id);
      return reply.code(builtIn ? 400 : 404).send({ error: builtIn ? "Built-in rubrics can't be deleted" : "Rubric not found" });
    }
    return reply.code(204).send();
  });

  // ---- Calls ----
  app.get("/api/calls", async () => store.listCalls());

  app.get<{ Params: { id: string } }>("/api/calls/:id", async (req, reply) => {
    const call = store.getCall(req.params.id);
    if (!call) return reply.code(404).send({ error: "Call not found" });
    const { audioPath: _a, audioMime: _m, ...rest } = call;
    return rest;
  });

  /** Upload a recording (multipart "file") or a transcript file; fields: title, agentName, rubricId, separateChannels. */
  app.post("/api/calls", async (req, reply) => {
    if (!req.isMultipart()) {
      const parsed = ImportBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "Send a multipart upload, or JSON {transcript, rubricId}." });
      return createFromTranscript(parsed.data.transcript, parsed.data.filename ?? "", parsed.data, reply);
    }

    const fields: Record<string, string> = {};
    let saved: { path: string; mime: string; name: string } | null = null;
    let transcriptText: string | null = null;
    let transcriptName = "transcript.txt";
    const id = randomUUID();
    for await (const part of req.parts()) {
      if (part.type === "field") {
        fields[part.fieldname] = String(part.value).slice(0, 500);
        continue;
      }
      const name = part.filename || "upload";
      if (TRANSCRIPT_EXT.test(name)) {
        transcriptText = (await part.toBuffer()).toString("utf8");
        transcriptName = name;
      } else if (AUDIO_EXT.test(name) || part.mimetype.startsWith("audio/") || part.mimetype.startsWith("video/")) {
        const ext = (name.match(AUDIO_EXT)?.[1] ?? "bin").toLowerCase();
        const dest = path.join(store.audioDir, `${id}.${ext}`);
        await fs.promises.writeFile(dest, part.file);
        if (part.file.truncated) {
          await fs.promises.rm(dest, { force: true });
          return reply.code(413).send({ error: `File is larger than ${config.maxUploadMb} MB.` });
        }
        saved = { path: dest, mime: part.mimetype, name };
      } else {
        part.file.resume();
        return reply.code(415).send({ error: "Unsupported file. Upload audio (mp3, wav, m4a…) or a transcript (txt, vtt, srt, json)." });
      }
    }

    const rubric = pipeline.rubric(fields.rubricId ?? "");
    if (!rubric) {
      if (saved) await fs.promises.rm(saved.path, { force: true });
      return reply.code(400).send({ error: "Choose a valid rubric." });
    }
    if (transcriptText !== null) {
      return createFromTranscript(transcriptText, transcriptName, { ...fields, rubricId: rubric.id }, reply);
    }
    if (!saved) return reply.code(400).send({ error: "No file uploaded." });

    store.createCall({
      id,
      title: fields.title?.trim() || saved.name,
      agentName: fields.agentName?.trim() || null,
      source: "upload",
      rubricId: rubric.id,
      audioPath: saved.path,
      audioMime: saved.mime,
    });
    const sep = fields.separateChannels;
    pipeline.enqueueAudio(id, rubric, sep === "true" ? true : sep === "false" ? false : null);
    return reply.code(202).send({ id });
  });

  async function createFromTranscript(
    text: string,
    filename: string,
    meta: { title?: string; agentName?: string; rubricId: string },
    reply: import("fastify").FastifyReply,
  ) {
    const rubric = pipeline.rubric(meta.rubricId);
    if (!rubric) return reply.code(400).send({ error: "Choose a valid rubric." });
    let transcript;
    try {
      transcript = importTranscript(text, filename);
    } catch (err) {
      if (err instanceof ImportError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    const id = randomUUID();
    store.createCall({ id, title: meta.title?.trim() || filename || "Imported transcript", agentName: meta.agentName?.trim() || null, source: "import", rubricId: rubric.id });
    pipeline.enqueueScore(id, rubric, transcript);
    return reply.code(202).send({ id });
  }

  app.post<{ Params: { id: string } }>("/api/calls/:id/rescore", async (req, reply) => {
    const body = RescoreBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const call = store.getCall(req.params.id);
    if (!call) return reply.code(404).send({ error: "Call not found" });
    if (call.status === "processing") return reply.code(409).send({ error: "This call is still being processed." });
    const rubric = pipeline.rubric(body.data.rubricId ?? call.rubricId);
    if (!rubric) return reply.code(400).send({ error: "Unknown rubric" });
    pipeline.rescore(call.id, rubric, Boolean(body.data.swapRoles));
    return reply.code(202).send({ id: call.id });
  });

  app.delete<{ Params: { id: string } }>("/api/calls/:id", async (req, reply) => {
    const audio = store.deleteCall(req.params.id);
    if (audio === null) return reply.code(404).send({ error: "Call not found" });
    if (audio) await fs.promises.rm(audio, { force: true });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/calls/:id/audio", async (req, reply) => {
    const call = store.getCall(req.params.id);
    if (!call?.audioPath || !fs.existsSync(call.audioPath)) return reply.code(404).send({ error: "No audio for this call" });
    reply.header("Content-Type", call.audioMime || "application/octet-stream");
    return reply.sendFile(path.basename(call.audioPath), path.dirname(call.audioPath));
  });

  /** Evidence packet: the full scored record plus a SHA-256 fingerprint for audit files. */
  app.get<{ Params: { id: string } }>("/api/calls/:id/export", async (req, reply) => {
    const call = store.getCall(req.params.id);
    if (!call?.result) return reply.code(404).send({ error: "No scored result for this call" });
    const { audioPath: _a, audioMime: _m, ...record } = call;
    const rubric = pipeline.rubric(call.rubricId);
    const body = { exportedAt: new Date().toISOString(), call: record, rubric };
    const json = JSON.stringify(body, null, 2);
    const sha256 = createHash("sha256").update(json).digest("hex");
    reply.header("Content-Disposition", `attachment; filename="mycall-${call.id}.json"`);
    reply.header("X-Content-SHA256", sha256);
    return reply.type("application/json").send(json);
  });

  // ---- Live calls ----
  app.get("/api/live", { websocket: true }, (socket) => handleLiveSocket(socket, { store, pipeline, config }));

  // ---- Web app ----
  if (config.webDir && fs.existsSync(path.join(config.webDir, "index.html"))) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  } else {
    await app.register(fastifyStatic, { root: store.audioDir, serve: false });
  }

  app.addHook("onClose", async () => {
    await pipeline.idle();
    store.close();
  });

  return { app, store, pipeline };
}
