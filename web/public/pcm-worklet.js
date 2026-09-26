/**
 * AudioWorklet: takes a 2-channel input (ch0 = agent mic, ch1 = call/tab audio),
 * resamples to 16 kHz, converts to 16-bit PCM, and posts interleaved stereo
 * chunks (~100 ms) to the main thread, which streams them to the server.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = (options && options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.step = sampleRate / this.targetRate; // input samples per output sample
    this.pos = 0; // fractional read position carried across blocks
    this.acc = [0, 0];
    this.accN = 0;
    this.chunkFrames = Math.round(this.targetRate / 10);
    this.out = new Int16Array(this.chunkFrames * 2);
    this.outFrames = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    const right = input[1] || input[0].map(() => 0);
    for (let i = 0; i < left.length; i++) {
      // Box-filter decimation: average all input samples that fall in one output sample.
      this.acc[0] += left[i];
      this.acc[1] += right[i];
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.step) {
        this.pos -= this.step;
        for (let c = 0; c < 2; c++) {
          const v = Math.max(-1, Math.min(1, this.acc[c] / this.accN));
          this.out[this.outFrames * 2 + c] = v < 0 ? v * 0x8000 : v * 0x7fff;
          this.acc[c] = 0;
        }
        this.accN = 0;
        this.outFrames++;
        if (this.outFrames === this.chunkFrames) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(this.chunkFrames * 2);
          this.outFrames = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
