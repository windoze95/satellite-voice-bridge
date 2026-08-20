import { describe, expect, it } from 'vitest';
import { mapService } from '../../src/ha/executor.js';
import type { LightOptions } from '../../src/realtime/tools.js';

const light = (overrides: Partial<LightOptions>): LightOptions => ({
  brightness_pct: null,
  brightness_step_pct: null,
  rgb_color: null,
  color_temp_kelvin: null,
  effect: null,
  transition_seconds: null,
  flash: null,
  ...overrides,
});

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

  it('maps structured light settings only to allowlisted light.turn_on data', () => {
    expect(
      mapService(
        'turn_on',
        'light',
        null,
        light({ brightness_pct: 35, rgb_color: [128, 0, 128], transition_seconds: 3, flash: 'short' }),
      ),
    ).toMatchObject({
      ok: true,
      service: 'turn_on',
      serviceData: { brightness_pct: 35, rgb_color: [128, 0, 128], transition: 3, flash: 'short' },
    });
    expect(mapService('set', 'light', null, light({ color_temp_kelvin: 2700 }))).toMatchObject({
      ok: true,
      service: 'turn_on',
      serviceData: { color_temp_kelvin: 2700 },
    });
    expect(mapService('turn_on', 'light', null, light({ effect: 'sparkle' }))).toMatchObject({
      ok: true,
      serviceData: { effect: 'sparkle' },
    });
    expect(mapService('turn_on', 'light', null, light({ color_temp_kelvin: 0.4 }))).toMatchObject({
      ok: false,
      reason: 'invalid_value',
    });
    expect(mapService('turn_on', 'light', null, light({ brightness_step_pct: 25 }))).toMatchObject({
      ok: true,
      serviceData: { brightness_step_pct: 25 },
    });
  });

  it('allows only transition and flash data on turn_off', () => {
    expect(mapService('turn_off', 'light', null, light({ transition_seconds: 2, flash: 'long' }))).toMatchObject({
      ok: true,
      service: 'turn_off',
      serviceData: { transition: 2, flash: 'long' },
    });
    expect(mapService('turn_off', 'light', null, light({ brightness_pct: 50 }))).toMatchObject({
      ok: false,
      reason: 'invalid_value',
    });
  });

  it('defensively refuses conflicting legacy and structured light values', () => {
    expect(mapService('turn_on', 'light', 50, light({ transition_seconds: 2 }))).toMatchObject({
      ok: false,
      reason: 'invalid_value',
    });
    expect(mapService('toggle', 'light', null, light({ flash: 'short' }))).toMatchObject({
      ok: false,
      reason: 'invalid_value',
    });
    expect(mapService('turn_on', 'fan', null, light({ brightness_pct: 50 }))).toMatchObject({
      ok: false,
      reason: 'invalid_value',
    });
    expect(mapService('turn_on', 'light', null, light({ rgb_color: [255, 0, 0], effect: 'prism' }))).toMatchObject({
      ok: false,
      reason: 'invalid_value',
    });
    expect(
      mapService('turn_on', 'light', null, light({ brightness_pct: 50, brightness_step_pct: 20 })),
    ).toMatchObject({ ok: false, reason: 'invalid_value' });
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
