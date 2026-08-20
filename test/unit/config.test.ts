import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_MODEL, loadConfig, missingEnv } from '../../src/config.js';

const BASE_ENV = { OPENAI_API_KEY: 'sk-test', HA_URL: 'http://ha.local:8123/', HA_TOKEN: 'tok' };

describe('loadConfig', () => {
  it('falls back to documented defaults when no yaml exists', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vb-'));
    const cfg = loadConfig(BASE_ENV, cwd);
    expect(cfg.configFileFound).toBe(false);
    expect(cfg.session.mode).toBe('per_utterance');
    expect(cfg.session.model).toBe(DEFAULT_MODEL);
    expect(cfg.session.ackResponse).toBe(false);
    expect(cfg.policy.tiers.green).toContain('light');
    expect(cfg.policy.tiers.red).toContain('alarm_control_panel');
    expect(cfg.policy.matching.minConfidence).toBe(0.6);
    expect(cfg.haUrl).toBe('http://ha.local:8123'); // trailing slash stripped
  });

  it('applies yaml values and keeps defaults for omitted keys', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vb-'));
    writeFileSync(
      join(cwd, 'voicebridge.yaml'),
      [
        'session: { mode: warm, ack_response: false }',
        'policy:',
        '  yellow_allow: [lock.front_door]',
        '  matching: { min_confidence: 0.8 }',
        '  area_aliases: { "down here": [Living Room, Kitchen] }',
        'satellites: { sat-kitchen: Kitchen }',
      ].join('\n'),
    );
    const cfg = loadConfig(BASE_ENV, cwd);
    expect(cfg.configFileFound).toBe(true);
    expect(cfg.session.mode).toBe('warm');
    expect(cfg.session.ackResponse).toBe(false);
    expect(cfg.session.transcribeInput).toBe(true);
    expect(cfg.policy.yellowAllow).toEqual(['lock.front_door']);
    expect(cfg.policy.matching.minConfidence).toBe(0.8);
    expect(cfg.policy.matching.maxCollectiveTargets).toBe(10);
    expect(cfg.policy.areaAliases['down here']).toEqual(['Living Room', 'Kitchen']);
    expect(cfg.satellites['sat-kitchen']).toEqual({
      area: 'Kitchen',
      host: undefined,
      port: 6053,
      haEntryId: undefined,
      encryptionKeyEnv: undefined,
      encryptionKey: undefined,
    });
  });

  it('loads live satellite connection settings without putting the key in yaml', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vb-'));
    writeFileSync(
      join(cwd, 'voicebridge.yaml'),
      [
        'satellites:',
        '  satellite1-aabbcc:',
        '    area: Kitchen',
        '    host: 192.168.107.42',
        '    port: 6053',
        '    ha_entry_id: 01SATELLITE',
        '    encryption_key_env: SATELLITE1_ENCRYPTION_KEY',
      ].join('\n'),
    );

    const cfg = loadConfig({ ...BASE_ENV, SATELLITE1_ENCRYPTION_KEY: 'secret-from-env' }, cwd);
    expect(cfg.satellites['satellite1-aabbcc']).toEqual({
      area: 'Kitchen',
      host: '192.168.107.42',
      port: 6053,
      haEntryId: '01SATELLITE',
      encryptionKeyEnv: 'SATELLITE1_ENCRYPTION_KEY',
      encryptionKey: 'secret-from-env',
    });
  });

  it('allows a live satellite without an area until placement is assigned', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vb-'));
    writeFileSync(
      join(cwd, 'voicebridge.yaml'),
      ['satellites:', '  satellite1-aabbcc:', '    host: 192.168.20.135', '    ha_entry_id: 01SATELLITE'].join('\n'),
    );

    expect(loadConfig(BASE_ENV, cwd).satellites['satellite1-aabbcc']?.area).toBeUndefined();
  });

  it('env model overrides yaml model', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vb-'));
    writeFileSync(join(cwd, 'voicebridge.yaml'), 'session: { model: gpt-realtime-2.1 }');
    expect(loadConfig(BASE_ENV, cwd).session.model).toBe('gpt-realtime-2.1');
    expect(loadConfig({ ...BASE_ENV, VOICEBRIDGE_MODEL: 'x-model' }, cwd).session.model).toBe('x-model');
  });

  it('rejects invalid config with a readable error', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vb-'));
    writeFileSync(join(cwd, 'voicebridge.yaml'), 'session: { mode: sideways }');
    expect(() => loadConfig(BASE_ENV, cwd)).toThrow(ConfigError);
    expect(() => loadConfig(BASE_ENV, cwd)).toThrow(/session\.mode/);
  });

  it('reports missing env vars', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vb-'));
    expect(missingEnv(loadConfig({}, cwd))).toEqual(['OPENAI_API_KEY', 'HA_URL', 'HA_TOKEN']);
    expect(missingEnv(loadConfig(BASE_ENV, cwd))).toEqual([]);
  });
});
