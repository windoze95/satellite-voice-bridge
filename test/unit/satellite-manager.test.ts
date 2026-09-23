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

  /** True once everything pushed has been handed to the consumer. */
  get drained(): boolean {
    return this.items.length === 0;
  }

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

function record(
  outcome: Outcome,
  error?: string,
  transcript?: string,
  dismissed?: { reason: string },
): CommandRecord {
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
    dismissed,
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
    finishCommand();
    await vi.waitFor(() => expect(client.voiceAssistant.events.at(-1)?.type).toBe(VoiceAssistantEvent.RUN_END));

    expect(Buffer.concat(audio).length).toBeGreaterThan(nativePcm.length);
    // STT_VAD_END is what makes the device close its microphone, so it now sits
    // at the very end of the run rather than after the first utterance — that
    // ordering is the whole mechanism behind the follow-up window.
    expect(client.voiceAssistant.events.map((event) => event.type)).toEqual([
      VoiceAssistantEvent.RUN_START,
      VoiceAssistantEvent.STT_START,
      VoiceAssistantEvent.STT_VAD_START,
      VoiceAssistantEvent.STT_END,
      VoiceAssistantEvent.INTENT_START,
      VoiceAssistantEvent.INTENT_END,
      VoiceAssistantEvent.STT_VAD_END,
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
      VoiceAssistantEvent.STT_VAD_END,
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
    expect(client.voiceAssistant.events.at(-2)?.type).toBe(VoiceAssistantEvent.STT_VAD_END);
    expect(client.voiceAssistant.events.at(-3)?.type).toBe(VoiceAssistantEvent.ERROR);
    expect(client.voiceAssistant.events.at(-3)?.data).toContainEqual({ name: 'code', value: 'voicebridge_error' });
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
    expect(client.voiceAssistant.events.at(-3)?.type).toBe(VoiceAssistantEvent.ERROR);

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

  describe('the follow-up window', () => {
    /** A manager whose commands resolve on demand, one turn at a time. */
    function followUpHarness(opts: { followUpMs: number; maxFollowUps: number; outcomes: CommandRecord[] }) {
      const client = new FakeClient();
      const sources: SatelliteAudioSource[] = [];
      const chainEnds: number[] = [];
      const manager = new SatelliteManager({
        satellites: { first: cfg },
        logger,
        getEncryptionKey: async () => Buffer.alloc(32, 7).toString('base64'),
        openClient: async () => client,
        followUpMs: opts.followUpMs,
        maxFollowUps: opts.maxFollowUps,
        onChainEnd: () => chainEnds.push(Date.now()),
        runCommand: async (source, { followUpIndex }) => {
          sources.push(source);
          await collect(source);
          return opts.outcomes[followUpIndex] ?? record('no_action');
        },
      });
      return { client, sources, manager, chainEnds };
    }

    it('runs a second command on the same open mic, with no second wake word', async () => {
      const { client, sources, manager, chainEnds } = followUpHarness({
        followUpMs: 5_000,
        maxFollowUps: 3,
        outcomes: [record('executed', undefined, 'turn on the lights'), record('executed', undefined, 'dim it a bit')],
      });
      await manager.start();

      client.voiceAssistant.requestQueue.push({ start: true, flags: 0 });
      await vi.waitFor(() => expect(sources).toHaveLength(1));
      sources[0]!.speechStarted();
      client.voiceAssistant.audioQueue.push({ data: Buffer.alloc(512, 1), end: false });
      sources[0]!.stop();

      // A second turn opens with no new VoiceAssistantRequest from the device.
      await vi.waitFor(() => expect(sources).toHaveLength(2));
      expect(client.voiceAssistant.responses).toHaveLength(1);
      // The microphone is still open: STT_VAD_END has not been sent.
      expect(client.voiceAssistant.events.some((e) => e.type === VoiceAssistantEvent.STT_VAD_END)).toBe(false);

      sources[1]!.speechStarted();
      client.voiceAssistant.audioQueue.push({ data: Buffer.alloc(512, 2), end: false });
      sources[1]!.stop();
      await vi.waitFor(() => expect(sources).toHaveLength(3));
      // Third turn goes unanswered and the window closes it.
      await vi.waitFor(
        () => expect(client.voiceAssistant.events.at(-1)?.type).toBe(VoiceAssistantEvent.RUN_END),
        { timeout: 8_000 },
      );
      expect(client.voiceAssistant.events.at(-2)?.type).toBe(VoiceAssistantEvent.STT_VAD_END);
      expect(chainEnds).toHaveLength(1);
      await manager.stop();
    });

    it('closes the mic when the window passes without speech', async () => {
      const { client, sources, manager } = followUpHarness({
        followUpMs: 60,
        maxFollowUps: 3,
        outcomes: [record('executed', undefined, 'turn on the lights')],
      });
      await manager.start();

      client.voiceAssistant.requestQueue.push({ start: true, flags: 0 });
      await vi.waitFor(() => expect(sources).toHaveLength(1));
      sources[0]!.speechStarted();
      sources[0]!.stop();
      await vi.waitFor(() => expect(sources).toHaveLength(2));

      // Nobody speaks. The window expires the turn rather than leaving the
      // satellite streaming an empty room.
      await vi.waitFor(() => expect(sources[1]!.expired).toBe(true));
      await vi.waitFor(() => expect(client.voiceAssistant.events.at(-1)?.type).toBe(VoiceAssistantEvent.RUN_END));
      expect(client.voiceAssistant.events.at(-2)?.type).toBe(VoiceAssistantEvent.STT_VAD_END);
      await manager.stop();
    });

    it('does not listen on after speech the model judged to be background talk', async () => {
      const { client, sources, manager } = followUpHarness({
        followUpMs: 5_000,
        maxFollowUps: 3,
        outcomes: [record('no_action', undefined, 'yeah I know right', { reason: 'background_speech' })],
      });
      await manager.start();

      client.voiceAssistant.requestQueue.push({ start: true, flags: 0 });
      await vi.waitFor(() => expect(sources).toHaveLength(1));
      sources[0]!.speechStarted();
      sources[0]!.stop();

      // Continuing to listen is exactly the wrong answer to "that wasn't for me".
      await vi.waitFor(() => expect(client.voiceAssistant.events.at(-1)?.type).toBe(VoiceAssistantEvent.RUN_END));
      expect(sources).toHaveLength(1);
      await manager.stop();
    });

    it('stops chaining at max_follow_ups', async () => {
      const executed = record('executed', undefined, 'again');
      const { client, sources, manager } = followUpHarness({
        followUpMs: 5_000,
        maxFollowUps: 2,
        outcomes: [executed, executed, executed, executed],
      });
      await manager.start();

      client.voiceAssistant.requestQueue.push({ start: true, flags: 0 });
      for (let turn = 0; turn < 3; turn++) {
        await vi.waitFor(() => expect(sources).toHaveLength(turn + 1));
        sources[turn]!.speechStarted();
        sources[turn]!.stop();
      }
      await vi.waitFor(() => expect(client.voiceAssistant.events.at(-1)?.type).toBe(VoiceAssistantEvent.RUN_END));
      // One wake-word turn plus exactly two follow-ups.
      expect(sources).toHaveLength(3);
      await manager.stop();
    });

    it('carries audio heard between turns into the next one', async () => {
      const client = new FakeClient();
      const sources: SatelliteAudioSource[] = [];
      const collected: Buffer[] = [];
      let releaseFirstTurn!: () => void;
      const firstTurnGate = new Promise<void>((resolve) => { releaseFirstTurn = resolve; });

      const manager = new SatelliteManager({
        satellites: { first: cfg },
        logger,
        getEncryptionKey: async () => Buffer.alloc(32, 8).toString('base64'),
        openClient: async () => client,
        followUpMs: 5_000,
        maxFollowUps: 2,
        runCommand: async (source, { followUpIndex }) => {
          sources.push(source);
          const audio = await collect(source);
          collected[followUpIndex] = audio;
          // Hold turn 0 open past its own audio, so the next chunk arrives
          // while no turn is consuming — exactly the window a fast follow-up
          // lands in while the lights are still moving.
          if (followUpIndex === 0) await firstTurnGate;
          return record('executed', undefined, 'ok');
        },
      });
      await manager.start();

      client.voiceAssistant.requestQueue.push({ start: true, flags: 0 });
      await vi.waitFor(() => expect(sources).toHaveLength(1));
      sources[0]!.speechStarted();
      sources[0]!.stop();
      await vi.waitFor(() => expect(collected[0]).toBeDefined());

      // Spoken into the gap: no turn exists to receive this yet.
      client.voiceAssistant.audioQueue.push({ data: Buffer.alloc(1024, 9), end: false });
      await vi.waitFor(() => expect(client.voiceAssistant.audioQueue.drained).toBe(true));
      releaseFirstTurn();

      await vi.waitFor(() => expect(sources).toHaveLength(2));
      sources[1]!.speechStarted();
      sources[1]!.stop();
      await vi.waitFor(() => expect(collected[1]).toBeDefined());
      // The gap audio was replayed into the follow-up turn rather than dropped.
      expect(collected[1]!.length).toBeGreaterThan(0);
      await manager.stop();
    });
  });
});
