// Thin, typed WebSocket transport to the OpenAI Realtime API. No SDK: we speak
// ~15 wire events, and the mock server in tests speaks the same raw protocol.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from '../logger.js';
import type { ClientEvent, RealtimeErrorEvent, ServerEvent, SessionConfig } from './events.js';

export class RealtimeError extends Error {}

export interface RealtimeClientOptions {
  url: string;
  apiKey: string;
  model: string;
  logger: Logger;
  connectTimeoutMs?: number;
}

/**
 * Events: 'event'(ServerEvent) for every server event · 'closed'(code?) once.
 */
export class RealtimeClient extends EventEmitter {
  readonly connectedAt = Date.now();
  private closed = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly logger: Logger,
  ) {
    super();
    ws.on('message', (data) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(data)) as ServerEvent;
      } catch {
        this.logger.warn('realtime: unparseable server event');
        return;
      }
      if (event.type === 'error') {
        const err = event as RealtimeErrorEvent;
        this.logger.warn('realtime: server error event', { code: err.error?.code, message: err.error?.message });
      }
      this.emit('event', event);
    });
    ws.on('close', (code) => {
      if (!this.closed) {
        this.closed = true;
        this.emit('closed', code);
      }
    });
    ws.on('error', (err) => {
      this.logger.warn('realtime: socket error', { error: err.message });
      // 'close' follows and emits 'closed'.
    });
  }

  /** Opens the socket and resolves once the server announces session.created. */
  static connect(opts: RealtimeClientOptions): Promise<RealtimeClient> {
    const timeoutMs = opts.connectTimeoutMs ?? 10_000;
    const url = `${opts.url}?model=${encodeURIComponent(opts.model)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        handshakeTimeout: timeoutMs,
      });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new RealtimeError('timed out waiting for session.created'));
      }, timeoutMs);

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new RealtimeError(`realtime connect failed: ${err.message}`));
      });
      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        ws.terminate();
        reject(new RealtimeError(`realtime connect rejected: HTTP ${res.statusCode ?? '?'}`));
      });
      ws.once('message', (data) => {
        clearTimeout(timer);
        let event: ServerEvent;
        try {
          event = JSON.parse(String(data)) as ServerEvent;
        } catch {
          ws.terminate();
          reject(new RealtimeError('first server event was unparseable'));
          return;
        }
        if (event.type !== 'session.created') {
          if (event.type === 'error') {
            const err = event as RealtimeErrorEvent;
            ws.terminate();
            reject(new RealtimeError(err.error?.message ?? 'realtime error before session.created'));
            return;
          }
        }
        ws.removeAllListeners('error');
        resolve(new RealtimeClient(ws, opts.logger));
      });
    });
  }

  send(event: ClientEvent): void {
    if (this.ws.readyState !== WebSocket.OPEN) throw new RealtimeError('realtime socket is not open');
    this.ws.send(JSON.stringify(event));
  }

  /** session.update → resolves on session.updated, rejects on an error event. */
  updateSession(session: SessionConfig, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('event', onEvent);
        reject(new RealtimeError('timed out waiting for session.updated'));
      }, timeoutMs);
      const onEvent = (event: ServerEvent): void => {
        if (event.type === 'session.updated') {
          clearTimeout(timer);
          this.off('event', onEvent);
          resolve();
        } else if (event.type === 'error') {
          clearTimeout(timer);
          this.off('event', onEvent);
          const err = event as RealtimeErrorEvent;
          reject(new RealtimeError(err.error?.message ?? 'session.update rejected'));
        }
      };
      this.on('event', onEvent);
      try {
        this.send({ type: 'session.update', session });
      } catch (err) {
        clearTimeout(timer);
        this.off('event', onEvent);
        reject(err);
      }
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    // Give the close handshake a moment, then hard-terminate.
    setTimeout(() => {
      try {
        this.ws.terminate();
      } catch {
        /* gone */
      }
    }, 250).unref?.();
  }
}
