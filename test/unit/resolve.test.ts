import { describe, expect, it } from 'vitest';
import { isCollective, matchAreas, resolveTargets } from '../../src/policy/resolve.js';
import type { ProposedAction } from '../../src/realtime/tools.js';
import { buildFixtureCache, TEST_POLICY } from '../mocks/fixture-cache.js';

const cache = buildFixtureCache();
const cfg = { ...TEST_POLICY, areaAliases: { 'down here': ['Living Room', 'Kitchen'] } };

const propose = (p: Partial<ProposedAction>): ProposedAction => ({
  action: 'turn_on',
  domain: 'light',
  target: 'lights',
  area: null,
  value: null,
  ...p,
});

describe('isCollective', () => {
  it.each([
    ['lights', 'light', true],
    ['all lights', 'light', true],
    ['all the lights', 'light', true],
    ['everything', 'light', true],
    ['fans', 'fan', true],
    ['ceiling', 'light', false],
    ['floor lamp', 'light', false],
    ['movie time', 'scene', false],
  ])('%s (%s) → %s', (target, domain, expected) => {
    expect(isCollective(target, domain)).toBe(expected);
  });
});

describe('matchAreas', () => {
  it('matches names, registry aliases, and config aliases', () => {
    expect(matchAreas(cache, cfg, 'Kitchen').map((a) => a.area_id)).toEqual(['kitchen']);
    expect(matchAreas(cache, cfg, 'the lounge').map((a) => a.area_id)).toEqual([]);
    expect(matchAreas(cache, cfg, 'lounge').map((a) => a.area_id)).toEqual(['living_room']);
    expect(matchAreas(cache, cfg, 'down here').map((a) => a.area_id).sort()).toEqual(['kitchen', 'living_room']);
    expect(matchAreas(cache, cfg, 'garage')).toEqual([]);
  });
});

describe('resolveTargets', () => {
  it('collective in an area → every controllable light there', () => {
    const res = resolveTargets(cache, cfg, propose({ target: 'lights', area: 'kitchen' }));
    expect(res).toMatchObject({ ok: true, collective: true });
    if (res.ok) expect(res.entityIds.sort()).toEqual(['light.kitchen_ceiling', 'light.kitchen_island', 'light.kitchen_sink']);
  });

  it('collective over a multi-area config alias', () => {
    const res = resolveTargets(cache, cfg, propose({ target: 'lights', area: 'down here' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entityIds.sort()).toEqual([
        'light.kitchen_ceiling',
        'light.kitchen_island',
        'light.kitchen_sink',
        'light.living_room_ceiling',
        'light.living_room_floor_lamp',
      ]);
    }
  });

  it('resolves a named device inside an area', () => {
    const res = resolveTargets(cache, cfg, propose({ target: 'island', area: 'kitchen' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.entityIds).toEqual(['light.kitchen_island']);
  });

  it('resolves through entity aliases', () => {
    const res = resolveTargets(cache, cfg, propose({ target: 'the lamp' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.entityIds).toEqual(['light.living_room_floor_lamp']);
  });

  it('falls back to the device area when the entity has none', () => {
    const res = resolveTargets(cache, cfg, propose({ target: 'floor lamp', area: 'living room' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.entityIds).toEqual(['light.living_room_floor_lamp']);
  });

  it('refuses ambiguous matches instead of guessing', () => {
    const res = resolveTargets(cache, cfg, propose({ target: 'ceiling' }));
    expect(res).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('origin room disambiguates when no area is spoken', () => {
    const res = resolveTargets(cache, cfg, propose({ target: 'ceiling' }), 'Kitchen');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.entityIds).toEqual(['light.kitchen_ceiling']);
  });

  it('origin room widens to the whole house when the room has none of the domain', () => {
    const res = resolveTargets(cache, cfg, propose({ domain: 'fan', target: 'ceiling fan' }), 'Kitchen');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.entityIds).toEqual(['fan.living_room']);
  });

  it('refuses unknown areas and lists the known ones', () => {
    const res = resolveTargets(cache, cfg, propose({ target: 'lights', area: 'garage' }));
    expect(res).toMatchObject({ ok: false, reason: 'unknown_area' });
    if (!res.ok) expect(res.message).toContain('Kitchen');
  });

  it('refuses areas that have no devices of the domain', () => {
    const res = resolveTargets(cache, cfg, propose({ target: 'lights', area: 'office' }));
    expect(res).toMatchObject({ ok: false, reason: 'no_devices_in_scope' });
  });

  it('refuses low-confidence matches', () => {
    const res = resolveTargets(cache, cfg, propose({ target: 'disco ball' }));
    expect(res).toMatchObject({ ok: false, reason: 'no_confident_match' });
  });

  it('refuses oversized collectives', () => {
    const small = { ...cfg, matching: { ...cfg.matching, maxCollectiveTargets: 2 } };
    const res = resolveTargets(cache, small, propose({ target: 'all lights' }));
    expect(res).toMatchObject({ ok: false, reason: 'too_many_targets' });
  });

  it('never matches disabled or diagnostic entities', () => {
    const res = resolveTargets(cache, cfg, propose({ target: 'hallway debug' }));
    expect(res.ok).toBe(false);
    const res2 = resolveTargets(cache, cfg, propose({ target: 'status indicator' }));
    expect(res2.ok).toBe(false);
  });

  it('matches scenes by name and alias', () => {
    const byName = resolveTargets(cache, cfg, propose({ domain: 'scene', action: 'activate', target: 'movie time' }));
    expect(byName.ok).toBe(true);
    const byAlias = resolveTargets(cache, cfg, propose({ domain: 'scene', action: 'activate', target: 'movie mode' }));
    expect(byAlias.ok).toBe(true);
    if (byAlias.ok) expect(byAlias.entityIds).toEqual(['scene.movie_time']);
  });

  it("possessive names match spoken forms (Yana's Lamp)", () => {
    const res = resolveTargets(cache, cfg, propose({ target: "yana's lamp", area: 'master bedroom' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.entityIds).toEqual(['light.master_yana_lamp']);
  });
});
