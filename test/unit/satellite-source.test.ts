import { describe, expect, it, vi } from 'vitest';
import { SatelliteAudioSource } from '../../src/audio/satellite-source.js';
import { resamplePcm16Le16kTo24k } from '../../src/audio/resample.js';

function pcm(...samples: number[]): Buffer {
  const result = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
  return result;
}

async function collect(source: SatelliteAudioSource): Promise<Buffer> {
  const frames: Buffer[] = [];
  for await (const frame of source.frames()) frames.push(frame);
  return Buffer.concat(frames);
}

describe('SatelliteAudioSource', () => {
  it('buffers 16 kHz packets and yields a continuous 24 kHz stream', async () => {
    const input = pcm(-9000, -3000, 3000, 9000, 0);
    const source = new SatelliteAudioSource('sat-test');
    source.push(input.subarray(0, 3));
    source.push(input.subarray(3, 8));
    source.push(input.subarray(8));
    source.end();

    expect(await collect(source)).toEqual(resamplePcm16Le16kTo24k(input));
  });

  it('waits for live packets instead of treating an empty queue as end-of-stream', async () => {
    const source = new SatelliteAudioSource('sat-test');
    const output = collect(source);
    await Promise.resolve();
    source.push(pcm(1000, 4000));
    source.end();

    expect(await output).toEqual(resamplePcm16Le16kTo24k(pcm(1000, 4000)));
  });

  it('stops once, drops buffered audio, and releases a waiting consumer', async () => {
    const onStop = vi.fn();
    const source = new SatelliteAudioSource('sat-test', { onStop });
    const output = collect(source);
    source.push(pcm(1000, 2000));
    source.stop();
    source.stop();

    await expect(output).resolves.toEqual(Buffer.alloc(0));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('reports the first Realtime speech-start event exactly once', () => {
    const onSpeechStarted = vi.fn();
    const source = new SatelliteAudioSource('sat-test', { onSpeechStarted });

    source.speechStarted();
    source.speechStarted();

    expect(onSpeechStarted).toHaveBeenCalledTimes(1);
  });

  it('surfaces device cancellation to the pipeline', async () => {
    const source = new SatelliteAudioSource('sat-test');
    const output = collect(source);
    source.fail(new Error('satellite cancelled request'));

    await expect(output).rejects.toThrow(/cancelled/);
  });

  it('fails closed when setup latency exhausts the bounded audio buffer', async () => {
    const source = new SatelliteAudioSource('sat-test', { maxBufferedBytes: 4 });
    source.push(pcm(0, 1000, 2000));

    await expect(collect(source)).rejects.toThrow(/buffer exceeded/);
  });

  it('allows only one Realtime consumer for an utterance', async () => {
    const source = new SatelliteAudioSource('sat-test');
    source.end();
    await collect(source);

    await expect(collect(source)).rejects.toThrow(/only be consumed once/);
  });
});
