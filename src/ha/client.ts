// Persistent Home Assistant WebSocket client.
// State machine: disconnected → connecting → authenticating → syncing → ready,
// with jittered exponential backoff on failure (service mode) or fail-fast (CLI).
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from '../logger.js';
import type { CallServiceResult, RegistryEventType, StateChangedData } from './types.js';

export type HAClientState = 'disconnected' | 'connecting' | 'authenticating' | 'syncing' | 'ready' | 'stopped';

export class HAUnavailableError extends Error {}
export class HAAuthError extends Error {}
export class HARequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Pure so the schedule is unit-testable. Full jitter on the top half. */
export function backoffDelay(attempt: number, baseMs = 1000, capMs = 60_000, rand: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(exp * (0.5 + rand() * 0.5));
}

export interface HAClientOptions {
  /** http(s) base URL (…/api/websocket appended) or a full ws(s) URL. */
  url: string;
  token: string;
  logger: Logger;
  /** Service mode: reconnect forever. CLI mode (false): fail fast. */
  retry: boolean;
  /** Runs while state=syncing on every (re)connect, before 'ready'. */
  onSync?: (client: HAClient) => Promise<void>;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  requestTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Events: 'ready' · 'down'(Error) · 'auth_failed'(Error) ·
 * 'state_changed'(StateChangedData) · 'registry_changed'(RegistryEventType)
 */
export class HAClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private stateInternal: HAClientState = 'disconnected';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptionHandlers = new Map<number, (event: { event_type: string; data: unknown }) => void>();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stableTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: HAClientOptions) {
    super();
  }

  get state(): HAClientState {
    return this.stateInternal;
  }

  get wsUrl(): string {
    const u = this.opts.url;
    if (u.startsWith('ws://') || u.startsWith('wss://')) return u;
    return `${u.replace(/^http/, 'ws').replace(/\/+$/, '')}/api/websocket`;
  }

  /** Resolves on first 'ready'. With retry=true, later drops reconnect forever. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onReady = (): void => {
        cleanup();
        resolve();
      };
      const onFail = (err: Error): void => {
        if (this.opts.retry && !(err instanceof HAAuthError)) return; // keep waiting for a later 'ready'
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        this.off('ready', onReady);
        this.off('down', onFail);
        this.off('auth_failed', onFail);
      };
      this.on('ready', onReady);
      this.on('down', onFail);
      this.on('auth_failed', onFail);
      this.connect();
    });
  }

  stop(): void {
    this.stateInternal = 'stopped';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stopPing();
    this.failPending(new HAUnavailableError('client stopped'));
    this.ws?.removeAllListeners();
    try {
      this.ws?.terminate();
    } catch {
      /* already closed */
    }
    this.ws = null;
  }

  /** Send a command and await its correlated result. Fails fast unless connected. */
  request<T = unknown>(msg: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (this.stateInternal !== 'ready' && this.stateInternal !== 'syncing') {
      return Promise.reject(new HAUnavailableError(`Home Assistant connection is ${this.stateInternal}`));
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new HAUnavailableError('Home Assistant socket is not open'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HAUnavailableError(`Home Assistant request timed out: ${String(msg.type)}`));
      }, timeoutMs ?? this.opts.requestTimeoutMs ?? 10_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, ...msg }));
    });
  }

  async callService(
    domain: string,
    service: string,
    serviceData: Record<string, unknown>,
    entityIds: string[],
  ): Promise<CallServiceResult> {
    return await this.request<CallServiceResult>({
      type: 'call_service',
      domain,
      service,
      service_data: serviceData,
      target: { entity_id: entityIds },
    });
  }

  /**
   * Retrieve the dynamic ESPHome Noise key that Home Assistant provisioned for
   * a config entry. HA requires an admin token for this websocket command.
   * Keeping this lookup here means the Satellite key never has to be copied
   * into voicebridge.yaml or printed during setup.
   */
  async getESPHomeEncryptionKey(entryId: string): Promise<string> {
    const result = await this.request<{ encryption_key?: unknown }>({
      type: 'esphome/get_encryption_key',
      entry_id: entryId,
    });
    const key = result?.encryption_key;
    if (typeof key !== 'string' || !isBase64NoiseKey(key)) {
      throw new HARequestError(`Home Assistant has no valid ESPHome encryption key for config entry ${entryId}`);
    }
    return key;
  }

  async subscribe(eventType: string, handler: (event: { event_type: string; data: unknown }) => void): Promise<void> {
    const id = this.nextId++;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new HAUnavailableError('socket not open');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HAUnavailableError(`subscribe_events timed out: ${eventType}`));
      }, this.opts.requestTimeoutMs ?? 10_000);
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
        timer,
      });
      this.subscriptionHandlers.set(id, handler);
      ws.send(JSON.stringify({ id, type: 'subscribe_events', event_type: eventType }));
    });
  }

  private connect(): void {
    if (this.stateInternal === 'stopped') return;
    this.stateInternal = 'connecting';
    const ws = new WebSocket(this.wsUrl, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on('message', (data) => this.onMessage(String(data)));
    ws.on('error', (err) => this.onDown(err instanceof Error ? err : new Error(String(err))));
    ws.on('close', () => this.onDown(new HAUnavailableError('Home Assistant connection closed')));
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.opts.logger.warn('ha: unparseable message', { raw: raw.slice(0, 200) });
      return;
    }

    switch (msg.type) {
      case 'auth_required':
        this.stateInternal = 'authenticating';
        this.ws?.send(JSON.stringify({ type: 'auth', access_token: this.opts.token }));
        return;
      case 'auth_invalid': {
        const err = new HAAuthError(`Home Assistant rejected the token: ${String(msg.message ?? '')}`);
        this.opts.logger.error('ha: auth failed', { message: String(msg.message ?? '') });
        this.stop();
        this.emit('auth_failed', err);
        return;
      }
      case 'auth_ok':
        void this.onAuthenticated();
        return;
      case 'result':
      case 'pong': {
        const id = Number(msg.id);
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (msg.type === 'pong' || msg.success === true) {
          p.resolve(msg.result ?? null);
        } else {
          const error = (msg.error ?? {}) as { code?: string; message?: string };
          // A failed subscription must not leave a dangling handler.
          this.subscriptionHandlers.delete(id);
          p.reject(new HARequestError(error.message ?? 'Home Assistant returned an error', error.code));
        }
        return;
      }
      case 'event': {
        const id = Number(msg.id);
        const handler = this.subscriptionHandlers.get(id);
        const event = msg.event as { event_type: string; data: unknown } | undefined;
        if (handler && event) handler(event);
        return;
      }
      default:
        return;
    }
  }

  private async onAuthenticated(): Promise<void> {
    this.stateInternal = 'syncing';
    try {
      // Subscriptions first so no registry/state change can slip past unseen.
      await this.subscribe('state_changed', (event) => {
        this.emit('state_changed', event.data as StateChangedData);
      });
      for (const eventType of ['area_registry_updated', 'device_registry_updated', 'entity_registry_updated'] as RegistryEventType[]) {
        try {
          await this.subscribe(eventType, () => this.emit('registry_changed', eventType));
        } catch (err) {
          // Non-admin tokens can't subscribe to registry events; degrade with a warning.
          this.opts.logger.warn(`ha: cannot subscribe to ${eventType} (admin token required?)`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await this.opts.onSync?.(this);
      this.stateInternal = 'ready';
      this.startPing();
      // Reset backoff only after the connection proves stable.
      this.stableTimer = setTimeout(() => {
        this.attempt = 0;
      }, 60_000);
      this.opts.logger.info('ha: connected and synced', { url: this.wsUrl });
      this.emit('ready');
    } catch (err) {
      this.onDown(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onDown(err: Error): void {
    if (this.stateInternal === 'stopped' || this.stateInternal === 'disconnected') return;
    const wasReady = this.stateInternal === 'ready';
    this.stateInternal = 'disconnected';
    this.stopPing();
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.failPending(new HAUnavailableError(`Home Assistant connection lost: ${err.message}`));
    this.subscriptionHandlers.clear();
    this.ws?.removeAllListeners();
    try {
      this.ws?.terminate();
    } catch {
      /* already closed */
    }
    this.ws = null;
    if (wasReady || this.attempt === 0) this.opts.logger.warn('ha: connection down', { error: err.message });
    this.emit('down', err);
    if (this.opts.retry) {
      const delay = backoffDelay(this.attempt++, this.opts.backoffBaseMs ?? 1000, this.opts.backoffCapMs ?? 60_000);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.reconnectTimer.unref?.();
    }
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private startPing(): void {
    const interval = this.opts.pingIntervalMs ?? 20_000;
    this.pingTimer = setInterval(() => {
      this.request({ type: 'ping' }, this.opts.pongTimeoutMs ?? 10_000).catch(() => {
        this.onDown(new HAUnavailableError('ping timeout'));
      });
    }, interval);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

function isBase64NoiseKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  return Buffer.from(value, 'base64').length === 32;
}
