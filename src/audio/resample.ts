/**
 * Stateful PCM16LE mono resampler for Satellite1's 16 kHz audio and the
 * Realtime API's 24 kHz input. The 3:2 conversion uses linear interpolation
 * and keeps both sample and byte-boundary state between push() calls.
 */
export class Pcm16Le16kTo24kResampler {
  private pendingLowByte: number | null = null;
  private lastSample: number | null = null;
  private inputSampleCount = 0;
  /** Next output position, in thirds of a 16 kHz input-sample interval. */
  private nextOutputPosition = 0;

  /**
   * Consume any-sized PCM16LE chunk and return every output sample that can be
   * computed without guessing a future input sample.
   */
  push(chunk: Buffer): Buffer {
    const output: number[] = [];
    let offset = 0;

    if (this.pendingLowByte !== null && chunk.length > 0) {
      this.appendSample(toSigned16(this.pendingLowByte | (chunk[0]! << 8)), output);
      this.pendingLowByte = null;
      offset = 1;
    }

    while (offset + 1 < chunk.length) {
      this.appendSample(chunk.readInt16LE(offset), output);
      offset += 2;
    }

    if (offset < chunk.length) this.pendingLowByte = chunk[offset]!;
    return encodePcm16Le(output);
  }

  /**
   * Finish the current stream. The final input sample is held long enough to
   * preserve the exact 3:2 output-rate duration, then all state is reset so the
   * instance can be reused for another utterance.
   */
  end(): Buffer {
    if (this.pendingLowByte !== null) {
      this.reset();
      throw new Error('incomplete PCM16LE sample: stream ended with an odd byte count');
    }

    const output: number[] = [];
    if (this.lastSample !== null) {
      const inputEndPosition = this.inputSampleCount * 3;
      while (this.nextOutputPosition < inputEndPosition) {
        output.push(this.lastSample);
        this.nextOutputPosition += 2;
      }
    }

    this.reset();
    return encodePcm16Le(output);
  }

  /** Discard a partial stream without producing a tail. */
  reset(): void {
    this.pendingLowByte = null;
    this.lastSample = null;
    this.inputSampleCount = 0;
    this.nextOutputPosition = 0;
  }

  private appendSample(sample: number, output: number[]): void {
    if (this.lastSample === null) {
      this.lastSample = sample;
      this.inputSampleCount = 1;
      output.push(sample);
      this.nextOutputPosition = 2;
      return;
    }

    const intervalStart = (this.inputSampleCount - 1) * 3;
    const intervalEnd = this.inputSampleCount * 3;
    while (this.nextOutputPosition <= intervalEnd) {
      const offset = this.nextOutputPosition - intervalStart;
      const interpolated = this.lastSample + ((sample - this.lastSample) * offset) / 3;
      output.push(clampInt16(Math.round(interpolated)));
      this.nextOutputPosition += 2;
    }

    this.lastSample = sample;
    this.inputSampleCount++;
  }
}

/** Convenience helper for complete, in-memory PCM16LE audio. */
export function resamplePcm16Le16kTo24k(input: Buffer): Buffer {
  const resampler = new Pcm16Le16kTo24kResampler();
  return Buffer.concat([resampler.push(input), resampler.end()]);
}

function toSigned16(value: number): number {
  return value >= 0x8000 ? value - 0x10000 : value;
}

function clampInt16(value: number): number {
  return Math.max(-0x8000, Math.min(0x7fff, value));
}

function encodePcm16Le(samples: readonly number[]): Buffer {
  const result = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) result.writeInt16LE(samples[i]!, i * 2);
  return result;
}
