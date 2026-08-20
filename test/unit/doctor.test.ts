import { describe, expect, it } from 'vitest';
import { environmentCheck } from '../../src/commands/doctor.js';

describe('doctor environment check', () => {
  it('never includes any part of configured credentials', () => {
    const openaiApiKey = 'sk-proj-visible-prefix-and-secret-tail-1234';
    const haToken = 'ha-visible-prefix-and-secret-tail-5678';

    const result = environmentCheck({
      openaiApiKey,
      haUrl: 'http://homeassistant.local:8123',
      haToken,
    });

    expect(result).toEqual({
      ok: true,
      detail: 'OPENAI_API_KEY=[set], HA_URL=http://homeassistant.local:8123, HA_TOKEN=[set]',
    });
    expect(result.detail).not.toContain(openaiApiKey);
    expect(result.detail).not.toContain(haToken);
    expect(result.detail).not.toContain('1234');
    expect(result.detail).not.toContain('5678');
  });

  it('still names every missing environment variable', () => {
    expect(environmentCheck({ openaiApiKey: undefined, haUrl: undefined, haToken: undefined })).toEqual({
      ok: false,
      detail: 'missing OPENAI_API_KEY, HA_URL, HA_TOKEN — fill them in .env',
    });
  });
});
