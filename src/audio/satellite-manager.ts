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
  /** Reconnect backoff, first attempt. Doubles to reconnectCapMs. */
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
  /** How long to keep listening after a command. 0 disables follow-ups. */
  followUpMs?: number;
  /** Ceiling on chained follow-ups, so a noisy room cannot hold the mic open. */
  maxFollowUps?: number;
  /** Called when a follow-up chain ends, to drop its conversation history. */
  onChainEnd?: () => void;
}

interface Connection {
  id: string;
  cfg: SatelliteConfig;
  client: SatelliteClientLike;
  abort: AbortController;
  tasks: Promise<void>[];
  /** Set once this connection has been retired, so its pumps stop respawning it. */
  dead: boolean;
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

/** Long enough for the device to finish stopping its microphone. See endRun. */
const RUN_END_RESCUE_MS = 300;

/**
 * How the Satellite's own state machine reacts to what we send
 * (esphome/components/voice_assistant/voice_assistant.cpp, as built into the
 * running firmware). Getting this wrong strands the device, so it is written
 * down rather than inferred:
 *
 * - STT_VAD_END  → set_state_(STOP_MICROPHONE, AWAITING_RESPONSE). The device
 *   stops streaming, then waits for a response that — with no speaker and no
 *   TTS events — never comes. Only a later RUN_END rescues it.
 * - RUN_END      → from START_PIPELINE/STARTING_PIPELINE/STREAMING_MICROPHONE
 *   it does set_state_(STOP_MICROPHONE, IDLE), a clean finish. From
 *   AWAITING_RESPONSE it goes straight to IDLE. From STOP_MICROPHONE or
 *   STOPPING_MICROPHONE it matches NOTHING and the device is left stranded in
 *   AWAITING_RESPONSE with its LEDs mid-think.
 * - STT_VAD_START, STT_END, INTENT_START, INTENT_END → triggers only, no state
 *   change. Safe to send mid-chain to drive the device's UI.
 *
 * The trap: STT_VAD_END immediately followed by RUN_END. The mic has not
 * finished stopping, so RUN_END lands on STOPPING_MICROPHONE and does nothing.
 * Ending a chain therefore sends RUN_END *alone*, while the device is still
 * streaming, and lets RUN_END do the stopping.
 *
 * (`continue_conversation` on INTENT_END is the firmware's own follow-up
 * mechanism, but it is only consulted at RESPONSE_FINISHED, which is reached
 * solely through TTS playback. A speakerless bridge never gets there.)
 */

/** Owns the exclusive ESPHome voice-assistant subscription for all configured satellites. */
export class SatelliteManager {
  private readonly connections: Connection[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly attempts = new Map<string, number>();
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
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
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

    const connection: Connection = { id, cfg, client, abort: new AbortController(), tasks: [], dead: false };
    this.connections.push(connection);
    const api = client.voiceAssistant;
    connection.tasks.push(
      this.pumpRequests(connection, api),
      this.pumpAudio(connection),
      this.pumpLifecycle(connection),
    );
    api.subscribe(VoiceAssistantSubscribeFlag.API_AUDIO);
    this.attempts.delete(id);
    this.opts.logger.info('satellite connected', { satellite: id, host, port: cfg.port });
  }

  /**
   * A dropped satellite must be re-subscribed, not merely re-connected.
   *
   * The ESPHome client reconnects its own socket, but the exclusive
   * voice-assistant audio subscription is claimed once per connection. Without
   * this the bridge sits there looking healthy — entity updates flowing, logs
   * quiet — while the wake word does nothing, until someone restarts it. A
   * device reboot or a Wi-Fi blip was enough.
   */
  private scheduleReconnect(connection: Connection): void {
    if (this.stopping || connection.dead) return;
    connection.dead = true;
    connection.abort.abort();
    void Promise.resolve(connection.client.disconnectAsync()).catch(() => undefined);
    const index = this.connections.indexOf(connection);
    if (index >= 0) this.connections.splice(index, 1);

    const attempt = this.attempts.get(connection.id) ?? 0;
    this.attempts.set(connection.id, attempt + 1);
    const base = this.opts.reconnectBaseMs ?? 1000;
    const cap = this.opts.reconnectCapMs ?? 30_000;
    const delay = Math.min(cap, base * 2 ** attempt);

    this.opts.logger.info('satellite reconnecting', {
      satellite: connection.id,
      attempt: attempt + 1,
      in_ms: delay,
    });

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.stopping) return;
      this.connect(connection.id, connection.cfg).catch((err: unknown) => {
        this.opts.logger.warn('satellite reconnect failed', {
          satellite: connection.id,
          error: err instanceof Error ? err.message : String(err),
        });
        // Keep trying: a satellite that is merely rebooting will be back.
        this.scheduleReconnect({ ...connection, dead: false });
      });
    }, delay);
    // Referenced on purpose: while a satellite is away this is the only thing
    // keeping the service's event loop alive between commands.
    this.timers.add(timer);
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
      this.sendErrorEvent(active.api, err instanceof Error ? err.message : String(err));
      this.endRun(active);
      return;
    }

    this.endRun(active);
  }

  /**
   * Close the run, and make sure it actually closes.
   *
   * RUN_END only acts from STREAMING_MICROPHONE (stop the mic, go idle) or from
   * AWAITING_RESPONSE (go idle). If the device is still working through
   * STOP_MICROPHONE / STOPPING_MICROPHONE — which it is for a few milliseconds
   * after STT_VAD_END — it matches neither, does nothing, and the device parks
   * in AWAITING_RESPONSE forever, because with no speaker no TTS event is ever
   * coming to move it on. That is the stuck "thinking" LED.
   *
   * Rather than bet on the gap being wide enough, send a second RUN_END once
   * the device has certainly settled. It is free when the first one worked:
   * RUN_END from IDLE changes nothing.
   */
  private endRun(active: ActiveRun): void {
    const send = (): void => this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.RUN_END));
    send();
    const rescue = setTimeout(() => {
      this.timers.delete(rescue);
      send();
    }, RUN_END_RESCUE_MS);
    rescue.unref?.();
    this.timers.add(rescue);
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
    const chaining = (this.opts.followUpMs ?? 0) > 0;
    const source = new SatelliteAudioSource(active.satelliteId, {
      onSpeechStarted: () => this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.STT_VAD_START)),
      onStop: () => {
        // With chaining off this is the long-proven path: stop the microphone at
        // end of speech, so the device is not streaming while the command runs,
        // and let the later RUN_END find it settled in AWAITING_RESPONSE.
        // With chaining on, STT_VAD_END is exactly what we must not send — it
        // would close the microphone the follow-up needs.
        if (!chaining) this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.STT_VAD_END));
      },
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
    const connection = this.connections.find((c) => c.id === satelliteId);
    if (connection) this.scheduleReconnect(connection);
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

  /** Report an error AND end the run. RUN_END alone: see the note above. */
  private sendError(api: VoiceAssistantApiLike, message: string, code = 'voicebridge_error'): void {
    this.sendErrorEvent(api, message, code);
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
