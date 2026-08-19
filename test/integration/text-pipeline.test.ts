import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { HAClient } from '../../src/ha/client.js';
import { Registry } from '../../src/ha/registry.js';
import { Logger } from '../../src/logger.js';
import { runCommand, type PipelineDeps } from '../../src/pipeline.js';
import { SessionManager } from '../../src/realtime/session.js';
import { MockHAServer } from '../mocks/mock-ha-server.js';
import { MockRealtimeServer, type MockRealtimeOptions } from '../mocks/mock-realtime-server.js';

const logger = new Logger({ level: 'error' });

const ARGS_KITCHEN = JSON.stringify({ action: 'turn_on', domain: 'light', target: 'lights', area: 'kitchen' });
const ARGS_ALARM = JSON.stringify({ action: 'disarm', domain: 'alarm_control_panel', target: 'alarm', area: null });

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

async function makeDeps(rtOpts: MockRealtimeOptions): Promise<{ deps: PipelineDeps; ha: MockHAServer; rt: MockRealtimeServer; cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), 'vb-e2e-'));
  const ha = await MockHAServer.start();
  const rt = await MockRealtimeServer.start(rtOpts);
  const cfg = loadConfig(
    { OPENAI_API_KEY: 'sk-test', HA_URL: ha.url, HA_TOKEN: 'test-token', VOICEBRIDGE_REALTIME_URL: rt.url },
    cwd,
  );
  const registry = new Registry(logger, { voiceDomains: ['light', 'fan', 'switch', 'media_player', 'scene', 'script', 'lock', 'cover', 'climate'] });
  const haClient = new HAClient({ url: ha.url, token: 'test-token', logger, retry: false, onSync: (c) => registry.sync(c) });
  registry.attach(haClient);
  const sessions = new SessionManager({
    mode: 'per_utterance',
    url: rt.url,
    apiKey: 'sk-test',
    model: cfg.session.model,
    transcribe: false,
    logger,
  });
  cleanups.push(async () => {
    sessions.close();
    haClient.stop();
    await rt.close();
    await ha.close();
  });
  await haClient.start();
  return { deps: { cfg, logger, haClient, registry, sessions }, ha, rt, cwd };
}

describe('text pipeline (mock OpenAI + mock HA)', () => {
  it('runs the full loop: text → function call → policy → HA → verify → ack', async () => {
    const { deps, ha, rt, cwd } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: ARGS_KITCHEN }] }, { text: 'Done.' }],
    });
    const rec = await runCommand(deps, { kind: 'text', utterance: 'turn on the kitchen lights' });

    expect(rec.outcome).toBe('executed');
    expect(rec.ok).toBe(true);
    expect(rec.decisions[0]).toMatchObject({ outcome: 'execute', tier: 'green', service: 'turn_on', verified: true });
    expect(rec.decisions[0]?.entityIds.sort()).toEqual(['light.kitchen_ceiling', 'light.kitchen_island', 'light.kitchen_sink']);
    expect(rec.ack).toBe('Done.');
    for (const key of ['t0', 't1', 't3', 't4', 't5', 't6', 't7', 't8'] as const) expect(rec.t[key]).toBeDefined();
    expect(rec.d.speech_to_action).toBeDefined();
    expect(rec.usage.inputTextTokens).toBe(1360); // two responses × 680
    expect(rec.cost_usd).toBeGreaterThan(0);

    expect(ha.callServiceCalls).toHaveLength(1);
    expect(ha.callServiceCalls[0]).toMatchObject({ domain: 'light', service: 'turn_on' });

    const output = rt.received.find((m) => (m.item as { type?: string } | undefined)?.type === 'function_call_output');
    expect(output).toBeDefined();
    expect(JSON.parse(((output?.item as { output: string }).output))).toMatchObject({ ok: true });

    expect(rt.lastAuth).toBe('Bearer sk-test');
    expect(rt.lastModel).toBe('gpt-realtime-2.1-mini');
    expect(rt.sessions[0]?.output_modalities).toEqual(['text']);
    expect(rt.sessions[0]?.audio).toBeUndefined();

    const jsonl = join(cwd, 'var/commands.jsonl');
    expect(existsSync(jsonl)).toBe(true);
    expect(readFileSync(jsonl, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('refuses RED-tier proposals and never touches HA', async () => {
    const { deps, ha } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: ARGS_ALARM }] }, { text: 'Refused.' }],
    });
    const rec = await runCommand(deps, { kind: 'text', utterance: 'disarm the alarm' });
    expect(rec.outcome).toBe('refused');
    expect(rec.ok).toBe(false);
    expect(rec.decisions[0]).toMatchObject({ outcome: 'refuse', tier: 'red', reason: 'red_tier' });
    expect(ha.callServiceCalls).toHaveLength(0);
  });

  it('records a text-only reply as no_action', async () => {
    const { deps, ha } = await makeDeps({ responses: [{ text: "I don't know that device." }] });
    const rec = await runCommand(deps, { kind: 'text', utterance: 'engage the flux capacitor' });
    expect(rec.outcome).toBe('no_action');
    expect(rec.ack).toBe("I don't know that device.");
    expect(ha.callServiceCalls).toHaveLength(0);
  });

  it('dry-run resolves fully but never calls HA', async () => {
    const { deps, ha } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: ARGS_KITCHEN }] }, { text: 'Dry.' }],
    });
    const rec = await runCommand(deps, { kind: 'text', utterance: 'turn on the kitchen lights' }, { dryRun: true });
    expect(rec.outcome).toBe('dry_run');
    expect(rec.ok).toBe(true);
    expect(rec.decisions[0]?.entityIds).toHaveLength(3);
    expect(ha.callServiceCalls).toHaveLength(0);
  });

  it('executes multiple function calls in one response sequentially', async () => {
    const argsLiving = JSON.stringify({ action: 'turn_on', domain: 'light', target: 'ceiling', area: 'living room' });
    const { deps, ha } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: ARGS_KITCHEN }, { arguments: argsLiving }] }, { text: 'Both done.' }],
    });
    const rec = await runCommand(deps, { kind: 'text', utterance: 'kitchen and living room lights on' });
    expect(rec.outcome).toBe('executed');
    expect(rec.decisions).toHaveLength(2);
    expect(ha.callServiceCalls).toHaveLength(2);
    expect(rec.ack).toBe('Both done.');
  });

  it('treats unparseable function arguments as a command error but still answers the model', async () => {
    const { deps, ha, rt } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: 'this is not json' }] }, { text: 'Sorry.' }],
    });
    const rec = await runCommand(deps, { kind: 'text', utterance: 'do something odd' });
    expect(rec.outcome).toBe('error');
    expect(rec.error).toContain('bad function arguments');
    expect(ha.callServiceCalls).toHaveLength(0);
    const output = rt.received.find((m) => (m.item as { type?: string } | undefined)?.type === 'function_call_output');
    expect(output).toBeDefined();
  });

  it('fails cleanly when session.update is rejected', async () => {
    const { deps } = await makeDeps({ responses: [], errorOnUpdate: 'bad model' });
    const rec = await runCommand(deps, { kind: 'text', utterance: 'turn on the kitchen lights' });
    expect(rec.outcome).toBe('error');
    expect(rec.error).toContain('bad model');
  });

  it('fails cleanly when the socket drops mid-response', async () => {
    const { deps } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: ARGS_KITCHEN }] }],
      closeAfterArgsDone: true,
    });
    const rec = await runCommand(deps, { kind: 'text', utterance: 'turn on the kitchen lights' });
    expect(rec.outcome).toBe('error');
    expect(rec.error).toMatch(/closed/);
  });
});
