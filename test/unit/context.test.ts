import { describe, expect, it } from 'vitest';
import { buildHouseMap, buildInstructions } from '../../src/context/house-context.js';
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

  it('gives compact operational guidance for light appearance controls', () => {
    const text = buildInstructions(cache, TEST_POLICY);

    expect(text).toContain('Brightness, RGB color, color temperature, or effect imply action "turn_on"');
    expect(text).toContain('Use this short procedure immediately');
    expect(text).toContain('Do not deliberate over multiple equally safe appearance choices');
    expect(text).toContain('Transition and flash preserve an explicit requested "turn_on" or "turn_off" action');
    expect(text).toContain('light.effect, light.rgb_color, and light.color_temp_kelvin are mutually exclusive');
    expect(text).toContain('light.brightness_pct and light.brightness_step_pct are mutually exclusive');
    expect(text).toContain('Treat natural lighting moods and styles');
    expect(text).toContain('"party time", "cozy", "romantic", or irreverent/adult slang');
    expect(text).toContain('Never moralize about or refuse a harmless lighting command because of its wording');
    expect(text).toContain(
      'choose exactly one of an advertised effect, RGB color, or color temperature, optionally with brightness',
    );
    expect(text).toContain('Never put a mood word in light.effect unless that exact effect is advertised');
    expect(text).toContain('Choosing among multiple suitable safe appearances is your judgment, is NOT ambiguity');
    expect(text).toContain('red=[255,0,0]');
    expect(text).toContain('purple=[128,0,255]');
    expect(text).toContain('convert its conventional sRGB value to light.rgb_color');
    expect(text).toContain('When the object being turned off is the lights/device, use action "turn_off"');
    expect(text).toContain('A prohibition such as "don\'t turn on the lights" is not a request to turn them off');
    expect(text).toContain('Polite directives such as "can/could/would you turn them on?" are actions');
    expect(text).toContain('When the object is an effect');
    expect(text).toContain('action "turn_on" and light.effect="off"');
    expect(text).toContain(
      'Use light null unless transition or flash was explicitly requested, in which case include only those requested modifiers',
    );
    expect(text).toContain('warm=2700, soft=3000, neutral=4000, cool=5000, daylight=6500');
    expect(text).toContain('"sterile" or "clinical" lighting means bright white');
    expect(text).toContain('light.brightness_pct=100 with light.color_temp_kelvin=6500');
    expect(text).toContain('Treat the fused transcription "sterilites" as "sterile lights"');
    expect(text).toContain('An absolute light percentage is light.brightness_pct');
    expect(text).toContain('Relative "brighter" uses a positive light.brightness_step_pct');
    expect(text).toContain('"dimmer" or "darker" uses a negative one');
    expect(text).toContain('"over/in N seconds" is light.transition_seconds=N');
    expect(text).toContain('light.flash="short"');
    expect(text).toContain('"turn off the effect" and "stop the effect" mean light.effect="off"');
  });

  it('instructs the model to accept area aliases and treat area lights as a collective', () => {
    const text = buildInstructions(cache, {
      ...TEST_POLICY,
      areaAliases: { office: ['Living Room'] },
    });

    expect(text).toContain('AREA: Living Room\n  aliases: office\n');
    expect(text).toContain('lists valid spoken aliases for the canonical name');
    expect(text).toContain('set area to only that canonical AREA name');
    expect(text).toContain('Never include "aliases:" text or an alias annotation in the area value');
    expect(text).toContain('call control_device with target "lights" and the canonical AREA name');
    expect(text).toContain('Do not select a similarly named device/group or refuse a listed area alias');
  });

  it('adds the origin-room line when provided', () => {
    const text = buildInstructions(cache, TEST_POLICY, 'Kitchen');
    expect(text).toContain('The device that heard this command is in: Kitchen');
  });
});
