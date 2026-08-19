import { describe, expect, it, vi } from 'vitest';
import {
  VoiceAssistantEvent,
  VoiceAssistantSubscribeFlag,
  type LifecycleEvent,
  type VoiceAssistantAudioData,
  type VoiceAssistantRequest,
} from 'esphome-client';
import { SatelliteManager, type OpenSatelliteClient } from '../../src/audio/satellite-manager.js';
import type { SatelliteAudioSource } from '../../src/audio/satellite-source.js';
import type { SatelliteConfig } from '../../src/config.js';
import { Logger } from '../../src/logger.js';
import type { CommandRecord, Outcome } from '../../src/telemetry.js';

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters = new Set<() => void>();
  private closed = false;

  push(item: T): void {
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  async *iterate(signal?: AbortSignal): AsyncIterable<T> {
    while (!this.closed && !signal?.aborted) {
      const item = this.items.shift();
      if (item) {
        yield item;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    while (this.items.length > 0) yield this.items.shift()!;
  }

  private wake(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}

class FakeVoiceApi {
  readonly requestQueue = new AsyncQueue<VoiceAssistantRequest>();
  readonly audioQueue = new AsyncQueue<VoiceAssistantAudioData>();
  readonly events: Array<{ type: number; data?: Array<{ name: string; value: string }> }> = [];
  readonly responses: Array<{ error?: boolean; port?: number } | undefined> = [];
  subscribedWith: number | undefined;
  unsubscribed = false;

  subscribe(flags?: number): void { this.subscribedWith = flags; }
  unsubscribe(): void { this.unsubscribed = true; }
  requests(options?: { signal?: AbortSignal }): AsyncIterable<VoiceAssistantRequest> { return this.requestQueue.iterate(options?.signal); }
  audio(options?: { signal?: AbortSignal }): AsyncIterable<VoiceAssistantAudioData> { return this.audioQueue.iterate(options?.signal); }
  respondToRequest(options?: { error?: boolean; port?: number }): void { this.responses.push(options); }
  sendEvent(type: number, data?: Array<{ name: string; value: string }>): void { this.events.push({ type, data }); }
}

class FakeClient {
  readonly voiceAssistant = new FakeVoiceApi();
  readonly lifecycleQueue = new AsyncQueue<LifecycleEvent>();
  disconnected = false;
  capabilities(): { voiceAssistant: { supported: boolean; apiAudio: boolean } } {
    return { voiceAssistant: { supported: true, apiAudio: true } };
  }
  lifecycle(options?: { signal?: AbortSignal }): AsyncIterable<LifecycleEvent> {
    return this.lifecycleQueue.iterate(options?.signal);
  }
  async disconnectAsync(): Promise<void> {
    this.disconnected = true;
    this.voiceAssistant.requestQueue.close();
    this.voiceAssistant.audioQueue.close();
    this.lifecycleQueue.close();
  }
}

const logger = new Logger({ level: 'error', console: false });
const cfg: SatelliteConfig = {
  area: undefined,
  host: '192.168.20.135',
  port: 6053,
  haEntryId: 'entry-sat',
  encryptionKeyEnv: undefined,
  encryptionKey: undefined,
};

function record(outcome: Outcome, error?: string, transcript?: string): CommandRecord {
  return {
    ts: new Date(0).toISOString(),
    cmd_id: 'test',
    source: 'satellite',
    ok: !error,
    outcome,
    model: 'test',
    session_mode: 'test',
    function_calls: [],
    decisions: [],
    t: {},
    d: {},
    usage: { inputTextTokens: 0, inputAudioTokens: 0, cachedTextTokens: 0, cachedAudioTokens: 0, outputTextTokens: 0 },
    cost_usd: 0,
    error,
    transcript,
  };
}

async function collect(source: SatelliteAudioSource): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source.frames()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('SatelliteManager', () => {
  it('claims API audio, streams one utterance, and advances the Satellite lifecycle', async () => {
    const client = new FakeClient();
    const openClient = vi.fn(async () => client) as OpenSatelliteClient;
    const getEncryptionKey = vi.fn(async () => Buffer.alloc(32, 3).toString('base64'));
    const audio: Buffer[] = [];
    let activeSource: SatelliteAudioSource | undefined;
    let finishCommand!: () => void;
    const commandGate = new Promise<void>((resolve) => { finishCommand = resolve; });
    const manager = new SatelliteManager({
      satellites: { 'satellite1-d8b7a4': cfg },
      logger,
      getEncryptionKey,
      openClient,
      runCommand: async (source) => {
        activeSource = source;
        for await (const frame of source.frames()) audio.push(frame);
        await commandGate;
        return record('executed', undefined, 'turn off the kitchen lights');
      },
    });

    await manager.start();
    expect(getEncryptionKey).toHaveBeenCalledWith('entry-sat');
    expect(openClient).toHaveBeenCalledWith(expect.objectContaining({ host: '192.168.20.135', port: 6053 }));
    expect(client.voiceAssistant.subscribedWith).toBe(VoiceAssistantSubscribeFlag.API_AUDIO);

    client.voiceAssistant.requestQueue.push({ start: true, flags: 3, wakeWordPhrase: 'Hey Jarvis' });
    await vi.waitFor(() => expect(client.voiceAssistant.responses).toEqual([undefined]));
    expect(client.voiceAssistant.events.map((event) => event.type)).toEqual([
      VoiceAssistantEvent.RUN_START,
      VoiceAssistantEvent.STT_START,
    ]);

    activeSource!.speechStarted();
    expect(client.voiceAssistant.events.at(-1)?.type).toBe(VoiceAssistantEvent.STT_VAD_START);
    const nativePcm = Buffer.alloc(1024, 0x12);
    client.voiceAssistant.audioQueue.push({ data: nativePcm, end: false });
    await vi.waitFor(() => expect(audio.length).toBeGreaterThan(0));
    activeSource!.stop();
    await vi.waitFor(() => expect(client.voiceAssistant.events.at(-1)?.type).toBe(VoiceAssistantEvent.STT_VAD_END));
    finishCommand();
    await vi.waitFor(() => expect(client.voiceAssistant.events.at(-1)?.type).toBe(VoiceAssistantEvent.RUN_END));

    expect(Buffer.concat(audio).length).toBeGreaterThan(nativePcm.length);
    expect(client.voiceAssistant.events.map((event) => event.type)).toEqual([
      VoiceAssistantEvent.RUN_START,
      VoiceAssistantEvent.STT_START,
      VoiceAssistantEvent.STT_VAD_START,
      VoiceAssistantEvent.STT_VAD_END,
      VoiceAssistantEvent.STT_END,
      VoiceAssistantEvent.INTENT_START,
      VoiceAssistantEvent.INTENT_END,
      VoiceAssistantEvent.RUN_END,
    ]);
    expect(client.voiceAssistant.events.find((event) => event.type === VoiceAssistantEvent.STT_END)?.data).toEqual([
      { name: 'text', value: 'turn off the kitchen lights' },
    ]);
    await manager.stop();
    expect(client.voiceAssistant.unsubscribed).toBe(true);
    expect(client.disconnected).toBe(true);
  });

  it('declines a second wake request while a command is active', async () => {
    const firstClient = new FakeClient();
    const secondClient = new FakeClient();
    let finish!: () => void;
    const commandGate = new Promise<void>((resolve) => { finish = resolve; });
    const manager = new SatelliteManager({
      satellites: {
        first: cfg,
        second: { ...cfg, host: '192.168.20.136', haEntryId: 'entry-sat-2' },
      },
      logger,
      getEncryptionKey: async () => Buffer.alloc(32, 4).toString('base64'),
      openClient: async ({ id }) => id === 'first' ? firstClient : secondClient,
      runCommand: async (source) => {
        await commandGate;
        source.stop();
        return record('no_action');
      },
    });
    await manager.start();

    firstClient.voiceAssistant.requestQueue.push({ start: true, flags: 0 });
    await vi.waitFor(() => expect(firstClient.voiceAssistant.responses).toHaveLength(1));
    secondClient.voiceAssistant.requestQueue.push({ start: true, flags: 0 });
    await vi.waitFor(() => expect(secondClient.voiceAssistant.responses).toHaveLength(1));
    expect(secondClient.voiceAssistant.responses[0]).toEqual({ error: true });
    expect(secondClient.voiceAssistant.events.map((event) => event.type)).toEqual([
      VoiceAssistantEvent.ERROR,
      VoiceAssistantEvent.RUN_END,
    ]);
    expect(secondClient.voiceAssistant.events[0]?.data).toContainEqual({ name: 'code', value: 'voicebridge_busy' });
    finish();
    await vi.waitFor(() => expect(firstClient.voiceAssistant.events.at(-1)?.type).toBe(VoiceAssistantEvent.RUN_END));
    await manager.stop();
  });

  it('reports pipeline failures to the Satellite', async () => {
    const client = new FakeClient();
    const manager = new SatelliteManager({
      satellites: { first: cfg },
      logger,
      getEncryptionKey: async () => Buffer.alloc(32, 5).toString('base64'),
      openClient: async () => client,
      runCommand: async (source) => {
        source.stop();
        return record('error', 'OpenAI session failed');
      },
    });
    await manager.start();
    client.voiceAssistant.requestQueue.push({ start: true, flags: 0 });

    await vi.waitFor(() => expect(client.voiceAssistant.events.at(-1)?.type).toBe(VoiceAssistantEvent.RUN_END));
    expect(client.voiceAssistant.events.at(-2)?.type).toBe(VoiceAssistantEvent.ERROR);
    expect(client.voiceAssistant.events.at(-2)?.data).toContainEqual({ name: 'code', value: 'voicebridge_error' });
    expect(client.voiceAssistant.events.some((event) => event.type === VoiceAssistantEvent.STT_END)).toBe(false);
    await manager.stop();
  });

  it('fails an active turn on disconnect and accepts a later wake after reconnect', async () => {
    const client = new FakeClient();
    const sources: SatelliteAudioSource[] = [];
    const manager = new SatelliteManager({
      satellites: { first: cfg },
      logger,
      getEncryptionKey: async () => Buffer.alloc(32, 6).toString('base64'),
      openClient: async () => client,
      runCommand: async (source) => {
        sources.push(source);
        await collect(source);
        return record('executed', undefined, 'lights off');
      },
    });
    await manager.start();

    client.voiceAssistant.requestQueue.push({ start: true, flags: 0 });
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    client.voiceAssistant.audioQueue.push({ data: Buffer.alloc(1024), end: false });
    client.lifecycleQueue.push({ kind: 'disconnect' });
    await vi.waitFor(() => expect(client.voiceAssistant.events.at(-1)?.type).toBe(VoiceAssistantEvent.RUN_END));
    expect(client.voiceAssistant.events.at(-2)?.type).toBe(VoiceAssistantEvent.ERROR);

    client.lifecycleQueue.push({ kind: 'connect', encrypted: true });
    client.voiceAssistant.requestQueue.push({ start: true, flags: 0 });
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    sources[1]!.speechStarted();
    client.voiceAssistant.audioQueue.push({ data: Buffer.alloc(1024, 1), end: false });
    sources[1]!.stop();
    await vi.waitFor(() => expect(client.voiceAssistant.responses).toHaveLength(2));
    await vi.waitFor(() => {
      const runEnds = client.voiceAssistant.events.filter((event) => event.type === VoiceAssistantEvent.RUN_END);
      expect(runEnds).toHaveLength(2);
    });
    expect(client.voiceAssistant.responses).toEqual([undefined, undefined]);
    await manager.stop();
  });
});
