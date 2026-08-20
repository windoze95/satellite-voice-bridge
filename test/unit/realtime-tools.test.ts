import { describe, expect, it } from 'vitest';
import { parseControlDeviceArgs } from '../../src/realtime/tools.js';

const args = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ action: 'turn_on', domain: 'light', target: 'lights', area: 'Office', value: null, ...overrides });

describe('control_device light settings', () => {
  it('parses a compound light request and supplies nullable defaults', () => {
    const parsed = parseControlDeviceArgs(
      args({ light: { brightness_pct: 35, rgb_color: [128, 0, 128], transition_seconds: 3, flash: 'short' } }),
    );

    expect(parsed).toEqual({
      ok: true,
      action: {
        action: 'turn_on',
        domain: 'light',
        target: 'lights',
        area: 'Office',
        value: null,
        light: {
          brightness_pct: 35,
          brightness_step_pct: null,
          rgb_color: [128, 0, 128],
          color_temp_kelvin: null,
          effect: null,
          transition_seconds: 3,
          flash: 'short',
        },
      },
    });
  });

  it('accepts a model-selected named effect', () => {
    const parsed = parseControlDeviceArgs(args({ light: { effect: 'sparkle' } }));
    expect(parsed).toMatchObject({ ok: true, action: { light: { effect: 'sparkle' } } });
  });

  it('accepts a relative brightness step and refuses absolute/relative conflicts', () => {
    expect(parseControlDeviceArgs(args({ light: { brightness_step_pct: -25 } }))).toMatchObject({
      ok: true,
      action: { light: { brightness_step_pct: -25 } },
    });
    const conflict = parseControlDeviceArgs(
      args({ light: { brightness_pct: 50, brightness_step_pct: 20 } }),
    );
    expect(conflict).toMatchObject({ ok: false });
    if (!conflict.ok) expect(conflict.error).toContain('mutually exclusive');
  });

  it('keeps the legacy value-only contract', () => {
    const parsed = parseControlDeviceArgs(args({ value: '50%' }));
    expect(parsed).toMatchObject({ ok: true, action: { value: '50%', light: null } });
  });

  it.each([
    [{ light: { rgb_color: [255, 0, 0], color_temp_kelvin: 2700 } }, 'mutually exclusive'],
    [{ value: 50, light: { transition_seconds: 2 } }, 'cannot be combined'],
    [{ domain: 'fan', light: { brightness_pct: 50 } }, 'only valid for the light domain'],
    [{ action: 'toggle', light: { flash: 'short' } }, 'cannot include light settings'],
    [{ action: 'turn_off', light: { brightness_pct: 50 } }, 'turn_off only accepts'],
    [{ light: { rgb_color: [256, 0, 0] } }, 'Too big'],
    [{ light: { surprise: true } }, 'Invalid input'],
    [{ light: { color_temp_kelvin: 0.4 } }, 'at least 1'],
    [{ light: { brightness_step_pct: 0 } }, 'magnitude at least 1'],
  ])('refuses invalid settings: %o', (overrides, message) => {
    const parsed = parseControlDeviceArgs(args(overrides));
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it('allows transition and flash on turn_off', () => {
    const parsed = parseControlDeviceArgs(args({ action: 'turn_off', light: { transition_seconds: 2, flash: 'long' } }));
    expect(parsed).toMatchObject({ ok: true, action: { action: 'turn_off', light: { transition_seconds: 2, flash: 'long' } } });
  });
});
