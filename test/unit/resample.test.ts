import { describe, expect, it } from 'vitest';
import { Pcm16Le16kTo24kResampler, resamplePcm16Le16kTo24k } from '../../src/audio/resample.js';

function pcm(...samples: number[]): Buffer {
  const result = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
  return result;
}

function samples(buffer: Buffer): number[] {
  const result: number[] = [];
  for (let offset = 0; offset < buffer.length; offset += 2) result.push(buffer.readInt16LE(offset));
  return result;
}

describe('Pcm16Le16kTo24kResampler', () => {
  it('linearly interpolates a simple 3:2 conversion exactly', () => {
    expect(samples(resamplePcm16Le16kTo24k(pcm(0, 3000, 6000, 9000)))).toEqual([
      0,
      2000,
      4000,
      6000,
      8000,
      9000,
    ]);
  });

  it('produces identical audio across arbitrary chunk boundaries', () => {
    const input = pcm(-12_000, -6000, 0, 6000, 12_000, 3000, -3000);
    const expected = resamplePcm16Le16kTo24k(input);
    const resampler = new Pcm16Le16kTo24kResampler();
    const chunks = [input.subarray(0, 4), input.subarray(4, 10), input.subarray(10, 12), input.subarray(12)];
    const actual = Buffer.concat([...chunks.map((chunk) => resampler.push(chunk)), resampler.end()]);

    expect(actual).toEqual(expected);
  });

  it('carries incomplete PCM samples across odd byte boundaries', () => {
    const input = pcm(-32_768, -3000, 0, 3000, 32_767);
    const expected = resamplePcm16Le16kTo24k(input);
    const resampler = new Pcm16Le16kTo24kResampler();
    const output: Buffer[] = [];

    for (const byte of input) output.push(resampler.push(Buffer.from([byte])));
    output.push(resampler.end());

    expect(Buffer.concat(output)).toEqual(expected);
  });

  it('flushes the held final sample and resets after end', () => {
    const resampler = new Pcm16Le16kTo24kResampler();
    expect(samples(resampler.push(pcm(1000, 4000)))).toEqual([1000, 3000]);
    expect(samples(resampler.end())).toEqual([4000]);

    expect(Buffer.concat([resampler.push(pcm(-3000, 0)), resampler.end()])).toEqual(
      resamplePcm16Le16kTo24k(pcm(-3000, 0)),
    );
    expect(resampler.end()).toEqual(Buffer.alloc(0));
  });

  it('reset discards samples and a pending odd byte', () => {
    const resampler = new Pcm16Le16kTo24kResampler();
    resampler.push(Buffer.from([0xff]));
    resampler.reset();

    expect(Buffer.concat([resampler.push(pcm(6000)), resampler.end()])).toEqual(pcm(6000, 6000));
  });

  it('rejects a dangling byte at end and remains reusable', () => {
    const resampler = new Pcm16Le16kTo24kResampler();
    resampler.push(Buffer.from([0x01]));

    expect(() => resampler.end()).toThrow(/odd byte count/);
    expect(Buffer.concat([resampler.push(pcm(2000)), resampler.end()])).toEqual(pcm(2000, 2000));
  });
});
