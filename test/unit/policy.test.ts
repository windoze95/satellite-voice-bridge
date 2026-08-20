import { describe, expect, it } from 'vitest';
import { decide } from '../../src/policy/engine.js';
import type { ProposedAction } from '../../src/realtime/tools.js';
import { buildFixtureCache, TEST_POLICY } from '../mocks/fixture-cache.js';

const cache = buildFixtureCache();

const propose = (p: Partial<ProposedAction>): ProposedAction => ({
  action: 'turn_on',
  domain: 'light',
  target: 'lights',
  area: 'kitchen',
  value: null,
  light: null,
  ...p,
});

describe('decide', () => {
  it('GREEN executes immediately', () => {
    const d = decide(cache, TEST_POLICY, propose({}));
    expect(d.outcome).toBe('execute');
    expect(d.tier).toBe('green');
    expect(d.resolved?.service).toBe('turn_on');
    expect(d.entityIds).toHaveLength(3);
  });

  it('dry_run resolves fully but does not execute', () => {
    const d = decide(cache, { ...TEST_POLICY, dryRun: true }, propose({}));
    expect(d.outcome).toBe('dry_run');
    expect(d.resolved).toBeDefined();
  });

  it('YELLOW without opt-in is refused', () => {
    const d = decide(cache, TEST_POLICY, propose({ domain: 'lock', action: 'lock', target: 'front door', area: null }));
    expect(d).toMatchObject({ outcome: 'refuse', tier: 'yellow', reason: 'not_opted_in' });
    expect(d.message).toContain('lock.front_door');
  });

  it('YELLOW with explicit opt-in executes', () => {
    const cfg = { ...TEST_POLICY, yellowAllow: ['lock.front_door'] };
    const d = decide(cache, cfg, propose({ domain: 'lock', action: 'lock', target: 'front door', area: null }));
    expect(d.outcome).toBe('execute');
    expect(d.resolved?.service).toBe('lock');
  });

  it('collective commands on YELLOW are refused even when opted in', () => {
    const cfg = { ...TEST_POLICY, yellowAllow: ['lock.front_door'] };
    const d = decide(cache, cfg, propose({ domain: 'lock', action: 'lock', target: 'all locks', area: null }));
    expect(d).toMatchObject({ outcome: 'refuse', reason: 'collective_on_yellow' });
  });

  it('RED is refused regardless of anything', () => {
    const d = decide(cache, TEST_POLICY, propose({ domain: 'alarm_control_panel', action: 'disarm', target: 'alarm', area: null }));
    expect(d).toMatchObject({ outcome: 'refuse', tier: 'red', reason: 'red_tier' });
  });

  it('unlisted domains are refused as unknown', () => {
    const cfg = { ...TEST_POLICY, tiers: { ...TEST_POLICY.tiers, yellow: ['lock', 'climate'] } };
    const d = decide(cache, cfg, propose({ domain: 'cover', action: 'open', target: 'garage door', area: null }));
    expect(d).toMatchObject({ outcome: 'refuse', tier: 'unknown', reason: 'unknown_domain' });
  });

  it('unsupported action×domain combos are refused', () => {
    const d = decide(cache, TEST_POLICY, propose({ action: 'play' }));
    expect(d).toMatchObject({ outcome: 'refuse', reason: 'unsupported_action' });
  });

  it('set without a value is refused', () => {
    const d = decide(cache, TEST_POLICY, propose({ action: 'set', target: 'island' }));
    expect(d).toMatchObject({ outcome: 'refuse', reason: 'missing_value' });
  });

  it('plans structured light data against resolved target capabilities', () => {
    const capable = buildFixtureCache();
    for (const entityId of ['light.kitchen_ceiling', 'light.kitchen_island', 'light.kitchen_sink']) {
      const state = capable.statesById.get(entityId);
      if (!state) throw new Error(`fixture is missing ${entityId}`);
      state.attributes.supported_color_modes = ['color_temp', 'xy'];
      state.attributes.supported_features = 32;
      state.attributes.min_color_temp_kelvin = 2200;
      state.attributes.max_color_temp_kelvin = 6500;
    }
    const d = decide(
      capable,
      TEST_POLICY,
      propose({
        light: {
          brightness_pct: 35,
          brightness_step_pct: null,
          rgb_color: [128, 0, 128],
          color_temp_kelvin: null,
          effect: null,
          transition_seconds: 3,
          flash: null,
        },
      }),
    );

    expect(d).toMatchObject({ outcome: 'execute', entityIds: ['light.kitchen_ceiling', 'light.kitchen_island', 'light.kitchen_sink'] });
    expect(d.resolved).toMatchObject({
      service: 'turn_on',
      serviceData: { brightness_pct: 35, rgb_color: [128, 0, 128], transition: 3 },
    });
  });

  it('validates and preserves a model-selected advertised effect', () => {
    const capable = buildFixtureCache();
    for (const entityId of ['light.kitchen_ceiling', 'light.kitchen_island', 'light.kitchen_sink']) {
      const state = capable.statesById.get(entityId);
      if (!state) throw new Error(`fixture is missing ${entityId}`);
      state.attributes.supported_color_modes = ['xy'];
      state.attributes.supported_features = 4;
      state.attributes.effect_list = ['off', 'prism', 'sparkle'];
    }
    const d = decide(
      capable,
      TEST_POLICY,
      propose({
        light: {
          brightness_pct: null,
          brightness_step_pct: null,
          rgb_color: null,
          color_temp_kelvin: null,
          effect: 'sparkle',
          transition_seconds: null,
          flash: null,
        },
      }),
    );

    expect(d).toMatchObject({ outcome: 'execute' });
    expect(d.resolved?.serviceData).toEqual({ effect: 'sparkle' });
  });

  it('rechecks the collective limit after a light group expands to leaf targets', () => {
    const grouped = buildFixtureCache();
    const memberIds = ['light.kitchen_ceiling', 'light.kitchen_island', 'light.kitchen_sink'];
    const templateEntry = grouped.entitiesById.get(memberIds[0]!);
    const templateState = grouped.statesById.get(memberIds[0]!);
    if (!templateEntry || !templateState) throw new Error('fixture is missing a kitchen light');
    for (const entityId of memberIds) {
      grouped.entitiesById.delete(entityId);
      const state = grouped.statesById.get(entityId);
      if (!state) throw new Error(`fixture is missing ${entityId}`);
      state.attributes.supported_color_modes = ['xy'];
    }
    grouped.entitiesById.set('light.kitchen_group', {
      ...templateEntry,
      entity_id: 'light.kitchen_group',
      name: 'Kitchen group',
      original_name: 'Kitchen group',
    });
    grouped.statesById.set('light.kitchen_group', {
      ...templateState,
      entity_id: 'light.kitchen_group',
      attributes: {
        ...templateState.attributes,
        friendly_name: 'Kitchen group',
        entity_id: memberIds,
        supported_color_modes: ['xy'],
      },
    });

    const d = decide(
      grouped,
      { ...TEST_POLICY, matching: { ...TEST_POLICY.matching, maxCollectiveTargets: 2 } },
      propose({
        light: {
          brightness_pct: null,
          brightness_step_pct: null,
          rgb_color: [255, 0, 0],
          color_temp_kelvin: null,
          effect: null,
          transition_seconds: null,
          flash: null,
        },
      }),
    );

    expect(d).toMatchObject({ outcome: 'refuse', reason: 'too_many_targets' });
    expect(d.message).toContain('would touch 3 devices (limit 2)');
  });

  it('deduplicates a registered group and its members before applying the collective limit', () => {
    const grouped = buildFixtureCache();
    const memberIds = ['light.kitchen_ceiling', 'light.kitchen_island', 'light.kitchen_sink'];
    const templateEntry = grouped.entitiesById.get(memberIds[0]!);
    const templateState = grouped.statesById.get(memberIds[0]!);
    if (!templateEntry || !templateState) throw new Error('fixture is missing a kitchen light');
    for (const entityId of memberIds) {
      const state = grouped.statesById.get(entityId);
      if (!state) throw new Error(`fixture is missing ${entityId}`);
      state.attributes.supported_color_modes = ['xy'];
    }
    grouped.entitiesById.set('light.kitchen_group', {
      ...templateEntry,
      entity_id: 'light.kitchen_group',
      name: 'Kitchen group',
      original_name: 'Kitchen group',
    });
    grouped.statesById.set('light.kitchen_group', {
      ...templateState,
      entity_id: 'light.kitchen_group',
      attributes: {
        ...templateState.attributes,
        friendly_name: 'Kitchen group',
        entity_id: memberIds,
        supported_color_modes: ['xy'],
      },
    });

    const d = decide(
      grouped,
      { ...TEST_POLICY, matching: { ...TEST_POLICY.matching, maxCollectiveTargets: 3 } },
      propose({
        light: {
          brightness_pct: null,
          brightness_step_pct: null,
          rgb_color: [255, 0, 0],
          color_temp_kelvin: null,
          effect: null,
          transition_seconds: null,
          flash: null,
        },
      }),
    );

    expect(d).toMatchObject({ outcome: 'execute', entityIds: memberIds });
  });

  it('resolution failures pass through with their reason', () => {
    const d = decide(cache, TEST_POLICY, propose({ target: 'ceiling', area: null }));
    expect(d).toMatchObject({ outcome: 'refuse', reason: 'ambiguous' });
  });
});
