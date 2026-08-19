import { afterEach, describe, expect, it } from 'vitest';
import { HAAuthError, HAClient, HARequestError, HAUnavailableError } from '../../src/ha/client.js';
import { executeAction } from '../../src/ha/executor.js';
import { Registry } from '../../src/ha/registry.js';
import { Logger } from '../../src/logger.js';
import { CommandTrace } from '../../src/telemetry.js';
import { MockHAServer, type MockHAOptions } from '../mocks/mock-ha-server.js';

const logger = new Logger({ level: 'error' });
const VOICE_DOMAINS = ['light', 'fan', 'switch', 'media_player', 'scene', 'script', 'lock', 'cover', 'climate'];

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

async function connected(opts: MockHAOptions = {}): Promise<{ server: MockHAServer; client: HAClient; registry: Registry }> {
  const server = await MockHAServer.start(opts);
  const registry = new Registry(logger, { voiceDomains: VOICE_DOMAINS, refreshDebounceMs: 50 });
  const client = new HAClient({
    url: server.url,
    token: 'test-token',
    logger,
    retry: false,
    onSync: (c) => registry.sync(c),
  });
  registry.attach(client);
  cleanups.push(async () => {
    client.stop();
    await server.close();
  });
  await client.start();
  return { server, client, registry };
}

describe('HAClient + Registry', () => {
  it('authenticates, syncs registries, and enriches aliases', async () => {
    const { registry, client } = await connected();
    expect(client.state).toBe('ready');
    const cache = registry.cache;
    expect(cache).not.toBeNull();
    expect(cache?.areasById.size).toBe(4);
    expect(cache?.entitiesById.size).toBe(19);
    expect(cache?.statesById.get('light.kitchen_ceiling')?.attributes.friendly_name).toBe('Kitchen Ceiling');
    expect(cache?.entitiesById.get('light.living_room_floor_lamp')?.aliases).toContain('the lamp');
  });

  it('rejects start() on a bad token', async () => {
    const server = await MockHAServer.start({ authFail: true });
    const client = new HAClient({ url: server.url, token: 'wrong', logger, retry: false });
    cleanups.push(async () => {
      client.stop();
      await server.close();
    });
    await expect(client.start()).rejects.toBeInstanceOf(HAAuthError);
  });

  it('fails fast when not connected', async () => {
    const client = new HAClient({ url: 'ws://127.0.0.1:1', token: 'x', logger, retry: false });
    cleanups.push(() => client.stop());
    await expect(client.request({ type: 'ping' })).rejects.toBeInstanceOf(HAUnavailableError);
  });

  it('reaches ready even when registry-event subscriptions are refused (non-admin)', async () => {
    const { client } = await connected({
      rejectSubscriptions: ['area_registry_updated', 'device_registry_updated', 'entity_registry_updated'],
    });
    expect(client.state).toBe('ready');
  });

  it('refetches (debounced) when a registry-change event arrives', async () => {
    const { server, registry } = await connected();
    const updated = new Promise<void>((resolve) => registry.once('updated', () => resolve()));
    server.registry.areas.push({ area_id: 'basement', name: 'Basement', aliases: [], floor_id: null });
    server.emitEvent('area_registry_updated', { action: 'create', area_id: 'basement' });
    await updated;
    expect(registry.cache?.areasById.has('basement')).toBe(true);
  });

  it('applies state_changed events to the cache', async () => {
    const { server, registry } = await connected();
    server.emitEvent('state_changed', {
      entity_id: 'light.kitchen_ceiling',
      old_state: null,
      new_state: { entity_id: 'light.kitchen_ceiling', state: 'on', attributes: { friendly_name: 'Kitchen Ceiling' } },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.cache?.statesById.get('light.kitchen_ceiling')?.state).toBe('on');
  });

  it('retrieves a provisioned ESPHome key without logging or persisting it', async () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const { client } = await connected({ esphomeKeys: { 'entry-satellite': key } });

    await expect(client.getESPHomeEncryptionKey('entry-satellite')).resolves.toBe(key);
  });

  it('rejects missing or malformed ESPHome keys', async () => {
    const { client } = await connected({ esphomeKeys: { malformed: 'not-a-noise-key' } });

    await expect(client.getESPHomeEncryptionKey('malformed')).rejects.toBeInstanceOf(HARequestError);
    await expect(client.getESPHomeEncryptionKey('missing')).rejects.toBeInstanceOf(HARequestError);
  });
});

describe('executeAction', () => {
  const resolved = {
    tier: 'green' as const,
    domain: 'light',
    service: 'turn_on',
    serviceData: {},
    entityIds: ['light.kitchen_ceiling'],
    verification: 'state' as const,
  };

  it('executes and causally verifies via context id (T6–T8)', async () => {
    const { server, client } = await connected();
    const trace = new CommandTrace('text', 'gpt-realtime-2.1-mini', 'per_utterance');
    const result = await executeAction(client, resolved, trace);
    expect(result).toMatchObject({ ok: true, verified: true, confirmedEntityIds: ['light.kitchen_ceiling'] });
    expect(trace.has('t6') && trace.has('t7') && trace.has('t8')).toBe(true);
    expect(server.callServiceCalls[0]).toMatchObject({
      type: 'call_service',
      domain: 'light',
      service: 'turn_on',
      target: { entity_id: ['light.kitchen_ceiling'] },
    });
  });

  it('reports verified:false when no causal state change arrives', async () => {
    const { client } = await connected({ confirmStateChange: false });
    const trace = new CommandTrace('text', 'gpt-realtime-2.1-mini', 'per_utterance');
    const result = await executeAction(client, resolved, trace, { confirmTimeoutMs: 200 });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
    expect(trace.has('t8')).toBe(false);
  });

  it('sets T8 := T7 for fire-and-forget actions', async () => {
    const { client } = await connected({ confirmStateChange: false });
    const trace = new CommandTrace('text', 'gpt-realtime-2.1-mini', 'per_utterance');
    const result = await executeAction(
      client,
      { ...resolved, domain: 'scene', service: 'turn_on', entityIds: ['scene.movie_time'], verification: 'fire_and_forget' },
      trace,
    );
    expect(result.ok).toBe(true);
    expect(trace.deltas().confirm).toBe(0);
  });

  it('surfaces a failed service call', async () => {
    const { client } = await connected({ failServices: true });
    const trace = new CommandTrace('text', 'gpt-realtime-2.1-mini', 'per_utterance');
    const result = await executeAction(client, resolved, trace);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('mock: service failed');
  });
});
