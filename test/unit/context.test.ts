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

  it('adds the origin-room line when provided', () => {
    const text = buildInstructions(cache, TEST_POLICY, 'Kitchen');
    expect(text).toContain('The device that heard this command is in: Kitchen');
  });
});
