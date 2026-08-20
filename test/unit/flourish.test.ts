import { describe, expect, it } from 'vitest';
import type { FlourishConfig } from '../../src/config.js';
import type { RegistryCache } from '../../src/ha/registry.js';
import type { HAState } from '../../src/ha/types.js';
import { matchFlourish, restorePlan, snapshotLights, type LightSnapshot } from '../../src/policy/flourish.js';

const RAINBOW: FlourishConfig = {
  phrases: ['super gay'],
  durationMs: 12_000,
  light: {
    brightness_pct: 100,
    brightness_step_pct: null,
    rgb_color: null,
    color_temp_kelvin: null,
    effect: 'prism',
    transition_seconds: null,
    flash: null,
  },
  rotation: null,
};
const LONGER: FlourishConfig = { ...RAINBOW, phrases: ['super gay and horny'], durationMs: 20_000 };

function cacheWith(states: Array<Partial<HAState> & { entity_id: string }>): RegistryCache {
  return {
    areasById: new Map(),
    devicesById: new Map(),
    entitiesById: new Map(),
    statesById: new Map(
      states.map((s) => [s.entity_id, { state: 'on', attributes: {}, ...s } as HAState]),
    ),
    builtAt: 0,
  };
}

describe('matchFlourish', () => {
  it('matches a phrase anywhere in the utterance, case and punctuation insensitively', () => {
    expect(matchFlourish('Make it super gay in here!', [RAINBOW])).toBe(RAINBOW);
    expect(matchFlourish('SUPER GAY', [RAINBOW])).toBe(RAINBOW);
  });

  it('prefers the longest matching phrase so a specific flourish wins', () => {
    expect(matchFlourish('make it super gay and horny in here', [RAINBOW, LONGER])).toBe(LONGER);
    expect(matchFlourish('make it super gay in here', [RAINBOW, LONGER])).toBe(RAINBOW);
  });

  it('does not match a phrase embedded inside a longer word', () => {
    expect(matchFlourish('supergayness', [RAINBOW])).toBeUndefined();
  });

  it('returns undefined with no configured flourishes', () => {
    expect(matchFlourish('make it super gay', [])).toBeUndefined();
  });
});

describe('snapshotLights', () => {
  it('captures only the color attribute the active color_mode makes authoritative', () => {
    const cache = cacheWith([
      {
        entity_id: 'light.temp',
        state: 'on',
        attributes: {
          color_mode: 'color_temp',
          brightness: 180,
          color_temp_kelvin: 2700,
          rgb_color: [255, 180, 100], // stale conversion HA still reports
          supported_features: 4,
        },
      },
      {
        entity_id: 'light.color',
        state: 'on',
        attributes: { color_mode: 'xy', brightness: 90, rgb_color: [10, 20, 30], supported_features: 4 },
      },
    ]);

    const [temp, color] = snapshotLights(cache, ['light.temp', 'light.color']);
    expect(temp).toMatchObject({ on: true, brightness: 180, colorTempKelvin: 2700, rgbColor: null });
    expect(color).toMatchObject({ on: true, brightness: 90, rgbColor: [10, 20, 30], colorTempKelvin: null });
  });

  it('treats "off"/"None" effect values as no effect running', () => {
    const cache = cacheWith([
      { entity_id: 'light.a', attributes: { effect: 'off', supported_features: 4 } },
      { entity_id: 'light.b', attributes: { effect: 'None', supported_features: 4 } },
      { entity_id: 'light.c', attributes: { effect: 'candle', supported_features: 4 } },
    ]);
    const snaps = snapshotLights(cache, ['light.a', 'light.b', 'light.c']);
    expect(snaps.map((s) => s.effect)).toEqual([null, null, 'candle']);
  });

  it('records lights that are off, and unknown entities as off', () => {
    const cache = cacheWith([{ entity_id: 'light.a', state: 'off', attributes: {} }]);
    const snaps = snapshotLights(cache, ['light.a', 'light.missing']);
    expect(snaps.map((s) => s.on)).toEqual([false, false]);
  });
});

describe('restorePlan', () => {
  const base: LightSnapshot = {
    entityId: 'light.a',
    on: true,
    brightness: null,
    colorTempKelvin: null,
    rgbColor: null,
    effect: null,
    supportsEffect: true,
  };

  it('clears a running effect before restoring color, so the flourish cannot linger', () => {
    const calls = restorePlan([{ ...base, brightness: 200, colorTempKelvin: 2700 }]);
    expect(calls[0]).toEqual({ service: 'turn_on', serviceData: { effect: 'off' }, entityIds: ['light.a'] });
    expect(calls[1]).toEqual({
      service: 'turn_on',
      serviceData: { brightness: 200, color_temp_kelvin: 2700 },
      entityIds: ['light.a'],
    });
  });

  it('restores a pre-existing effect instead of clearing it', () => {
    const calls = restorePlan([{ ...base, brightness: 120, effect: 'candle' }]);
    expect(calls).toEqual([
      { service: 'turn_on', serviceData: { brightness: 120, effect: 'candle' }, entityIds: ['light.a'] },
    ]);
  });

  it('groups lights that share a restore payload into one call', () => {
    const calls = restorePlan([
      { ...base, entityId: 'light.a', brightness: 100, colorTempKelvin: 3000 },
      { ...base, entityId: 'light.b', brightness: 100, colorTempKelvin: 3000 },
      { ...base, entityId: 'light.c', brightness: 50, colorTempKelvin: 3000 },
    ]);
    const restores = calls.filter((c) => c.serviceData.effect === undefined);
    expect(restores).toHaveLength(2);
    expect(restores.find((c) => c.serviceData.brightness === 100)?.entityIds).toEqual(['light.a', 'light.b']);
    expect(restores.find((c) => c.serviceData.brightness === 50)?.entityIds).toEqual(['light.c']);
  });

  it('turns previously-off lights back off', () => {
    const calls = restorePlan([{ ...base, entityId: 'light.a', on: false }]);
    expect(calls).toEqual([{ service: 'turn_off', serviceData: {}, entityIds: ['light.a'] }]);
  });

  it('never sends an effect to a light that does not support one', () => {
    const calls = restorePlan([{ ...base, supportsEffect: false, brightness: 10 }]);
    expect(calls.some((c) => 'effect' in c.serviceData)).toBe(false);
  });
});
