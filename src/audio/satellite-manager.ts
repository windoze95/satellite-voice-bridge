import {
  openEspHomeClient,
  VoiceAssistantEvent,
  VoiceAssistantSubscribeFlag,
  type LifecycleEvent,
  type VoiceAssistantAudioData,
  type VoiceAssistantEventData,
  type VoiceAssistantRequest,
} from 'esphome-client';
import type { SatelliteConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { CommandRecord } from '../telemetry.js';
import { SatelliteAudioSource } from './satellite-source.js';

interface VoiceAssistantApiLike {
  subscribe(flags?: number): void;
  unsubscribe(): void;
  requests(options?: { signal?: AbortSignal }): AsyncIterable<VoiceAssistantRequest>;
  audio(options?: { signal?: AbortSignal }): AsyncIterable<VoiceAssistantAudioData>;
  respondToRequest(options?: { error?: boolean; port?: number }): void;
  sendEvent(eventType: number, data?: VoiceAssistantEventData[]): void;
}

interface SatelliteClientLike {
  voiceAssistant: VoiceAssistantApiLike;
  capabilities(): { voiceAssistant: { supported: boolean; apiAudio: boolean } };
  lifecycle(options?: { signal?: AbortSignal }): AsyncIterable<LifecycleEvent>;
  disconnectAsync(): Promise<void>;
}

export interface SatelliteConnectOptions {
  id: string;
  host: string;
  port: number;
  psk: string;
  logger: Logger;
}

export type OpenSatelliteClient = (options: SatelliteConnectOptions) => Promise<SatelliteClientLike>;

export interface SatelliteManagerOptions {
  satellites: Record<string, SatelliteConfig>;
  logger: Logger;
  getEncryptionKey: (entryId: string) => Promise<string>;
  runCommand: (source: SatelliteAudioSource, opts: { followUpIndex: number }) => Promise<CommandRecord>;
  openClient?: OpenSatelliteClient;
  /** How long to keep listening after a command. 0 disables follow-ups. */
  followUpMs?: number;
  /** Ceiling on chained follow-ups, so a noisy room cannot hold the mic open. */
  maxFollowUps?: number;
  /** Called when a follow-up chain ends, to drop its conversation history. */
  onChainEnd?: () => void;
}

interface Connection {
  id: string;
  client: SatelliteClientLike;
  abort: AbortController;
  tasks: Promise<void>[];
}

interface ActiveRun {
  satelliteId: string;
  api: VoiceAssistantApiLike;
  /** The turn currently consuming audio; null between turns. */
  current: SatelliteAudioSource | null;
  /**
   * Audio that arrived while no turn was consuming it — during the second or so
   * a command takes to execute. Without this, a follow-up spoken promptly after
   * the lights move would lose its opening syllables.
   */
  pending: Buffer[];
  pendingBytes: number;
  turnIndex: number;
  done: Promise<void>;
}

/** ~3 s of 16 kHz PCM16 mono: long enough to bridge a command, bounded so a silent room cannot grow it. */
const MAX_PENDING_BYTES = 96_000;

/** Owns the exclusive ESPHome voice-assistant subscription for all configured satellites. */
export class SatelliteManager {
  private readonly connections: Connection[] = [];
  private active: ActiveRun | null = null;
  private stopping = false;

  constructor(private readonly opts: SatelliteManagerOptions) {}

  async start(): Promise<void> {
    const configured = Object.entries(this.opts.satellites).filter(([, cfg]) => cfg.host);
    try {
      for (const [id, cfg] of configured) await this.connect(id, cfg);
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.active?.current?.fail(new Error('voicebridge is shutting down'));

    for (const connection of this.connections) {
      connection.abort.abort();
      try {
        connection.client.voiceAssistant.unsubscribe();
      } catch {
        // The socket may already be gone.
      }
    }
    await Promise.allSettled(this.connections.map((connection) => connection.client.disconnectAsync()));
    await Promise.allSettled(this.connections.flatMap((connection) => connection.tasks));
    if (this.active) await Promise.allSettled([this.active.done]);
    this.connections.length = 0;
  }

  private async connect(id: string, cfg: SatelliteConfig): Promise<void> {
    const host = cfg.host;
    if (!host) return;
    const psk = await this.resolveEncryptionKey(id, cfg);
    const client = await (this.opts.openClient ?? openRealClient)({ id, host, port: cfg.port, psk, logger: this.opts.logger });
    const capabilities = client.capabilities().voiceAssistant;
    if (!capabilities.supported || !capabilities.apiAudio) {
      await client.disconnectAsync();
      throw new Error(`Satellite ${id} does not advertise ESPHome voice-assistant API audio support`);
    }

    const connection: Connection = { id, client, abort: new AbortController(), tasks: [] };
    this.connections.push(connection);
    const api = client.voiceAssistant;
    connection.tasks.push(
      this.pumpRequests(connection, api),
      this.pumpAudio(connection),
      this.pumpLifecycle(connection),
    );
    api.subscribe(VoiceAssistantSubscribeFlag.API_AUDIO);
    this.opts.logger.info('satellite connected', { satellite: id, host, port: cfg.port });
  }

  private async resolveEncryptionKey(id: string, cfg: SatelliteConfig): Promise<string> {
    if (cfg.encryptionKey) return cfg.encryptionKey;
    if (!cfg.haEntryId) {
      throw new Error(
        `Satellite ${id} needs ha_entry_id or encryption_key_env in voicebridge.yaml; the key itself must not be stored in YAML`,
      );
    }
    return this.opts.getEncryptionKey(cfg.haEntryId);
  }

  private async pumpRequests(connection: Connection, api: VoiceAssistantApiLike): Promise<void> {
    try {
      for await (const request of api.requests({ signal: connection.abort.signal })) {
        if (request.start) this.beginRun(connection.id, api);
        else if (this.active?.satelliteId === connection.id) {
          this.active.current?.fail(new Error('Satellite cancelled the active voice request'));
        }
      }
    } catch (err) {
      if (!connection.abort.signal.aborted) this.handleConnectionFailure(connection.id, err);
    }
  }

  private async pumpAudio(connection: Connection): Promise<void> {
    try {
      for await (const chunk of connection.client.voiceAssistant.audio({ signal: connection.abort.signal })) {
        const active = this.active;
        if (!active || active.satelliteId !== connection.id) continue;
        const turn = active.current;
        if (turn?.accepting === true) {
          turn.push(chunk.data);
          if (chunk.end) turn.end();
          continue;
        }
        // Between turns: hold the audio for whichever turn opens next, dropping
        // the oldest first so a long silence cannot grow this without bound.
        active.pending.push(chunk.data);
        active.pendingBytes += chunk.data.length;
        while (active.pendingBytes > MAX_PENDING_BYTES && active.pending.length > 0) {
          active.pendingBytes -= active.pending.shift()!.length;
        }
      }
    } catch (err) {
      if (!connection.abort.signal.aborted) this.handleConnectionFailure(connection.id, err);
    }
  }

  private async pumpLifecycle(connection: Connection): Promise<void> {
    try {
      for await (const event of connection.client.lifecycle({ signal: connection.abort.signal })) {
        if (event.kind === 'disconnect') this.handleConnectionFailure(connection.id, event.cause);
      }
    } catch (err) {
      if (!connection.abort.signal.aborted) this.handleConnectionFailure(connection.id, err);
    }
  }

  private beginRun(satelliteId: string, api: VoiceAssistantApiLike): void {
    if (this.stopping) {
      this.declineRun(api, 'voicebridge is shutting down');
      return;
    }
    if (this.active) {
      this.opts.logger.warn('satellite request declined while another command is active', {
        satellite: satelliteId,
        active_satellite: this.active.satelliteId,
      });
      this.declineRun(api, 'Another voice command is already active');
      return;
    }

    const active: ActiveRun = {
      satelliteId,
      api,
      current: null,
      pending: [],
      pendingBytes: 0,
      turnIndex: 0,
      done: Promise.resolve(),
    };
    this.active = active;

    this.sendSafe(api, () => api.respondToRequest());
    this.sendSafe(api, () => api.sendEvent(VoiceAssistantEvent.RUN_START));
    this.sendSafe(api, () => api.sendEvent(VoiceAssistantEvent.STT_START));

    active.done = this.driveRun(active);
  }

  /**
   * One wake word, one or more utterances.
   *
   * The ESPHome run is deliberately left open after a command: the device stops
   * streaming when it receives STT_VAD_END, so withholding that event is what
   * keeps the microphone live for a follow-up. The run ends — and only then does
   * the device hear STT_VAD_END and RUN_END — when nobody speaks inside the
   * window, when the model judges what it heard to be ordinary conversation,
   * when a command fails, or when the chain hits its cap.
   */
  private async driveRun(active: ActiveRun): Promise<void> {
    const followUpMs = this.opts.followUpMs ?? 0;
    const maxFollowUps = this.opts.maxFollowUps ?? 0;

    try {
      for (;;) {
        const source = this.openTurn(active);
        // Only a follow-up gets a deadline; the first utterance after a wake
        // word is already bounded by the pipeline's own no-speech grace.
        const deadline =
          active.turnIndex > 0 && followUpMs > 0
            ? setTimeout(() => source.expire(), followUpMs)
            : null;
        deadline?.unref?.();

        let record: CommandRecord;
        try {
          record = await this.opts.runCommand(source, { followUpIndex: active.turnIndex });
        } finally {
          if (deadline) clearTimeout(deadline);
          if (active.current === source) active.current = null;
        }

        const windowExpired = source.expired && !source.speechDetected;
        if (!windowExpired) this.reportTurn(active, record);

        if (
          this.stopping ||
          windowExpired ||
          followUpMs <= 0 ||
          active.turnIndex >= maxFollowUps ||
          !this.invitesFollowUp(record)
        ) {
          break;
        }
        active.turnIndex++;
        this.opts.logger.debug('listening for a follow-up', {
          satellite: active.satelliteId,
          follow_up: active.turnIndex,
          window_ms: followUpMs,
        });
      }
    } catch (err) {
      active.current?.stop();
      this.sendError(active.api, err instanceof Error ? err.message : String(err));
      this.finishRun(active);
      return;
    }

    // Ends the chain: the device closes its microphone here and not before.
    this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.STT_VAD_END));
    this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.RUN_END));
    this.finishRun(active);
  }

  private finishRun(active: ActiveRun): void {
    active.pending.length = 0;
    active.pendingBytes = 0;
    if (this.active === active) this.active = null;
    // Retained history is what let "now dim it a bit" work; it has no business
    // colouring the next person who says the wake word.
    this.opts.onChainEnd?.();
  }

  /** A fresh turn on the same open run, primed with anything heard in between. */
  private openTurn(active: ActiveRun): SatelliteAudioSource {
    const source = new SatelliteAudioSource(active.satelliteId, {
      onSpeechStarted: () => this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.STT_VAD_START)),
      // Deliberately does NOT send STT_VAD_END: that is the event that makes the
      // device stop its microphone, and it belongs to the end of the chain.
      onStop: () => undefined,
    });
    active.current = source;
    for (const chunk of active.pending) source.push(chunk);
    active.pending.length = 0;
    active.pendingBytes = 0;
    return source;
  }

  /** Report one turn's outcome on the ESPHome pipeline-progress channel. */
  private reportTurn(active: ActiveRun, record: CommandRecord): void {
    if (record.transcript) {
      const data: VoiceAssistantEventData[] = [{ name: 'text', value: record.transcript.slice(0, 500) }];
      this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.STT_END, data));
    }
    if (record.error || record.outcome === 'error') {
      this.sendErrorEvent(active.api, record.error ?? 'Voice command failed');
      return;
    }
    this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.INTENT_START));
    this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.INTENT_END));
  }

  /**
   * Whether to keep the microphone open after this turn.
   *
   * Only a command that actually did something earns a follow-up. A dismissal
   * means the model decided it was overhearing the room, and continuing to
   * listen is exactly the wrong response to that.
   */
  private invitesFollowUp(record: CommandRecord): boolean {
    if (record.dismissed) return false;
    return record.outcome === 'executed' || record.outcome === 'dry_run';
  }

  private handleConnectionFailure(satelliteId: string, err: unknown): void {
    if (this.active?.satelliteId === satelliteId) {
      this.active.current?.fail(new Error('Satellite connection closed during the voice request'));
    }
    this.opts.logger.warn('satellite stream closed', {
      satellite: satelliteId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  private declineRun(api: VoiceAssistantApiLike, message: string): void {
    this.sendSafe(api, () => api.respondToRequest({ error: true }));
    this.sendError(api, message, 'voicebridge_busy');
  }

  /** Report an error mid-chain, leaving the run open. */
  private sendErrorEvent(api: VoiceAssistantApiLike, message: string, code = 'voicebridge_error'): void {
    const data: VoiceAssistantEventData[] = [
      { name: 'code', value: code },
      { name: 'message', value: message.slice(0, 200) },
    ];
    this.sendSafe(api, () => api.sendEvent(VoiceAssistantEvent.ERROR, data));
  }

  /** Report an error AND end the run: the microphone closes here. */
  private sendError(api: VoiceAssistantApiLike, message: string, code = 'voicebridge_error'): void {
    this.sendErrorEvent(api, message, code);
    this.sendSafe(api, () => api.sendEvent(VoiceAssistantEvent.STT_VAD_END));
    this.sendSafe(api, () => api.sendEvent(VoiceAssistantEvent.RUN_END));
  }

  private sendSafe(api: VoiceAssistantApiLike, send: () => void): void {
    try {
      send();
    } catch (err) {
      this.opts.logger.warn('satellite event send failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function openRealClient(options: SatelliteConnectOptions): Promise<SatelliteClientLike> {
  const logger = {
    debug: (message: string): void => options.logger.debug(`esphome[${options.id}]: ${message}`),
    info: (message: string): void => options.logger.info(`esphome[${options.id}]: ${message}`),
    warn: (message: string): void => options.logger.warn(`esphome[${options.id}]: ${message}`),
    error: (message: string): void => options.logger.error(`esphome[${options.id}]: ${message}`),
  };
  return openEspHomeClient({
    host: options.host,
    port: options.port,
    psk: options.psk,
    clientId: 'voicebridge',
    logger,
  });
}
