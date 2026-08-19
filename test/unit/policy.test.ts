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

  it('resolution failures pass through with their reason', () => {
    const d = decide(cache, TEST_POLICY, propose({ target: 'ceiling', area: null }));
    expect(d).toMatchObject({ outcome: 'refuse', reason: 'ambiguous' });
  });
});
