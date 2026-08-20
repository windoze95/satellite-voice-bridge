import { describe, expect, it, vi } from 'vitest';
import type { HAClient } from '../../src/ha/client.js';
import { FlourishManager } from '../../src/ha/flourish-manager.js';
import { Logger } from '../../src/logger.js';
import type { LightSnapshot } from '../../src/policy/flourish.js';

const logger = new Logger({ level: 'error', console: false });

interface Call {
  service: string;
  serviceData: Record<string, unknown>;
  entityIds: string[];
}

type StateChangedHandler = (data: { entity_id: string; old_state: null; new_state: unknown }) => void;

/**
 * Just enough HAClient for executeAction: records every call and echoes the
 * causal state_changed events real Home Assistant sends, so verified restores
 * confirm instead of waiting out their timeout.
 */
function fakeClient(): { client: HAClient; calls: Call[] } {
  const calls: Call[] = [];
  const handlers = new Set<StateChangedHandler>();
  let contexts = 0;
  const client = {
    on: (event: string, handler: StateChangedHandler) => {
      if (event === 'state_changed') handlers.add(handler);
    },
    off: (_event: string, handler: StateChangedHandler) => handlers.delete(handler),
    callService: async (_domain: string, service: string, serviceData: Record<string, unknown>, entityIds: string[]) => {
      calls.push({ service, serviceData, entityIds });
      const context = { id: `ctx-${++contexts}`, parent_id: null, user_id: null };
      setImmediate(() => {
        for (const entityId of entityIds) {
          for (const handler of [...handlers]) {
            handler({ entity_id: entityId, old_state: null, new_state: { entity_id: entityId, state: 'on', attributes: {}, context } });
          }
        }
      });
      return { context };
    },
  } as unknown as HAClient;
  return { client, calls };
}

class ManualScheduler {
  readonly entries: Array<{ fn: () => void; delayMs: number; cancelled: boolean }> = [];
  readonly schedule = (fn: () => void, delayMs: number): { cancel: () => void } => {
    const entry = { fn, delayMs, cancelled: false };
    this.entries.push(entry);
    return { cancel: () => { entry.cancelled = true; } };
  };
  get live(): typeof this.entries {
    return this.entries.filter((e) => !e.cancelled);
  }
}

function snap(entityId: string, over: Partial<LightSnapshot> = {}): LightSnapshot {
  return {
    entityId,
    on: true,
    brightness: 128,
    colorTempKelvin: 2700,
    rgbColor: null,
    effect: null,
    supportsEffect: true,
    ...over,
  };
}

/** Lets pending restore promises settle without depending on wall-clock time. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('FlourishManager', () => {
  it('restores the captured look when the timer fires', async () => {
    const { client, calls } = fakeClient();
    const scheduler = new ManualScheduler();
    const manager = new FlourishManager({ haClient: client, logger, schedule: scheduler.schedule });

    manager.scheduleRestore([snap('light.a')], 12_000);
    expect(scheduler.entries[0]?.delayMs).toBe(12_000);
    expect(calls).toHaveLength(0);

    scheduler.entries[0]!.fn();
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls.map((c) => c.service)).toEqual(['turn_on', 'turn_on']);
    expect(calls[0]?.serviceData).toEqual({ effect: 'off' });
    expect(calls[1]?.serviceData).toEqual({ brightness: 128, color_temp_kelvin: 2700 });
    expect(manager.pendingCount).toBe(0);
  });

  it('cancels a pending restore when a later command claims the same lights', async () => {
    const { client, calls } = fakeClient();
    const scheduler = new ManualScheduler();
    const manager = new FlourishManager({ haClient: client, logger, schedule: scheduler.schedule });

    manager.scheduleRestore([snap('light.a')], 12_000);
    manager.cancelFor(['light.a']);
    await flush();

    expect(scheduler.live).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(manager.pendingCount).toBe(0);
  });

  it('restores the lights a partial cancellation left behind', async () => {
    const { client, calls } = fakeClient();
    const scheduler = new ManualScheduler();
    const manager = new FlourishManager({ haClient: client, logger, schedule: scheduler.schedule });

    manager.scheduleRestore([snap('light.a'), snap('light.b')], 12_000);
    manager.cancelFor(['light.a']);
    await flush();

    // light.b is not the new command's business, so it goes back immediately.
    expect(calls.every((c) => c.entityIds.every((id) => id === 'light.b'))).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(manager.pendingCount).toBe(0);
  });

  it('keeps the original snapshot when a second flourish lands on the same lights', async () => {
    const { client, calls } = fakeClient();
    const scheduler = new ManualScheduler();
    const manager = new FlourishManager({ haClient: client, logger, schedule: scheduler.schedule });

    const original = [snap('light.a', { brightness: 40, colorTempKelvin: 2200 })];
    manager.scheduleRestore(original, 12_000);

    // The lights are mid-flourish now, so a fresh snapshot would capture the
    // flourish itself; the manager must hand back the pre-flourish one.
    const second = manager.snapshot(() => [snap('light.a', { brightness: 255, effect: 'prism' })], ['light.a']);
    expect(second[0]).toMatchObject({ brightness: 40, colorTempKelvin: 2200, effect: null });

    manager.scheduleRestore(second, 12_000);
    scheduler.live[0]!.fn();
    await vi.waitFor(() => expect(calls.some((c) => c.serviceData.brightness !== undefined)).toBe(true));

    const restore = calls.find((c) => c.serviceData.brightness !== undefined);
    expect(restore?.serviceData).toEqual({ brightness: 40, color_temp_kelvin: 2200 });
  });

  it('drain waits for a pending restore instead of leaving the lights mid-flourish', async () => {
    // Regression: `voicebridge text` used to tear the app down the moment the
    // command returned, cancelling the restore and stranding real bulbs.
    const { client, calls } = fakeClient();
    const manager = new FlourishManager({ haClient: client, logger });

    manager.scheduleRestore([snap('light.a')], 1);
    await manager.drain();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)?.serviceData).toEqual({ brightness: 128, color_temp_kelvin: 2700 });
    expect(manager.pendingCount).toBe(0);
  });

  it('drain returns promptly when nothing is pending', async () => {
    const { client } = fakeClient();
    const manager = new FlourishManager({ haClient: client, logger });
    await expect(manager.drain()).resolves.toBeUndefined();
  });

  it('spreads the palette across the lights and walks it along each frame', async () => {
    const { client, calls } = fakeClient();
    const manager = new FlourishManager({ haClient: client, logger });
    const colors: Array<[number, number, number]> = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];

    manager.startRotation(
      ['light.a', 'light.b', 'light.c'],
      { colors, intervalMs: 150, transitionSeconds: 0, brightnessPct: 100 },
      [snap('light.a'), snap('light.b'), snap('light.c')],
      10_000,
    );

    // Frame 0: each light gets its own colour, not all the same one.
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => c.serviceData.rgb_color)).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
    expect(calls.every((c) => c.serviceData.brightness_pct === 100)).toBe(true);

    // Frame 1: the assignment steps along by one, so the rainbow travels.
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(6));
    const frame1 = calls.slice(3, 6);
    expect(frame1.map((c) => c.serviceData.rgb_color)).toEqual([[0, 255, 0], [0, 0, 255], [255, 0, 0]]);
    // Brightness is only sent once; repeating it would re-fade the bulb.
    expect(frame1.every((c) => c.serviceData.brightness_pct === undefined)).toBe(true);

    manager.stop();
  });

  it('stops a rotation when a later command claims the lights', async () => {
    const { client, calls } = fakeClient();
    const manager = new FlourishManager({ haClient: client, logger });

    manager.startRotation(
      ['light.a'],
      { colors: [[255, 0, 0], [0, 255, 0]], intervalMs: 150, transitionSeconds: 0, brightnessPct: null },
      [snap('light.a')],
      10_000,
    );
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));

    manager.cancelFor(['light.a']);
    const settled = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(calls.length).toBe(settled); // no further frames, and no restore
    expect(manager.pendingCount).toBe(0);
  });

  it('drops every pending restore on shutdown', () => {
    const { client, calls } = fakeClient();
    const scheduler = new ManualScheduler();
    const manager = new FlourishManager({ haClient: client, logger, schedule: scheduler.schedule });

    manager.scheduleRestore([snap('light.a')], 12_000);
    manager.stop();

    expect(scheduler.live).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(manager.pendingCount).toBe(0);
  });
});
