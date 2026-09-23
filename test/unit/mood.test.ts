import { describe, expect, it } from 'vitest';
import type { RegistryCache } from '../../src/ha/registry.js';
import { classifyLight, composeMood, MOOD_RECIPES, TONE_BIAS } from '../../src/policy/mood.js';
import { MOODS, TONES } from '../../src/realtime/tools.js';
import { buildFixtureCache } from '../mocks/fixture-cache.js';

type Capabilities = Record<string, unknown>;

const RGB: Capabilities = { supported_color_modes: ['xy'] };
const TEMP: Capabilities = { supported_color_modes: ['color_temp'], min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500 };
const DIMMABLE: Capabilities = { supported_color_modes: ['brightness'] };
const ONOFF: Capabilities = { supported_color_modes: ['onoff'] };

/** A cache whose named lights have exactly the capabilities a test needs. */
function house(lights: Record<string, Capabilities>, names: Record<string, string> = {}): RegistryCache {
  const cache = buildFixtureCache();
  for (const [entityId, capabilities] of Object.entries(lights)) {
    const state = cache.statesById.get(entityId);
    if (!state) throw new Error(`fixture is missing ${entityId}`);
    const friendly = names[entityId];
    cache.statesById.set(entityId, {
      ...state,
      state: 'on',
      attributes: { ...state.attributes, ...capabilities, ...(friendly ? { friendly_name: friendly } : {}) },
    });
    if (friendly) {
      const entry = cache.entitiesById.get(entityId);
      if (entry) cache.entitiesById.set(entityId, { ...entry, name: friendly, original_name: friendly });
    }
  }
  return cache;
}

const KITCHEN = ['light.kitchen_ceiling', 'light.kitchen_island', 'light.kitchen_sink'];

describe('classifyLight', () => {
  it('reads a light\'s purpose from its name before its capabilities', () => {
    // The fan globes are RGB, but they are still the room's character lighting,
    // and a closet strip is still a closet whatever it can do.
    const cache = house(
      { 'light.kitchen_ceiling': RGB, 'light.kitchen_island': RGB, 'light.kitchen_sink': RGB },
      {
        'light.kitchen_ceiling': 'Kitchen Ceiling',
        'light.kitchen_island': 'Bridge Fan 1',
        'light.kitchen_sink': 'Closet Right',
      },
    );
    expect(classifyLight(cache, 'light.kitchen_ceiling')).toBe('key');
    expect(classifyLight(cache, 'light.kitchen_island')).toBe('accent');
    expect(classifyLight(cache, 'light.kitchen_sink')).toBe('utility');
  });

  it('falls back to capability when the name says nothing', () => {
    const cache = house(
      { 'light.kitchen_ceiling': RGB, 'light.kitchen_island': TEMP, 'light.kitchen_sink': ONOFF },
      {
        'light.kitchen_ceiling': 'Alpha',
        'light.kitchen_island': 'Beta',
        'light.kitchen_sink': 'Gamma',
      },
    );
    expect(classifyLight(cache, 'light.kitchen_ceiling')).toBe('accent');
    expect(classifyLight(cache, 'light.kitchen_island')).toBe('key');
    // An on/off bulb can express nothing but presence, so it never carries a mood.
    expect(classifyLight(cache, 'light.kitchen_sink')).toBe('utility');
  });
});

describe('composeMood', () => {
  it('gives each light a different part rather than one flat setting', () => {
    const cache = house(
      { 'light.kitchen_ceiling': TEMP, 'light.kitchen_island': RGB, 'light.kitchen_sink': DIMMABLE },
      {
        'light.kitchen_ceiling': 'Kitchen Ceiling',
        'light.kitchen_island': 'Kitchen Lamp',
        'light.kitchen_sink': 'Kitchen Sink',
      },
    );
    const plan = composeMood(cache, KITCHEN, 'intimate', 'neutral');
    if (!plan.ok) throw new Error(plan.message);

    const byEntity = new Map(plan.calls.flatMap((call) => call.entityIds.map((id) => [id, call])));
    // The ceiling can only do colour temperature; the lamp gets the colour.
    expect(byEntity.get('light.kitchen_ceiling')?.serviceData).toHaveProperty('color_temp_kelvin');
    expect(byEntity.get('light.kitchen_ceiling')?.serviceData).not.toHaveProperty('rgb_color');
    expect(byEntity.get('light.kitchen_island')?.serviceData).toHaveProperty('rgb_color');
    // A dimmable-only bulb is given brightness and nothing it would silently drop.
    expect(Object.keys(byEntity.get('light.kitchen_sink')!.serviceData)).toEqual(['brightness_pct']);
  });

  it('never sends a setting a bulb would silently drop', () => {
    const cache = house({ 'light.kitchen_ceiling': ONOFF, 'light.kitchen_island': ONOFF, 'light.kitchen_sink': ONOFF });
    const plan = composeMood(cache, KITCHEN, 'party', 'neutral');
    if (!plan.ok) throw new Error(plan.message);

    for (const call of plan.calls) {
      expect(call.serviceData).not.toHaveProperty('rgb_color');
      expect(call.serviceData).not.toHaveProperty('color_temp_kelvin');
      expect(call.serviceData).not.toHaveProperty('brightness_pct');
    }
  });

  it('clamps colour temperature into each bulb\'s real range', () => {
    const narrow = { supported_color_modes: ['color_temp'], min_color_temp_kelvin: 3000, max_color_temp_kelvin: 4000 };
    const cache = house({ 'light.kitchen_ceiling': narrow, 'light.kitchen_island': narrow, 'light.kitchen_sink': narrow });
    const plan = composeMood(cache, KITCHEN, 'clinical', 'neutral');
    if (!plan.ok) throw new Error(plan.message);

    // clinical asks for 6500 K; this bulb tops out at 4000.
    for (const call of plan.calls) expect(call.serviceData.color_temp_kelvin).toBe(4000);
  });

  it('lets tone dim and warm the same mood', () => {
    const cache = house({ 'light.kitchen_ceiling': TEMP, 'light.kitchen_island': TEMP, 'light.kitchen_sink': TEMP });
    const brightness = (tone: 'neutral' | 'intimate' | 'urgent'): number => {
      const plan = composeMood(cache, KITCHEN, 'cozy', tone);
      if (!plan.ok) throw new Error(plan.message);
      return plan.calls[0]!.serviceData.brightness_pct as number;
    };

    // This is the whole point of carrying tone: the same words, murmured and
    // barked, must not land on the same brightness.
    expect(brightness('intimate')).toBeLessThan(brightness('neutral'));
    expect(brightness('urgent')).toBeGreaterThan(brightness('neutral'));

    const intimate = composeMood(cache, KITCHEN, 'cozy', 'intimate');
    const neutral = composeMood(cache, KITCHEN, 'cozy', 'neutral');
    if (!intimate.ok || !neutral.ok) throw new Error('expected both plans to resolve');
    expect(intimate.calls[0]!.serviceData.color_temp_kelvin).toBeLessThanOrEqual(
      neutral.calls[0]!.serviceData.color_temp_kelvin as number,
    );
  });

  it('never dims a mood light all the way to nothing', () => {
    const cache = house({ 'light.kitchen_ceiling': TEMP, 'light.kitchen_island': TEMP, 'light.kitchen_sink': TEMP });
    for (const mood of MOODS) {
      for (const tone of TONES) {
        const plan = composeMood(cache, KITCHEN, mood, tone);
        if (!plan.ok) throw new Error(plan.message);
        for (const call of plan.calls) {
          if (call.service !== 'turn_on') continue;
          const brightness = call.serviceData.brightness_pct;
          if (typeof brightness === 'number') {
            expect(brightness).toBeGreaterThanOrEqual(1);
            expect(brightness).toBeLessThanOrEqual(100);
          }
        }
      }
    }
  });

  it('honours a stated brightness over the tone it was said in', () => {
    const cache = house({ 'light.kitchen_ceiling': TEMP, 'light.kitchen_island': TEMP, 'light.kitchen_sink': TEMP });
    const plan = composeMood(cache, KITCHEN, 'cozy', 'intimate', { brightnessPct: 90 });
    if (!plan.ok) throw new Error(plan.message);

    // The user said a number; that outranks how they sounded.
    expect(plan.calls[0]!.serviceData.brightness_pct).toBe(90);
  });

  it('turns a room off before it turns anything up', () => {
    const cache = house(
      { 'light.kitchen_ceiling': TEMP, 'light.kitchen_island': RGB, 'light.kitchen_sink': TEMP },
      {
        'light.kitchen_ceiling': 'Kitchen Ceiling',
        'light.kitchen_island': 'Kitchen Lamp',
        'light.kitchen_sink': 'Kitchen Closet',
      },
    );
    const plan = composeMood(cache, KITCHEN, 'cinema', 'neutral');
    if (!plan.ok) throw new Error(plan.message);

    // Ordering matters in a dark room: never flash bright before settling.
    expect(plan.calls[0]?.service).toBe('turn_off');
  });

  it('lights what is there rather than blacking out a utility-only room', () => {
    const cache = house(
      { 'light.kitchen_ceiling': TEMP, 'light.kitchen_island': TEMP, 'light.kitchen_sink': TEMP },
      {
        'light.kitchen_ceiling': 'Kitchen Closet',
        'light.kitchen_island': 'Kitchen Pantry',
        'light.kitchen_sink': 'Kitchen Cabinet',
      },
    );
    // "intimate" turns utility lighting off — but if that is all the room has,
    // turning everything off is not what anyone asked for.
    const plan = composeMood(cache, KITCHEN, 'intimate', 'neutral');
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.calls.some((call) => call.service === 'turn_on')).toBe(true);
    expect(plan.notes.join(' ')).toContain('applied the mood to what is available');
  });

  it('skips unavailable lights and says so', () => {
    const cache = house({ 'light.kitchen_ceiling': TEMP, 'light.kitchen_island': TEMP, 'light.kitchen_sink': TEMP });
    const sink = cache.statesById.get('light.kitchen_sink')!;
    cache.statesById.set('light.kitchen_sink', { ...sink, state: 'unavailable' });

    const plan = composeMood(cache, KITCHEN, 'focus', 'neutral');
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.entityIds).not.toContain('light.kitchen_sink');
    expect(plan.notes.join(' ')).toContain('skipped unavailable');
  });

  it('refuses when nothing in scope is available at all', () => {
    const cache = house({ 'light.kitchen_ceiling': TEMP, 'light.kitchen_island': TEMP, 'light.kitchen_sink': TEMP });
    for (const id of KITCHEN) {
      const state = cache.statesById.get(id)!;
      cache.statesById.set(id, { ...state, state: 'unavailable' });
    }
    const plan = composeMood(cache, KITCHEN, 'focus', 'neutral');
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error('expected a refusal');
    expect(plan.reason).toBe('no_available_targets');
  });

  it('groups lights that end up identical into one call', () => {
    const cache = house({ 'light.kitchen_ceiling': TEMP, 'light.kitchen_island': TEMP, 'light.kitchen_sink': TEMP });
    const plan = composeMood(cache, KITCHEN, 'clinical', 'neutral');
    if (!plan.ok) throw new Error(plan.message);
    // Every light can do the same thing here, so it is one service call.
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.entityIds).toEqual(KITCHEN);
  });

  it('applies a configured override instead of the built-in recipe', () => {
    const cache = house({ 'light.kitchen_ceiling': RGB, 'light.kitchen_island': RGB, 'light.kitchen_sink': RGB });
    const plan = composeMood(cache, KITCHEN, 'cozy', 'neutral', {
      overrides: { cozy: { accent: { rgb: [1, 2, 3], brightnessPct: 77 } } },
    });
    if (!plan.ok) throw new Error(plan.message);

    // Taste is config: the overridden accent layer wins, and the untouched key
    // layer still comes from the built-in recipe.
    const accent = plan.calls.find((call) => call.entityIds.includes('light.kitchen_island'));
    expect(accent?.serviceData).toMatchObject({ rgb_color: [1, 2, 3], brightness_pct: 77 });
    const key = plan.calls.find((call) => call.entityIds.includes('light.kitchen_ceiling'));
    expect(key?.serviceData).toMatchObject({ color_temp_kelvin: 2500, brightness_pct: 35 });
  });

  it('carries a requested transition onto every call', () => {
    const cache = house({ 'light.kitchen_ceiling': TEMP, 'light.kitchen_island': TEMP, 'light.kitchen_sink': TEMP });
    const plan = composeMood(cache, KITCHEN, 'wind_down', 'neutral', { transitionSeconds: 4 });
    if (!plan.ok) throw new Error(plan.message);
    for (const call of plan.calls) expect(call.serviceData.transition).toBe(4);
  });
});

describe('the mood tables', () => {
  it('defines a recipe for every mood the model can name', () => {
    // A mood in the enum with no recipe is a call the bridge accepts and
    // then cannot render.
    for (const mood of MOODS) expect(MOOD_RECIPES[mood]).toBeDefined();
  });

  it('defines a bias for every tone the model can report', () => {
    for (const tone of TONES) expect(TONE_BIAS[tone]).toBeDefined();
  });
});
