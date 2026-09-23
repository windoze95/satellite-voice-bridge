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
import { FakeSatelliteFirmware } from '../mocks/fake-satellite-firmware.js';

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
  /** Every event we send is applied to a model of the real device firmware. */
  readonly firmware = new FakeSatelliteFirmware();
  subscribedWith: number | undefined;
  unsubscribed = false;

  subscribe(flags?: number): void { this.subscribedWith = flags; }
  unsubscribe(): void { this.unsubscribed = true; }
  requests(options?: { signal?: AbortSignal }): AsyncIterable<VoiceAssistantRequest> { return this.requestQueue.iterate(options?.signal); }
  audio(options?: { signal?: AbortSignal }): AsyncIterable<VoiceAssistantAudioData> { return this.audioQueue.iterate(options?.signal); }
  respondToRequest(options?: { error?: boolean; port?: number }): void {
    this.responses.push(options);
    if (options?.error !== true) this.firmware.wake();
  }
  sendEvent(type: number, data?: Array<{ name: string; value: string }>): void {
    this.events.push({ type, data });
    this.firmware.onEvent(type);
  }
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
    // With follow-ups off this is the long-proven order: STT_VAD_END stops the
    // microphone at end of speech, and the later RUN_END finds the device
    // settled in AWAITING_RESPONSE and returns it to IDLE.
    expect(client.voiceAssistant.events.map((event) => event.type).slice(0, 8)).toEqual([
      VoiceAssistantEvent.RUN_START,
      VoiceAssistantEvent.STT_START,
      VoiceAssistantEvent.STT_VAD_START,
      VoiceAssistantEvent.STT_VAD_END,
      VoiceAssistantEvent.STT_END,
      VoiceAssistantEvent.INTENT_START,
      VoiceAssistantEvent.INTENT_END,
      VoiceAssistantEvent.RUN_END,
    ]);
    // The modelled device must be back to idle, not parked mid-run.
    await vi.waitFor(() => expect(client.voiceAssistant.firmware.state).toBe('IDLE'));
    expect(client.voiceAssistant.firmware.stranded).toBe(false);
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
    expect(secondClient.voiceAssistant.events.map((event) => event.type).slice(0, 2)).toEqual([
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
    expect(client.voiceAssistant.events.some((e) => e.type === VoiceAssistantEvent.ERROR)).toBe(true);
    expect(client.voiceAssistant.events.find((e) => e.type === VoiceAssistantEvent.ERROR)?.data).toContainEqual({
      name: 'code',
      value: 'voicebridge_error',
    });
    await vi.waitFor(() => expect(client.voiceAssistant.firmware.state).toBe('IDLE'));
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
    expect(client.voiceAssistant.events.some((e) => e.type === VoiceAssistantEvent.ERROR)).toBe(true);

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


  it('leaves the device idle even when the command finishes instantly', async () => {
    // The production strand: a dismissal or dry-run can complete in the same
    // tick the microphone was told to stop, so STT_VAD_END and RUN_END land
    // together and RUN_END matches nothing. The rescue RUN_END must recover it.
    const client = new FakeClient();
    const manager = new SatelliteManager({
      satellites: { first: cfg },
      logger,
      getEncryptionKey: async () => Buffer.alloc(32, 9).toString('base64'),
      openClient: async () => client,
      runCommand: async (source) => {
        source.stop(); // end of speech and end of command in one breath
        return record('no_action', undefined, 'never mind', { reason: 'background_speech' });
      },
    });
    await manager.start();
    client.voiceAssistant.requestQueue.push({ start: true, flags: 0 });

    await vi.waitFor(() => expect(client.voiceAssistant.firmware.state).toBe('IDLE'), { timeout: 3000 });
    expect(client.voiceAssistant.firmware.stranded).toBe(false);
    await manager.stop();
  });

  it('re-subscribes after the satellite drops, instead of going quietly deaf', async () => {
    // A device reboot or Wi-Fi blip used to leave the bridge connected but
    // unsubscribed: logs quiet, entities flowing, wake word doing nothing.
    const clients: FakeClient[] = [];
    const manager = new SatelliteManager({
      satellites: { first: cfg },
      logger,
      getEncryptionKey: async () => Buffer.alloc(32, 10).toString('base64'),
      openClient: async () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
      reconnectBaseMs: 20,
      reconnectCapMs: 40,
      runCommand: async (source) => {
        await collect(source);
        return record('executed', undefined, 'ok');
      },
    });
    await manager.start();
    expect(clients).toHaveLength(1);
    expect(clients[0]!.voiceAssistant.subscribedWith).toBe(VoiceAssistantSubscribeFlag.API_AUDIO);

    clients[0]!.lifecycleQueue.push({ kind: 'disconnect' });

    // A fresh connection is made AND the audio subscription re-claimed.
    await vi.waitFor(() => expect(clients.length).toBeGreaterThan(1), { timeout: 3000 });
    await vi.waitFor(() =>
      expect(clients.at(-1)!.voiceAssistant.subscribedWith).toBe(VoiceAssistantSubscribeFlag.API_AUDIO),
    );

    // And the replacement actually serves commands.
    const fresh = clients.at(-1)!;
    fresh.voiceAssistant.requestQueue.push({ start: true, flags: 0 });
    await vi.waitFor(() => expect(fresh.voiceAssistant.responses).toEqual([undefined]));
    await manager.stop();
  });

  it('keeps retrying a satellite that is still rebooting', async () => {
    let attempts = 0;
    const good = new FakeClient();
    const manager = new SatelliteManager({
      satellites: { first: cfg },
      logger,
      getEncryptionKey: async () => Buffer.alloc(32, 11).toString('base64'),
      openClient: async () => {
        attempts++;
        if (attempts === 1) return good;
        if (attempts < 4) throw new Error('connection refused');
        return good;
      },
      reconnectBaseMs: 15,
      reconnectCapMs: 30,
      runCommand: async () => record('no_action'),
    });
    await manager.start();
    good.lifecycleQueue.push({ kind: 'disconnect' });

    // A satellite that is merely power-cycling comes back; one failed dial
    // must not end the retry.
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(4), { timeout: 5000 });
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
      // RUN_END arrives while the device is still streaming, which is the one
      // state where it both stops the mic and returns to IDLE.
      await vi.waitFor(() => expect(client.voiceAssistant.firmware.state).toBe('IDLE'));
      expect(client.voiceAssistant.firmware.stranded).toBe(false);
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
      await vi.waitFor(() => expect(client.voiceAssistant.firmware.state).toBe('IDLE'));
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
