import { describe, expect, it } from 'vitest';
import { CommandTrace, estimateCostUsd } from '../../src/telemetry.js';

function tracedCommand(): CommandTrace {
  const tr = new CommandTrace('text', 'gpt-realtime-2.1-mini', 'per_utterance');
  tr.utterance = 'turn on the kitchen lights';
  tr.markAt('t0', 1000);
  tr.markAt('t1', 1400);
  tr.markAt('t3', 2000);
  tr.markAt('t4', 2418);
  tr.markAt('t5', 2419);
  tr.markAt('t6', 2419);
  tr.markAt('t7', 2508);
  tr.markAt('t8', 2742);
  return tr;
}

describe('CommandTrace', () => {
  it('computes deltas including the headline speech_to_action', () => {
    const d = tracedCommand().deltas();
    expect(d.session_setup).toBe(400);
    expect(d.model).toBe(418);
    expect(d.policy).toBe(1);
    expect(d.ha_ack).toBe(89);
    expect(d.confirm).toBe(234);
    expect(d.speech_to_action).toBe(742);
    expect(d.speech_to_ack).toBe(508);
  });

  it('first mark wins; copyMark backfills fire-and-forget T8', () => {
    const tr = new CommandTrace('text', 'gpt-realtime-2.1-mini', 'per_utterance');
    tr.markAt('t7', 100);
    tr.markAt('t7', 999);
    tr.copyMark('t7', 't8');
    expect(tr.deltas().confirm).toBe(0);
  });

  it('accumulates usage across responses and prices it', () => {
    const tr = tracedCommand();
    tr.addUsage({ inputTextTokens: 700, cachedTextTokens: 500, outputTextTokens: 40 });
    tr.addUsage({ inputTextTokens: 760, cachedTextTokens: 700, outputTextTokens: 20 });
    const rec = tr.finish();
    expect(rec.usage.inputTextTokens).toBe(1460);
    // (1460-1200)*0.6 + 1200*0.06 + 60*2.4 per 1M
    expect(rec.cost_usd).toBeCloseTo((260 * 0.6 + 1200 * 0.06 + 60 * 2.4) / 1e6, 9);
  });

  it('unknown model yields null cost, not a crash', () => {
    expect(
      estimateCostUsd('mystery-model', {
        inputTextTokens: 1,
        inputAudioTokens: 1,
        cachedTextTokens: 0,
        cachedAudioTokens: 0,
        outputTextTokens: 1,
      }),
    ).toBeNull();
  });

  it('produces a JSONL record with the documented keys', () => {
    const tr = tracedCommand();
    tr.outcome = 'executed';
    tr.decisions.push({ outcome: 'execute', tier: 'green', message: 'ok', entityIds: ['light.kitchen_ceiling'], service: 'turn_on', verified: true });
    const rec = tr.finish();
    for (const key of ['ts', 'cmd_id', 'source', 'ok', 'outcome', 'model', 'session_mode', 'function_calls', 'decisions', 't', 'd', 'usage', 'cost_usd']) {
      expect(rec).toHaveProperty(key);
    }
    expect(rec.ok).toBe(true);
    expect(() => JSON.stringify(rec)).not.toThrow();
  });

  it('renders the console summary line', () => {
    const tr = tracedCommand();
    tr.outcome = 'executed';
    tr.addUsage({ inputTextTokens: 700, outputTextTokens: 60 });
    tr.decisions.push({ outcome: 'execute', tier: 'green', message: 'ok', entityIds: ['light.kitchen_ceiling'], service: 'turn_on', verified: true });
    const line = tr.summaryLine();
    expect(line).toContain('✔');
    expect(line).toContain('light.kitchen_ceiling on');
    expect(line).toContain('speech→action 742 ms');
    expect(line).toContain('model 418');
    expect(line).toMatch(/\$\d/);
  });

  it('renders a refusal line', () => {
    const tr = tracedCommand();
    tr.outcome = 'refused';
    tr.decisions.push({ outcome: 'refuse', tier: 'red', reason: 'red_tier', message: 'alarm control is never allowed', entityIds: [] });
    const line = tr.summaryLine();
    expect(line).toContain('✖');
    expect(line).toContain('red_tier');
  });
});
