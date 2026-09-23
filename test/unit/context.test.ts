import { describe, expect, it } from 'vitest';
import { buildHouseMap, buildInstructions } from '../../src/context/house-context.js';
import { MOODS } from '../../src/realtime/tools.js';
import { buildFixtureCache, TEST_POLICY } from '../mocks/fixture-cache.js';

const cache = buildFixtureCache();

describe('buildHouseMap', () => {
  const map = buildHouseMap(cache, TEST_POLICY);

  it('lists areas with their devices grouped by domain', () => {
    expect(map).toContain('AREA: Kitchen');
    expect(map).toContain('light: Kitchen Ceiling; Kitchen Island; Kitchen Sink');
    expect(map).toContain('switch: Coffee Maker');
    expect(map).toContain('AREA: Master Bedroom');
  });

  it('advertises compact per-area light capabilities from state attributes', () => {
    const capableCache = buildFixtureCache();
    const ceiling = capableCache.statesById.get('light.kitchen_ceiling');
    const island = capableCache.statesById.get('light.kitchen_island');
    if (!ceiling || !island) throw new Error('fixture is missing kitchen lights');

    capableCache.statesById.set('light.kitchen_ceiling', {
      ...ceiling,
      attributes: {
        ...ceiling.attributes,
        supported_color_modes: ['color_temp', 'xy'],
        min_color_temp_kelvin: 2200,
        max_color_temp_kelvin: 6500,
        effect_list: ['sparkle', 'off', 'candle'],
        supported_features: 44,
      },
    });
    capableCache.statesById.set('light.kitchen_island', {
      ...island,
      attributes: {
        ...island.attributes,
        supported_color_modes: ['brightness'],
        effect_list: ['prism', 'candle'],
        supported_features: 36,
      },
    });

    const capableMap = buildHouseMap(capableCache, TEST_POLICY);
    const kitchen = capableMap.slice(capableMap.indexOf('AREA: Kitchen'), capableMap.indexOf('AREA: Living Room'));
    expect(kitchen).toContain(
        'capabilities: light.brightness_pct=0..100; light.brightness_step_pct=-100..100(nonzero); light.rgb_color=[r,g,b]; ' +
        'light.color_temp_kelvin=2200..6500; light.effect=candle|off|prism|sparkle; ' +
        'light.flash=short|long; light.transition_seconds=0..6553',
    );
    expect(kitchen).toContain('individual RGB lights: Kitchen Ceiling');
    expect(kitchen).toContain('individual effect lights: Kitchen Ceiling; Kitchen Island');
    expect(kitchen).toContain('individual temperature lights: Kitchen Ceiling');
    expect(capableMap.slice(capableMap.indexOf('AREA: Living Room'))).not.toContain('capabilities:');
  });

  it('advertises emulated Kelvin control for color-only lights', () => {
    const capableCache = buildFixtureCache();
    const floorLamp = capableCache.statesById.get('light.living_room_floor_lamp');
    if (!floorLamp) throw new Error('fixture is missing the living-room floor lamp');
    capableCache.statesById.set('light.living_room_floor_lamp', {
      ...floorLamp,
      attributes: { ...floorLamp.attributes, supported_color_modes: ['xy'] },
    });

    const capableMap = buildHouseMap(capableCache, TEST_POLICY);
    const livingRoom = capableMap.slice(capableMap.indexOf('AREA: Living Room'), capableMap.indexOf('AREA: Master Bedroom'));
    expect(livingRoom).toContain('light.rgb_color=[r,g,b]');
    expect(livingRoom).toContain('light.color_temp_kelvin=2000..6535');
  });

  it('does not advertise capabilities that exist only on unavailable lights', () => {
    const capableCache = buildFixtureCache();
    const ceiling = capableCache.statesById.get('light.kitchen_ceiling');
    const ceilingEntry = capableCache.entitiesById.get('light.kitchen_ceiling');
    if (!ceiling || !ceilingEntry) throw new Error('fixture is missing the kitchen ceiling light');
    capableCache.statesById.set('light.kitchen_ceiling', {
      ...ceiling,
      state: 'unavailable',
      attributes: {
        ...ceiling.attributes,
        supported_color_modes: ['xy'],
        supported_features: 4,
        effect_list: ['unavailable-only-effect'],
      },
    });
    // HA light groups union member capabilities even when a contributing
    // member is unavailable. The prompt must aggregate actionable leaf state,
    // not re-advertise that stale union from the group.
    capableCache.entitiesById.set('light.kitchen_group', {
      ...ceilingEntry,
      entity_id: 'light.kitchen_group',
      name: 'Kitchen group',
      original_name: 'Kitchen group',
    });
    capableCache.statesById.set('light.kitchen_group', {
      ...ceiling,
      entity_id: 'light.kitchen_group',
      state: 'on',
      attributes: {
        ...ceiling.attributes,
        friendly_name: 'Kitchen group',
        entity_id: ['light.kitchen_ceiling', 'light.kitchen_island'],
        supported_color_modes: ['xy'],
        supported_features: 4,
        effect_list: ['unavailable-only-effect'],
      },
    });

    const capableMap = buildHouseMap(capableCache, TEST_POLICY);
    const kitchen = capableMap.slice(capableMap.indexOf('AREA: Kitchen'), capableMap.indexOf('AREA: Living Room'));
    expect(kitchen).toContain('Kitchen Ceiling');
    expect(kitchen).not.toContain('unavailable-only-effect');
  });

  it('includes aliases inline', () => {
    expect(map).toContain('Living Room Floor Lamp (aka the lamp, lamp)');
  });

  it('shows configured spoken area aliases beside their canonical area', () => {
    const bridgeCache = buildFixtureCache();
    const livingRoom = bridgeCache.areasById.get('living_room');
    if (!livingRoom) throw new Error('fixture is missing the living room');
    bridgeCache.areasById.set('living_room', { ...livingRoom, name: 'The Bridge' });

    const withAlias = buildHouseMap(bridgeCache, {
      ...TEST_POLICY,
      areaAliases: { office: ['The Bridge'] },
    });

    expect(withAlias).toContain('AREA: The Bridge\n  aliases: office\n');
    expect(withAlias).not.toContain('AREA: The Bridge (aka office)');
  });

  it('shows a multi-area alias beside every canonical area it covers', () => {
    const withAlias = buildHouseMap(cache, {
      ...TEST_POLICY,
      areaAliases: { 'down here': ['Living Room', 'Kitchen'] },
    });

    expect(withAlias).toContain('AREA: Kitchen\n  aliases: down here\n');
    expect(withAlias).toContain('AREA: Living Room\n  aliases: down here\n');
  });

  it('assigns device-area entities to the device area', () => {
    const livingRoom = map.slice(map.indexOf('AREA: Living Room'), map.indexOf('AREA: Master Bedroom'));
    expect(livingRoom).toContain('Floor Lamp');
    expect(livingRoom).toContain('Living Room TV');
  });

  it('lists no-area entities under (no area)', () => {
    const tail = map.slice(map.indexOf('AREA: (no area)'));
    expect(tail).toContain('Front Door');
    expect(tail).toContain('Movie Time');
  });

  it('never advertises red-tier, disabled, hidden, or diagnostic entities', () => {
    expect(map).not.toContain('Home Alarm');
    expect(map).not.toContain('Hallway Debug');
    expect(map).not.toContain('Status Indicator');
  });

  it('is deterministic (stable ordering for prompt caching)', () => {
    expect(buildHouseMap(cache, TEST_POLICY)).toBe(map);
  });
});

describe('buildInstructions', () => {
  it('contains the rules and the house map', () => {
    const text = buildInstructions(cache, TEST_POLICY);
    expect(text).toContain('control_device');
    expect(text).toContain('HOUSE:');
    expect(text).not.toContain('heard this command');
  });

  it('names every tool the session advertises', () => {
    const text = buildInstructions(cache, TEST_POLICY);

    expect(text).toContain('control_device');
    expect(text).toContain('dismiss');
    expect(text).toContain('delegate');
    // Nothing is ever spoken, so the model must not treat a reply as an answer
    // or ask a question nobody can hear.
    expect(text).toContain('never by talking');
    expect(text).toContain('never ask a question');
  });

  it('asks for tone from the delivery rather than the words', () => {
    const text = buildInstructions(cache, TEST_POLICY);

    expect(text).toContain('Set tone on every call from HOW it was said');
    expect(text).toContain('not from the words');
    // The hint-taking instruction is what replaced the verb allow-list.
    expect(text).toContain('Take the hint');
    expect(text).toContain('"Hit the lights"');
  });

  it('offers every mood the composer can actually render', () => {
    const text = buildInstructions(cache, TEST_POLICY);

    // If a mood is added to the enum but not the prompt, the model can never
    // choose it; if it is named here but removed from the enum, every call
    // using it is rejected. Pin them together.
    for (const mood of MOODS) expect(text).toContain(mood);
    expect(text).toContain('light.mood is mutually exclusive with rgb_color, color_temp_kelvin, and effect');
  });

  it('keeps the model from moralizing about how a request was worded', () => {
    const text = buildInstructions(cache, TEST_POLICY);

    expect(text).toContain('including irreverent or adult wording');
    expect(text).toContain('Never moralize');
    expect(text).toContain('never refuse a harmless lighting request over its wording');
    // Authorization is the bridge's job; a model that self-censors produces no
    // function call for the policy engine to refuse and log.
    expect(text).toContain('Refusals are not yours to make');
  });

  it('instructs the model to accept area aliases and treat area lights as a collective', () => {
    const text = buildInstructions(cache, {
      ...TEST_POLICY,
      areaAliases: { office: ['Living Room'] },
    });

    expect(text).toContain('AREA: Living Room\n  aliases: office\n');
    expect(text).toContain('lists the spoken aliases for the canonical name');
    expect(text).toContain('Set area to the canonical AREA name exactly as written');
    expect(text).toContain('never put alias text in the area value');
    expect(text).toContain('pass the alias through unchanged');
    expect(text).toContain('means all lights in that area');
    expect(text).toContain('Do not substitute a similarly named device or group');
    expect(text).toContain('rather than inventing a device, area, or scene');
  });

  it('adds the origin-room line when provided', () => {
    const text = buildInstructions(cache, TEST_POLICY, 'Kitchen');
    expect(text).toContain('The device that heard this command is in: Kitchen');
  });
});
