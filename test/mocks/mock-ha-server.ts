// In-process Home Assistant WebSocket mock: real auth flow, registry fixtures,
// call_service with causal state_changed confirmation, and fault-injection knobs.
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

type Json = Record<string, unknown>;

export interface MockRegistryData {
  areas: Json[];
  devices: Json[];
  entities: Json[];
  full_entities: Record<string, { aliases?: string[] }>;
  states: Array<{ entity_id: string; state: string; attributes: Json }>;
}

export function loadFixtureRegistry(): MockRegistryData {
  const path = fileURLToPath(new URL('../fixtures/registry.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as MockRegistryData;
}

export interface MockHAOptions {
  token?: string;
  registry?: MockRegistryData;
  /** Reject every auth attempt. */
  authFail?: boolean;
  /** Emit causal state_changed after call_service (default true). */
  confirmStateChange?: boolean;
  stateChangeDelayMs?: number;
  /** Every call_service returns success:false. */
  failServices?: boolean;
  /** These subscribe_events event_types return an error (e.g. non-admin). */
  rejectSubscriptions?: string[];
  /** Dynamic ESPHome encryption keys keyed by HA config-entry id. */
  esphomeKeys?: Record<string, string>;
}

interface Subscriber {
  ws: WebSocket;
  subId: number;
  eventType: string;
}

export class MockHAServer {
  readonly callServiceCalls: Json[] = [];
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  private readonly subscribers: Subscriber[] = [];
  private ctxCounter = 0;
  registry: MockRegistryData;

  private constructor(
    wss: WebSocketServer,
    private readonly opts: MockHAOptions,
  ) {
    this.wss = wss;
    this.registry = opts.registry ?? loadFixtureRegistry();
    wss.on('connection', (ws) => this.onConnection(ws));
  }

  static start(opts: MockHAOptions = {}): Promise<MockHAServer> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
        resolve(new MockHAServer(wss, opts));
      });
    });
  }

  get url(): string {
    const addr = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${addr.port}`;
  }

  /** Emit an event to every subscriber of eventType. */
  emitEvent(eventType: string, data: unknown): void {
    for (const sub of this.subscribers) {
      if (sub.eventType !== eventType || sub.ws.readyState !== WebSocket.OPEN) continue;
      sub.ws.send(JSON.stringify({ id: sub.subId, type: 'event', event: { event_type: eventType, data } }));
    }
  }

  /** Terminate all live sockets (reconnect tests). */
  dropAll(): void {
    for (const ws of this.sockets) ws.terminate();
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private onConnection(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('close', () => {
      this.sockets.delete(ws);
      for (let i = this.subscribers.length - 1; i >= 0; i--) {
        if (this.subscribers[i]?.ws === ws) this.subscribers.splice(i, 1);
      }
    });
    ws.on('message', (raw) => this.onMessage(ws, JSON.parse(String(raw)) as Json));
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.8.0' }));
  }

  private onMessage(ws: WebSocket, msg: Json): void {
    if (msg.type === 'auth') {
      if (this.opts.authFail || msg.access_token !== (this.opts.token ?? 'test-token')) {
        ws.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token' }));
        ws.close();
      } else {
        ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.8.0' }));
      }
      return;
    }

    const id = msg.id as number;
    const ok = (result: unknown): void => {
      ws.send(JSON.stringify({ id, type: 'result', success: true, result }));
    };
    const fail = (code: string, message: string): void => {
      ws.send(JSON.stringify({ id, type: 'result', success: false, error: { code, message } }));
    };

    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ id, type: 'pong' }));
        return;
      case 'config/area_registry/list':
        ok(this.registry.areas);
        return;
      case 'config/device_registry/list':
        ok(this.registry.devices);
        return;
      case 'config/entity_registry/list':
        ok(this.registry.entities);
        return;
      case 'config/entity_registry/get_entries': {
        const out: Record<string, unknown> = {};
        for (const entityId of msg.entity_ids as string[]) {
          const base = this.registry.entities.find((e) => e.entity_id === entityId) ?? null;
          const extra = this.registry.full_entities[entityId];
          out[entityId] = base ? { ...base, aliases: extra?.aliases ?? [] } : null;
        }
        ok(out);
        return;
      }
      case 'get_states':
        ok(this.registry.states);
        return;
      case 'esphome/get_encryption_key': {
        const key = this.opts.esphomeKeys?.[String(msg.entry_id)];
        if (!key) {
          fail('not_found', 'mock: ESPHome config entry not found');
          return;
        }
        ok({ encryption_key: key });
        return;
      }
      case 'subscribe_events': {
        const eventType = String(msg.event_type);
        if (this.opts.rejectSubscriptions?.includes(eventType)) {
          fail('unauthorized', `admin required for ${eventType}`);
          return;
        }
        this.subscribers.push({ ws, subId: id, eventType });
        ok(null);
        return;
      }
      case 'call_service': {
        this.callServiceCalls.push(msg);
        if (this.opts.failServices) {
          fail('service_call_failed', 'mock: service failed');
          return;
        }
        const context = { id: `ctx-${++this.ctxCounter}`, parent_id: null, user_id: 'mock-user' };
        ok({ context, response: null });
        if (this.opts.confirmStateChange !== false) {
          const target = (msg.target ?? {}) as { entity_id?: string[] };
          const service = String(msg.service);
          const newState = service.includes('off') || service === 'close_cover' ? 'off' : service === 'lock' ? 'locked' : service === 'unlock' ? 'unlocked' : 'on';
          setTimeout(() => {
            for (const entityId of target.entity_id ?? []) {
              const old = this.registry.states.find((s) => s.entity_id === entityId) ?? null;
              this.emitEvent('state_changed', {
                entity_id: entityId,
                old_state: old ? { ...old, context: { id: 'ctx-old', parent_id: null, user_id: null } } : null,
                new_state: { entity_id: entityId, state: newState, attributes: old?.attributes ?? {}, context },
              });
            }
          }, this.opts.stateChangeDelayMs ?? 30);
        }
        return;
      }
      default:
        fail('unknown_command', `mock: unhandled ${String(msg.type)}`);
    }
  }
}
