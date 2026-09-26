import fs from "node:fs";

/**
 * Streams 16-bit PCM straight to a .wav file on disk (constant memory, any
 * call length). The header is written with placeholder sizes and patched on close.
 */
export class WavWriter {
  private fd: number;
  private bytes = 0;

  constructor(
    readonly filePath: string,
    private sampleRate: number,
    private channels: number,
  ) {
    this.fd = fs.openSync(filePath, "w");
    fs.writeSync(this.fd, header(sampleRate, channels, 0));
  }

  write(pcm: Buffer): void {
    fs.writeSync(this.fd, pcm);
    this.bytes += pcm.length;
  }

  get durationSec(): number {
    return this.bytes / (this.sampleRate * this.channels * 2);
  }

  close(): void {
    fs.writeSync(this.fd, header(this.sampleRate, this.channels, this.bytes), 0, 44, 0);
    fs.closeSync(this.fd);
  }
}

export function header(sampleRate: number, channels: number, dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
