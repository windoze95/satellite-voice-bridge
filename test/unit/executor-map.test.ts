import { describe, expect, it } from 'vitest';
import { mapService } from '../../src/ha/executor.js';

describe('mapService (fixed action×domain allowlist)', () => {
  it.each([
    ['turn_on', 'light', null, 'turn_on', {}],
    ['turn_off', 'light', null, 'turn_off', {}],
    ['set', 'light', 50, 'turn_on', { brightness_pct: 50 }],
    ['set', 'light', '50%', 'turn_on', { brightness_pct: 50 }],
    ['turn_on', 'light', 30, 'turn_on', { brightness_pct: 30 }],
    ['set', 'fan', 75, 'set_percentage', { percentage: 75 }],
    ['toggle', 'switch', null, 'toggle', {}],
    ['play', 'media_player', null, 'media_play', {}],
    ['set', 'media_player', 40, 'volume_set', { volume_level: 0.4 }],
    ['activate', 'scene', null, 'turn_on', {}],
    ['activate', 'script', null, 'turn_on', {}],
    ['open', 'cover', null, 'open_cover', {}],
    ['set', 'cover', 30, 'set_cover_position', { position: 30 }],
    ['lock', 'lock', null, 'lock', {}],
    ['unlock', 'lock', null, 'unlock', {}],
    ['set', 'climate', 21.5, 'set_temperature', { temperature: 21.5 }],
  ] as const)('%s %s (%o) → %s %o', (action, domain, value, service, data) => {
    const m = mapService(action, domain, value as number | string | null);
    expect(m).toMatchObject({ ok: true, service, serviceData: data });
  });

  it('clamps percents to 0–100', () => {
    expect(mapService('set', 'light', 250)).toMatchObject({ ok: true, serviceData: { brightness_pct: 100 } });
    expect(mapService('set', 'light', -5)).toMatchObject({ ok: true, serviceData: { brightness_pct: 0 } });
  });

  it('refuses set without a usable value', () => {
    expect(mapService('set', 'light', null)).toMatchObject({ ok: false, reason: 'missing_value' });
    expect(mapService('set', 'fan', 'high-ish')).toMatchObject({ ok: false, reason: 'missing_value' });
  });

  it('refuses unsupported combinations — arbitrary services are impossible', () => {
    expect(mapService('disarm', 'light', null)).toMatchObject({ ok: false, reason: 'unsupported_action' });
    expect(mapService('unlock', 'scene', null)).toMatchObject({ ok: false, reason: 'unsupported_action' });
    expect(mapService('disarm', 'alarm_control_panel', null)).toMatchObject({ ok: false, reason: 'unsupported_action' });
    expect(mapService('turn_on', 'vacuum', null)).toMatchObject({ ok: false, reason: 'unsupported_action' });
  });

  it('marks scenes and scripts fire-and-forget, devices state-verified', () => {
    expect(mapService('activate', 'scene', null)).toMatchObject({ ok: true, verification: 'fire_and_forget' });
    expect(mapService('turn_on', 'light', null)).toMatchObject({ ok: true, verification: 'state' });
  });
});
