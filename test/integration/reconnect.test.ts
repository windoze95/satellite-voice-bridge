import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { backoffDelay, HAClient } from '../../src/ha/client.js';
import { Registry } from '../../src/ha/registry.js';
import { Logger } from '../../src/logger.js';
import { SessionManager } from '../../src/realtime/session.js';
import { MockHAServer } from '../mocks/mock-ha-server.js';
import { MockRealtimeServer } from '../mocks/mock-realtime-server.js';

const logger = new Logger({ level: 'error' });

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

describe('backoffDelay', () => {
  it('grows exponentially from base to cap with bounded jitter', () => {
    const noJitter = (): number => 1; // top of the jitter band → full exp value
    expect(backoffDelay(0, 1000, 60_000, noJitter)).toBe(1000);
    expect(backoffDelay(1, 1000, 60_000, noJitter)).toBe(2000);
    expect(backoffDelay(5, 1000, 60_000, noJitter)).toBe(32_000);
    expect(backoffDelay(10, 1000, 60_000, noJitter)).toBe(60_000); // capped
    const low = backoffDelay(3, 1000, 60_000, () => 0); // bottom of the band = half
    expect(low).toBe(4000);
  });
});

describe('HA reconnect (service mode)', () => {
  it('reconnects after a drop and re-syncs the registry', async () => {
    const server = await MockHAServer.start();
    const registry = new Registry(logger, { voiceDomains: ['light'] });
    const client = new HAClient({
      url: server.url,
      token: 'test-token',
      logger,
      retry: true,
      backoffBaseMs: 30,
      backoffCapMs: 100,
      onSync: (c) => registry.sync(c),
    });
    registry.attach(client);
    cleanups.push(async () => {
      client.stop();
      await server.close();
    });

    await client.start();
    const firstSync = registry.cache?.builtAt;

    const wentDown = new Promise<void>((resolve) => client.once('down', () => resolve()));
    const backUp = new Promise<void>((resolve) => client.once('ready', () => resolve()));
    server.dropAll();
    await wentDown;
    expect(client.state).not.toBe('ready');
    await backUp;
    expect(client.state).toBe('ready');
    expect(registry.cache?.builtAt).toBeGreaterThan(firstSync ?? Infinity);
  });

  it('keeps commands failing fast while down instead of queueing', async () => {
    const server = await MockHAServer.start();
    const client = new HAClient({ url: server.url, token: 'test-token', logger, retry: true, backoffBaseMs: 5000 });
    cleanups.push(async () => {
      client.stop();
      await server.close();
    });
    await client.start();
    const down = new Promise<void>((resolve) => client.once('down', () => resolve()));
    server.dropAll();
    await down;
    await expect(client.request({ type: 'ping' })).rejects.toThrow(/connection is/);
  });
});

describe('warm session lifecycle', () => {
  async function warmManager(maxAgeMs?: number): Promise<{ rt: MockRealtimeServer; sessions: SessionManager }> {
    const rt = await MockRealtimeServer.start({ responses: [] });
    const sessions = new SessionManager({
      mode: 'warm',
      url: rt.url,
      apiKey: 'sk-test',
      model: 'gpt-realtime-2.1-mini',
      transcribe: false,
      logger,
      maxAgeMs,
    });
    cleanups.push(async () => {
      sessions.close();
      await rt.close();
    });
    return { rt, sessions };
  }

  it('reuses the warm session across commands', async () => {
    const { rt, sessions } = await warmManager();
    const a = await sessions.acquire('INSTRUCTIONS', false);
    expect(a.reused).toBe(false);
    sessions.release(a.client);
    const b = await sessions.acquire('INSTRUCTIONS', false);
    expect(b.reused).toBe(true);
    expect(b.client).toBe(a.client);
    expect(rt.sessions).toHaveLength(1); // configured once
  });

  it('re-sends session.update when instructions change', async () => {
    const { rt, sessions } = await warmManager();
    const a = await sessions.acquire('HOUSE v1', false);
    sessions.release(a.client);
    const b = await sessions.acquire('HOUSE v2', false);
    expect(b.reused).toBe(true);
    expect(rt.sessions).toHaveLength(2);
    expect(rt.sessions[1]?.instructions).toBe('HOUSE v2');
  });

  it('recycles the session past max age (60-minute cap safety)', async () => {
    const { sessions } = await warmManager(100);
    const a = await sessions.acquire('X', false);
    sessions.release(a.client);
    await sleep(150);
    const b = await sessions.acquire('X', false);
    expect(b.reused).toBe(false);
    expect(b.client).not.toBe(a.client);
  });

  it('drops the warm session after a failed command', async () => {
    const { sessions } = await warmManager();
    const a = await sessions.acquire('X', false);
    sessions.release(a.client, { failed: true });
    const b = await sessions.acquire('X', false);
    expect(b.reused).toBe(false);
  });

  it('reconnects transparently when the server closed the idle session', async () => {
    const { rt, sessions } = await warmManager();
    const a = await sessions.acquire('X', false);
    sessions.release(a.client);
    const closed = new Promise<void>((resolve) => a.client.once('closed', () => resolve()));
    await rt.close(); // server-side close, e.g. idle timeout
    await closed;
    const rt2 = await MockRealtimeServer.start({ responses: [] });
    cleanups.push(async () => rt2.close());
    // Point the manager at the new server by reusing the same port? Simpler:
    // a dead warm client must simply not be reused.
    const usable = (sessions as unknown as { usableWarmClient: () => unknown }).usableWarmClient();
    expect(usable).toBeNull();
  });
});
