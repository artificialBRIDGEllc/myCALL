/**
 * Browser audio capture shared by the web app and the Chrome extension.
 *
 * Two sources are kept on separate channels so the server always knows who
 * is speaking, with no diarization guesswork:
 *   channel 0 = the agent's microphone
 *   channel 1 = the call audio (browser tab / softphone / Zoom / Meet), i.e. the customer
 */
export interface CaptureSources {
  mic: MediaStream | null;
  call: MediaStream | null;
}

export interface CaptureHandle {
  readonly sampleRate: number;
  readonly channels: 2;
  /** Current input levels 0..1 for VU meters. */
  levels(): { agent: number; customer: number };
  stop(): Promise<void>;
}

export const TARGET_SAMPLE_RATE = 16000;

export async function startCapture(
  sources: CaptureSources,
  workletUrl: string,
  onChunk: (pcm: ArrayBuffer) => void,
  opts: { playCallAudio?: boolean } = {},
): Promise<CaptureHandle> {
  if (!sources.mic && !sources.call) throw new Error("Nothing to capture: allow the microphone or share a tab.");
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.audioWorklet.addModule(workletUrl);
  if (ctx.state === "suspended") await ctx.resume();

  const merger = ctx.createChannelMerger(2);
  const analysers: Array<AnalyserNode | null> = [null, null];
  const nodes: AudioNode[] = [];
  const connect = (stream: MediaStream | null, channel: 0 | 1) => {
    if (!stream || !stream.getAudioTracks().length) return;
    const src = ctx.createMediaStreamSource(stream);
    // Down-mix whatever the source is (often stereo) to mono before placing it on its channel.
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = "explicit";
    mono.channelInterpretation = "speakers";
    src.connect(mono);
    mono.connect(merger, 0, channel);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    mono.connect(an);
    analysers[channel] = an;
    nodes.push(src, mono, an);
    // Tab capture through an extension mutes the tab; route it back to the speakers.
    if (channel === 1 && opts.playCallAudio) src.connect(ctx.destination);
  };
  connect(sources.mic, 0);
  connect(sources.call, 1);

  const worklet = new AudioWorkletNode(ctx, "pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "discrete",
    processorOptions: { targetRate: TARGET_SAMPLE_RATE },
  });
  worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onChunk(e.data);
  merger.connect(worklet);

  const buf = new Float32Array(512);
  const level = (an: AnalyserNode | null | undefined) => {
    if (!an) return 0;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / buf.length) * 4);
  };

  return {
    sampleRate: TARGET_SAMPLE_RATE,
    channels: 2,
    levels: () => ({ agent: level(analysers[0]), customer: level(analysers[1]) }),
    async stop() {
      worklet.port.onmessage = null;
      merger.disconnect();
      nodes.forEach((n) => n.disconnect());
      for (const s of [sources.mic, sources.call]) s?.getTracks().forEach((t) => t.stop());
      await ctx.close();
    },
  };
}

/** Ask the user to pick the tab (or window/screen) that has the call, with its audio. */
export async function pickCallTab(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, // Chrome only offers tab audio together with video; we ignore the video.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false } as MediaTrackConstraints,
    // Chrome hints: default to tabs, include system audio option, hide this app's own tab.
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    systemAudio: "include",
    surfaceSwitching: "include",
  } as DisplayMediaStreamOptions);
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No call audio was shared. Pick the call\'s tab and turn on "Also share tab audio".');
  }
  stream.getVideoTracks().forEach((t) => (t.enabled = false));
  return stream;
}

export async function getMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
}
