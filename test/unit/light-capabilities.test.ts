import { describe, expect, it } from 'vitest';
import type { RegistryCache } from '../../src/ha/registry.js';
import type { EntityEntry, HAState } from '../../src/ha/types.js';
import { flattenLightTargets, planLightCapabilities } from '../../src/policy/light-capabilities.js';

interface LightSpec {
  id: string;
  state?: string;
  members?: string[];
  modes?: string[];
  features?: number;
  effects?: string[];
  minKelvin?: number;
  maxKelvin?: number;
}

function cacheOf(specs: LightSpec[]): RegistryCache {
  const entities = specs.map(
    (spec): EntityEntry => ({
      entity_id: spec.id,
      area_id: null,
      device_id: null,
      name: spec.id.slice('light.'.length).replaceAll('_', ' '),
      original_name: null,
      disabled_by: null,
      hidden_by: null,
      entity_category: null,
    }),
  );
  const states = specs.map(
    (spec): HAState => ({
      entity_id: spec.id,
      state: spec.state ?? 'off',
      attributes: {
        friendly_name: spec.id.slice('light.'.length).replaceAll('_', ' '),
        ...(spec.members ? { entity_id: spec.members } : {}),
        ...(spec.modes ? { supported_color_modes: spec.modes } : {}),
        ...(spec.features === undefined ? {} : { supported_features: spec.features }),
        ...(spec.effects ? { effect_list: spec.effects } : {}),
        ...(spec.minKelvin === undefined ? {} : { min_color_temp_kelvin: spec.minKelvin }),
        ...(spec.maxKelvin === undefined ? {} : { max_color_temp_kelvin: spec.maxKelvin }),
      },
    }),
  );
  return {
    areasById: new Map(),
    devicesById: new Map(),
    entitiesById: new Map(entities.map((entity) => [entity.entity_id, entity])),
    statesById: new Map(states.map((state) => [state.entity_id, state])),
    builtAt: 0,
  };
}

describe('flattenLightTargets', () => {
  it('recursively expands nested groups, deduplicates leaves, and survives cycles', () => {
    const cache = cacheOf([
      { id: 'light.office', members: ['light.fans', 'light.lamp', 'light.fan_1'] },
      { id: 'light.fans', members: ['light.fan_1', 'light.fan_2'] },
      { id: 'light.fan_1', modes: ['xy'] },
      { id: 'light.fan_2', modes: ['xy'] },
      { id: 'light.lamp', modes: ['xy'] },
      { id: 'light.cycle_a', members: ['light.cycle_b', 'light.fan_1'] },
      { id: 'light.cycle_b', members: ['light.cycle_a', 'light.fan_2'] },
    ]);

    expect(flattenLightTargets(cache, ['light.office', 'light.fans'])).toEqual([
      'light.fan_1',
      'light.fan_2',
      'light.lamp',
    ]);
    expect(flattenLightTargets(cache, ['light.cycle_a'])).toEqual(['light.fan_1', 'light.fan_2']);
  });
});

describe('planLightCapabilities', () => {
  it('filters mixed and unavailable group members for compound controls', () => {
    const cache = cacheOf([
      { id: 'light.office', members: ['light.color', 'light.onoff', 'light.offline'] },
      { id: 'light.color', modes: ['color_temp', 'xy'], features: 32 },
      { id: 'light.onoff', modes: ['onoff'], features: 0 },
      { id: 'light.offline', state: 'unavailable', modes: ['color_temp', 'xy'], features: 32 },
    ]);

    const plan = planLightCapabilities(cache, ['light.office', 'light.color'], {
      brightness_pct: 35,
      rgb_color: [128, 0, 128],
      transition: 3,
    });

    expect(plan).toMatchObject({
      ok: true,
      entityIds: ['light.color'],
      serviceData: { brightness_pct: 35, rgb_color: [128, 0, 128], transition: 3 },
      skippedEntityIds: ['light.offline', 'light.onoff'],
    });
    if (plan.ok) expect(plan.notes.join(' ')).toContain('skipped unsupported or unavailable');
  });

  it('matches explicit effects case-insensitively but uses one exact-spelling cohort', () => {
    const cache = cacheOf([
      { id: 'light.a', modes: ['xy'], features: 4, effects: ['Candle'] },
      { id: 'light.b', modes: ['xy'], features: 4, effects: ['candle'] },
    ]);

    expect(planLightCapabilities(cache, ['light.a', 'light.b'], { effect: 'CANDLE' })).toMatchObject({
      ok: true,
      entityIds: ['light.a'],
      serviceData: { effect: 'Candle' },
    });
  });

  it('lets Home Assistant translate Kelvin to a color-only light', () => {
    const cache = cacheOf([{ id: 'light.rgb', modes: ['xy'] }]);

    expect(planLightCapabilities(cache, ['light.rgb'], { color_temp_kelvin: 4500 })).toMatchObject({
      ok: true,
      entityIds: ['light.rgb'],
      serviceData: { color_temp_kelvin: 4500 },
    });
  });

  it('refuses an unsupported explicit effect and lists the available choices', () => {
    const cache = cacheOf([{ id: 'light.a', modes: ['xy'], features: 4, effects: ['off', 'candle'] }]);
    const plan = planLightCapabilities(cache, ['light.a'], { effect: 'underwater' });
    expect(plan).toMatchObject({ ok: false, reason: 'unsupported_effect' });
    if (!plan.ok) expect(plan.message).toContain('Available effects: candle, off');
  });

  it('clamps Kelvin to the common range of every capable target', () => {
    const cache = cacheOf([
      { id: 'light.a', modes: ['color_temp'], minKelvin: 2200, maxKelvin: 6500 },
      { id: 'light.b', modes: ['color_temp'], minKelvin: 2500, maxKelvin: 5000 },
    ]);
    const plan = planLightCapabilities(cache, ['light.a', 'light.b'], { color_temp_kelvin: 6500 });

    expect(plan).toMatchObject({
      ok: true,
      entityIds: ['light.a', 'light.b'],
      serviceData: { color_temp_kelvin: 5000 },
    });
    if (plan.ok) expect(plan.notes).toContain('color temperature clamped to 5000 K');
  });

  it('refuses targets without a shared color-temperature range', () => {
    const cache = cacheOf([
      { id: 'light.warm', modes: ['color_temp'], minKelvin: 2000, maxKelvin: 3000 },
      { id: 'light.cool', modes: ['color_temp'], minKelvin: 4000, maxKelvin: 6500 },
    ]);
    expect(planLightCapabilities(cache, ['light.warm', 'light.cool'], { color_temp_kelvin: 3500 })).toMatchObject({
      ok: false,
      reason: 'no_common_color_temperature',
    });
  });

  it('refuses when no available target supports every requested capability', () => {
    const cache = cacheOf([
      { id: 'light.color_only', modes: ['xy'], features: 0 },
      { id: 'light.flash_only', modes: ['onoff'], features: 8 },
    ]);
    expect(planLightCapabilities(cache, ['light.color_only', 'light.flash_only'], { rgb_color: [0, 0, 255], flash: 'short' })).toMatchObject({
      ok: false,
      reason: 'unsupported_light_capability',
    });
  });

  it('keeps non-transition lights in a transition-only base on/off command', () => {
    const cache = cacheOf([
      { id: 'light.fade', modes: ['brightness'], features: 32 },
      { id: 'light.instant', modes: ['onoff'], features: 0 },
    ]);
    const plan = planLightCapabilities(cache, ['light.fade', 'light.instant'], { transition: 3 });

    expect(plan).toMatchObject({
      ok: true,
      entityIds: ['light.fade', 'light.instant'],
      serviceData: { transition: 3 },
      skippedEntityIds: [],
    });
    if (plan.ok) expect(plan.notes.join(' ')).toContain('base control still applies immediately');
  });

  it('keeps non-flash lights in a flashing turn-off so the base off still applies', () => {
    const cache = cacheOf([
      { id: 'light.flash', modes: ['brightness'], features: 8 },
      { id: 'light.instant', modes: ['onoff'], features: 0 },
    ]);
    const plan = planLightCapabilities(cache, ['light.flash', 'light.instant'], { flash: 'long' }, 'turn_off');

    expect(plan).toMatchObject({
      ok: true,
      entityIds: ['light.flash', 'light.instant'],
      serviceData: { flash: 'long' },
      skippedEntityIds: [],
    });
    if (plan.ok) expect(plan.notes.join(' ')).toContain('base turn-off still applies');
  });

  it('leaves basic on/off target semantics unchanged', () => {
    const cache = cacheOf([{ id: 'light.office', members: ['light.a'] }, { id: 'light.a', state: 'unavailable' }]);
    expect(planLightCapabilities(cache, ['light.office'], {})).toEqual({
      ok: true,
      entityIds: ['light.office'],
      serviceData: {},
      skippedEntityIds: [],
      notes: [],
    });
  });
});
