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
  runCommand: (source: SatelliteAudioSource) => Promise<CommandRecord>;
  openClient?: OpenSatelliteClient;
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
  source: SatelliteAudioSource;
  done: Promise<void>;
}

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
    this.active?.source.fail(new Error('voicebridge is shutting down'));

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
          this.active.source.fail(new Error('Satellite cancelled the active voice request'));
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
        active.source.push(chunk.data);
        if (chunk.end) active.source.end();
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

    const source = new SatelliteAudioSource(satelliteId, {
      onSpeechStarted: () => this.sendSafe(api, () => api.sendEvent(VoiceAssistantEvent.STT_VAD_START)),
      onStop: () => this.sendSafe(api, () => api.sendEvent(VoiceAssistantEvent.STT_VAD_END)),
    });
    const active: ActiveRun = { satelliteId, api, source, done: Promise.resolve() };
    this.active = active;

    this.sendSafe(api, () => api.respondToRequest());
    this.sendSafe(api, () => api.sendEvent(VoiceAssistantEvent.RUN_START));
    this.sendSafe(api, () => api.sendEvent(VoiceAssistantEvent.STT_START));

    active.done = this.finishRun(active);
  }

  private async finishRun(active: ActiveRun): Promise<void> {
    try {
      const record = await this.opts.runCommand(active.source);
      if (record.transcript) {
        const data: VoiceAssistantEventData[] = [{ name: 'text', value: record.transcript.slice(0, 500) }];
        this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.STT_END, data));
      }
      if (record.error || record.outcome === 'error') {
        this.sendError(active.api, record.error ?? 'Voice command failed');
      } else {
        this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.INTENT_START));
        this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.INTENT_END));
        this.sendSafe(active.api, () => active.api.sendEvent(VoiceAssistantEvent.RUN_END));
      }
    } catch (err) {
      active.source.stop();
      this.sendError(active.api, err instanceof Error ? err.message : String(err));
    } finally {
      if (this.active === active) this.active = null;
    }
  }

  private handleConnectionFailure(satelliteId: string, err: unknown): void {
    if (this.active?.satelliteId === satelliteId) {
      this.active.source.fail(new Error('Satellite connection closed during the voice request'));
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

  private sendError(api: VoiceAssistantApiLike, message: string, code = 'voicebridge_error'): void {
    const data: VoiceAssistantEventData[] = [
      { name: 'code', value: code },
      { name: 'message', value: message.slice(0, 200) },
    ];
    this.sendSafe(api, () => api.sendEvent(VoiceAssistantEvent.ERROR, data));
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
