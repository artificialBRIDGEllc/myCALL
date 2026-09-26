import fs from "node:fs/promises";
import type { Rubric, Transcript } from "../core/types.js";
import { scoreCall } from "../engine/score.js";
import { builtInRubrics } from "../rubrics/index.js";
import { applyRoleMap, swapRoles } from "../stt/roles.js";
import { transcribeRecording, wavChannels } from "../stt/deepgram.js";
import type { AppConfig } from "./config.js";
import type { Store } from "./db.js";

/**
 * Background processing for recorded calls: transcribe -> score -> save.
 * A small in-process queue caps concurrency so a bulk upload of 200 calls
 * doesn't hammer the STT/AI providers. Swap for a real queue (BullMQ, SQS)
 * when running more than one server.
 */
export class Pipeline {
  private queue: Array<() => Promise<void>> = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private store: Store,
    private config: AppConfig,
    private concurrency = 3,
  ) {}

  rubrics(): Rubric[] {
    const custom = this.store.listRubrics();
    const ids = new Set(custom.map((r) => r.id));
    return [...builtInRubrics.filter((r) => !ids.has(r.id)), ...custom];
  }

  rubric(id: string): Rubric | undefined {
    return this.rubrics().find((r) => r.id === id);
  }

  /** Recorded audio: transcribe, then score. */
  enqueueAudio(callId: string, rubric: Rubric, separateChannelsHint: boolean | null): void {
    this.enqueue(callId, async () => {
      const call = this.store.getCall(callId);
      if (!call?.audioPath) throw new Error("Audio file missing.");
      if (!this.config.deepgram) {
        throw new Error("Transcription is not configured. Add DEEPGRAM_API_KEY, or upload a transcript instead of audio.");
      }
      const audio = await fs.readFile(call.audioPath);
      const separate = separateChannelsHint ?? wavChannels(audio) === 2;
      const transcript = await transcribeRecording(this.config.deepgram, audio, call.audioMime ?? "application/octet-stream", separate);
      if (!transcript.utterances.length) throw new Error("No speech was detected in the recording.");
      this.store.saveTranscript(callId, transcript);
      await this.score(callId, rubric, transcript);
    });
  }

  /** Transcript already available (import or live call): score it. */
  enqueueScore(callId: string, rubric: Rubric, transcript: Transcript): void {
    this.store.saveTranscript(callId, transcript);
    this.enqueue(callId, () => this.score(callId, rubric, transcript));
  }

  /** Re-run scoring, optionally with another rubric or with agent/customer swapped. */
  rescore(callId: string, rubric: Rubric, swap: boolean): boolean {
    const call = this.store.getCall(callId);
    if (!call) return false;
    this.store.setProcessing(callId, rubric.id);
    if (!call.transcript) {
      if (call.audioPath) {
        this.enqueueAudio(callId, rubric, null);
        return true;
      }
      this.store.saveError(callId, "Nothing to score: no transcript or audio.");
      return true;
    }
    let transcript = call.transcript;
    if (swap) {
      const roleMap = swapRoles(transcript.roleMap);
      transcript = { ...transcript, roleMap, utterances: applyRoleMap(transcript.utterances, roleMap) };
    }
    this.enqueueScore(callId, rubric, transcript);
    return true;
  }

  /** Resolves when the queue is empty (tests, graceful shutdown). */
  idle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async score(callId: string, rubric: Rubric, transcript: Transcript): Promise<void> {
    const result = await scoreCall({ rubric, transcript, reviewer: this.config.reviewer });
    this.store.saveResult(callId, result);
  }

  private enqueue(callId: string, job: () => Promise<void>): void {
    this.queue.push(async () => {
      try {
        await job();
      } catch (err) {
        this.store.saveError(callId, err instanceof Error ? err.message : String(err));
      }
    });
    this.drain();
  }

  private drain(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void job().finally(() => {
        this.running--;
        this.drain();
        if (!this.running && !this.queue.length) this.idleWaiters.splice(0).forEach((r) => r());
      });
    }
  }
}
