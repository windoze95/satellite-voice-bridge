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
