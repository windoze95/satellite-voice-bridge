import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WavAudioSource } from '../../src/audio/wav-source.js';
import { loadConfig } from '../../src/config.js';
import { HAClient } from '../../src/ha/client.js';
import { Registry } from '../../src/ha/registry.js';
import { Logger } from '../../src/logger.js';
import { runCommand, type PipelineDeps } from '../../src/pipeline.js';
import { SessionManager } from '../../src/realtime/session.js';
import { MockHAServer } from '../mocks/mock-ha-server.js';
import { MockRealtimeServer, type MockRealtimeOptions } from '../mocks/mock-realtime-server.js';

const FFMPEG = process.env.VOICEBRIDGE_FFMPEG ?? 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const logger = new Logger({ level: 'error' });

/** Minimal 16 kHz mono PCM16 WAV with a sine tone — exercises the resample path. */
function writeSineWav(path: string, seconds: number, sampleRate = 16_000): void {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12_000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

async function makeDeps(rtOpts: MockRealtimeOptions): Promise<{ deps: PipelineDeps; rt: MockRealtimeServer }> {
  const cwd = mkdtempSync(join(tmpdir(), 'vb-audio-'));
  const ha = await MockHAServer.start();
  const rt = await MockRealtimeServer.start(rtOpts);
  const cfg = loadConfig({ OPENAI_API_KEY: 'sk-test', HA_URL: ha.url, HA_TOKEN: 'test-token', VOICEBRIDGE_REALTIME_URL: rt.url }, cwd);
  const registry = new Registry(logger, { voiceDomains: ['light'] });
  const haClient = new HAClient({ url: ha.url, token: 'test-token', logger, retry: false, onSync: (c) => registry.sync(c) });
  registry.attach(haClient);
  const sessions = new SessionManager({ mode: 'per_utterance', url: rt.url, apiKey: 'sk-test', model: cfg.session.model, transcribe: true, logger });
  cleanups.push(async () => {
    sessions.close();
    haClient.stop();
    await rt.close();
    await ha.close();
  });
  await haClient.start();
  return { deps: { cfg, logger, haClient, registry, sessions }, rt };
}

describe.skipIf(!hasFfmpeg)('WavAudioSource', () => {
  it('produces uniform 24 kHz PCM16 frames from a 16 kHz file, plus a silence tail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vb-wav-'));
    const wav = join(dir, 'tone.wav');
    writeSineWav(wav, 0.5);
    const source = new WavAudioSource(wav, { ffmpegPath: FFMPEG, pace: false, trailingSilenceMs: 200, frameMs: 40 });
    const frames: Buffer[] = [];
    for await (const frame of source.frames()) frames.push(frame);
    expect(frames.every((f) => f.length === 1920)).toBe(true); // 40 ms @ 24 kHz PCM16
    // ~0.5 s audio (≈13 frames) + 200 ms silence (5 frames)
    expect(frames.length).toBeGreaterThanOrEqual(15);
    const tail = frames[frames.length - 1]!;
    expect(tail.every((b) => b === 0)).toBe(true);
  });

  it('throws a clear error for a missing file', async () => {
    const source = new WavAudioSource('/nope/missing.wav', { ffmpegPath: FFMPEG, pace: false });
    await expect((async () => {
      for await (const _ of source.frames()) void _;
    })()).rejects.toThrow(/not found/);
  });
});

describe.skipIf(!hasFfmpeg)('audio pipeline (mock OpenAI VAD + mock HA)', () => {
  it('streams audio, VAD ends speech, function call executes', async () => {
    const args = JSON.stringify({ action: 'turn_off', domain: 'light', target: 'lights', area: 'kitchen' });
    const { deps, rt } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: args }] }, { text: 'Off.' }],
      speechStopAfterBytes: 24_000, // 0.5 s of 24 kHz PCM16
      transcript: 'turn off the kitchen lights',
    });
    const dir = mkdtempSync(join(tmpdir(), 'vb-wav-'));
    const wav = join(dir, 'cmd.wav');
    writeSineWav(wav, 1.5);
    const source = new WavAudioSource(wav, { ffmpegPath: FFMPEG, pace: false, trailingSilenceMs: 400 });

    const rec = await runCommand(deps, { kind: 'audio', source });

    expect(rec.outcome).toBe('executed');
    expect(rec.source).toBe('wav');
    expect(rec.transcript).toBe('turn off the kitchen lights');
    for (const key of ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'] as const) expect(rec.t[key]).toBeDefined();
    expect(rec.d.speech_to_action).toBeDefined();

    const session = rt.sessions[0];
    expect(session?.audio?.input.format).toEqual({ type: 'audio/pcm', rate: 24_000 });
    expect(session?.audio?.input.turn_detection?.type).toBe('server_vad');
    expect(session?.audio?.input.transcription).toEqual({ model: 'gpt-4o-mini-transcribe' });
  });
});
