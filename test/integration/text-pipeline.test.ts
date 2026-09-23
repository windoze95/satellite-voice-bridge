import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { HAClient } from '../../src/ha/client.js';
import { FlourishManager } from '../../src/ha/flourish-manager.js';
import { Registry } from '../../src/ha/registry.js';
import { Logger } from '../../src/logger.js';
import { runCommand, type PipelineDeps } from '../../src/pipeline.js';
import { SessionManager } from '../../src/realtime/session.js';
import { MockHAServer } from '../mocks/mock-ha-server.js';
import { MockRealtimeServer, type MockRealtimeOptions } from '../mocks/mock-realtime-server.js';
import { MockResponsesServer } from '../mocks/mock-responses-server.js';

const logger = new Logger({ level: 'error' });

const ARGS_KITCHEN = JSON.stringify({ action: 'turn_on', domain: 'light', target: 'lights', area: 'kitchen' });
const ARGS_ALARM = JSON.stringify({ action: 'disarm', domain: 'alarm_control_panel', target: 'alarm', area: null });
const ARGS_MOVIE_SCENE = JSON.stringify({ action: 'activate', domain: 'scene', target: 'movie time', area: null });

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

/** Captures scheduled flourish restores so tests fire them without wall-clock delay. */
class ManualScheduler {
  readonly scheduled: Array<{ fn: () => void; delayMs: number; cancelled: boolean }> = [];

  readonly schedule = (fn: () => void, delayMs: number): { cancel: () => void } => {
    const entry = { fn, delayMs, cancelled: false };
    this.scheduled.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  };

  get live(): Array<{ fn: () => void; delayMs: number; cancelled: boolean }> {
    return this.scheduled.filter((entry) => !entry.cancelled);
  }

  fireAll(): void {
    for (const entry of this.live) entry.fn();
  }
}

async function makeDeps(
  rtOpts: MockRealtimeOptions,
  opts: { delegate?: string } = {},
): Promise<{ deps: PipelineDeps; ha: MockHAServer; rt: MockRealtimeServer; cwd: string; scheduler: ManualScheduler }> {
  const cwd = mkdtempSync(join(tmpdir(), 'vb-e2e-'));
  const ha = await MockHAServer.start();
  const rt = await MockRealtimeServer.start(rtOpts);
  const cfg = loadConfig(
    {
      OPENAI_API_KEY: 'sk-test',
      HA_URL: ha.url,
      HA_TOKEN: 'test-token',
      VOICEBRIDGE_REALTIME_URL: rt.url,
      ...(opts.delegate ? { VOICEBRIDGE_RESPONSES_URL: opts.delegate } : {}),
    },
    cwd,
  );
  // Delegation is opt-in per test: most of these exercise the fast path, and a
  // stray escalation would quietly turn a refusal assertion green.
  cfg.delegate.enabled = opts.delegate !== undefined;
  // Exercise the optional logged acknowledgement path even though the no-speaker
  // production default is false.
  cfg.session.ackResponse = true;
  const registry = new Registry(logger, { voiceDomains: ['light', 'fan', 'switch', 'media_player', 'scene', 'script', 'lock', 'cover', 'climate'] });
  const haClient = new HAClient({ url: ha.url, token: 'test-token', logger, retry: false, onSync: (c) => registry.sync(c) });
  registry.attach(haClient);
  const sessions = new SessionManager({
    mode: 'per_utterance',
    url: rt.url,
    apiKey: 'sk-test',
    model: cfg.session.model,
    transcribe: false,
    delegate: false,
    logger,
  });
  cleanups.push(async () => {
    sessions.close();
    haClient.stop();
    await rt.close();
    await ha.close();
  });
  const scheduler = new ManualScheduler();
  const flourish = new FlourishManager({ haClient, logger, schedule: scheduler.schedule });
  await haClient.start();
  return { deps: { cfg, logger, haClient, registry, sessions, flourish }, ha, rt, cwd, scheduler };
}

/** Give fixture lights real capabilities; they advertise none by default. */
function setCapabilities(deps: PipelineDeps, capabilities: Record<string, Record<string, unknown>>): void {
  for (const [entityId, attributes] of Object.entries(capabilities)) {
    const state = deps.registry.cache?.statesById.get(entityId);
    if (!state) throw new Error(`fixture is missing ${entityId}`);
    deps.registry.cache?.statesById.set(entityId, {
      ...state,
      attributes: { ...state.attributes, ...attributes },
    });
  }
}

const KITCHEN_CAPABLE = {
  'light.kitchen_ceiling': { supported_color_modes: ['color_temp'], min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 },
  'light.kitchen_island': { supported_color_modes: ['xy'] },
  'light.kitchen_sink': { supported_color_modes: ['brightness'] },
};

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
    expect(rt.lastModel).toBe('gpt-realtime-2.1');
    expect(rt.sessions[0]?.output_modalities).toEqual(['text']);
    expect(rt.sessions[0]?.max_output_tokens).toBe(1200);
    expect(rt.sessions[0]?.audio).toBeUndefined();
    expect(
      rt.received.some(
        (message) =>
          message.type === 'response.create' &&
          (message.response as { tool_choice?: string } | undefined)?.tool_choice === 'none',
      ),
    ).toBe(true);

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

  it('renders a named mood locally, giving each light a part rather than asking the model for colors', async () => {
    const mood = JSON.stringify({
      action: 'turn_on',
      domain: 'light',
      target: 'lights',
      area: 'Kitchen',
      light: { mood: 'intimate' },
      tone: 'intimate',
    });
    const { deps, ha } = await makeDeps({ responses: [{ functionCalls: [{ arguments: mood }] }, { text: 'Done.' }] });
    setCapabilities(deps, KITCHEN_CAPABLE);

    const rec = await runCommand(deps, { kind: 'text', utterance: 'set the mood in the kitchen' });

    expect(rec.outcome).toBe('executed');
    expect(rec.tone).toBe('intimate');
    // One model call became several service calls, each carrying real settings —
    // no follow-up round trip, and nothing for the model to get wrong per bulb.
    expect(ha.callServiceCalls.length).toBeGreaterThan(0);
    for (const call of ha.callServiceCalls) {
      expect(call.domain).toBe('light');
      const data = call.service_data as Record<string, unknown>;
      if (call.service === 'turn_on') {
        expect('rgb_color' in data || 'color_temp_kelvin' in data || 'brightness_pct' in data).toBe(true);
      }
    }
    const touched = new Set(rec.decisions.flatMap((decision) => decision.entityIds));
    expect(touched.size).toBeGreaterThan(1);
  });

  it('records a dismissal without touching Home Assistant', async () => {
    const { deps, ha, rt } = await makeDeps({
      responses: [{ functionCalls: [{ name: 'dismiss', arguments: JSON.stringify({ reason: 'background_speech', tone: 'playful', note: 'two people talking' }) }] }],
    });

    const rec = await runCommand(deps, { kind: 'text', utterance: 'Excited and nervous, yeah.' });

    expect(rec.outcome).toBe('no_action');
    expect(rec.ok).toBe(true);
    expect(rec.dismissed).toEqual({ reason: 'background_speech', note: 'two people talking' });
    expect(rec.tone).toBe('playful');
    expect(ha.callServiceCalls).toHaveLength(0);
    // The model still gets its tool result, so a follow-up turn sees a coherent
    // conversation rather than a dangling call.
    const output = rt.received.find((m) => (m.item as { type?: string } | undefined)?.type === 'function_call_output');
    expect(output).toBeDefined();
  });

  it('hands a delegated request to the strong model and authorizes what comes back', async () => {
    const planned = JSON.stringify({
      action: 'turn_on',
      domain: 'light',
      target: 'lights',
      area: 'Kitchen',
      light: { brightness_pct: 40, color_temp_kelvin: 2700 },
    });
    const responses = await MockResponsesServer.start({
      calls: [{ name: 'control_device', arguments: planned }],
    });
    const { deps, ha } = await makeDeps({
      responses: [{ functionCalls: [{ name: 'delegate', arguments: JSON.stringify({ request: 'something warm but readable', why: 'competing goals', tone: 'tired' }) }] }],
    }, { delegate: responses.url });

    setCapabilities(deps, KITCHEN_CAPABLE);

    const rec = await runCommand(deps, { kind: 'text', utterance: 'something cozy but I still need to read' });

    expect(rec.outcome).toBe('executed');
    expect(rec.delegated?.model).toBeDefined();
    expect(rec.delegated?.why).toBe('competing goals');
    expect(rec.d.delegate).toBeGreaterThanOrEqual(0);
    expect(ha.callServiceCalls).toHaveLength(1);
    // Delegation buys a better plan, not wider authority.
    expect(rec.decisions[0]).toMatchObject({ outcome: 'execute', tier: 'green' });
    await responses.close();
  });

  it('escalates a near-miss refusal to the strong model instead of re-asking the fast one', async () => {
    const vague = JSON.stringify({ action: 'turn_on', domain: 'light', target: 'the thing over there', area: 'Kitchen' });
    const planned = JSON.stringify({ action: 'turn_on', domain: 'light', target: 'Kitchen Island', area: 'Kitchen' });
    const responses = await MockResponsesServer.start({ calls: [{ name: 'control_device', arguments: planned }] });
    const { deps, ha } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: vague }] }],
    }, { delegate: responses.url });

    const rec = await runCommand(deps, { kind: 'text', utterance: 'turn on the thing over there' });

    expect(rec.decisions[0]).toMatchObject({ outcome: 'refuse', reason: 'no_confident_match' });
    expect(rec.outcome).toBe('executed');
    expect(rec.delegated).toBeDefined();
    expect(ha.callServiceCalls).toHaveLength(1);
    await responses.close();
  });

  it('refuses rather than escalating when the refusal was a decision, not a near miss', async () => {
    const responses = await MockResponsesServer.start({ calls: [] });
    const { deps, ha } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: ARGS_ALARM }] }],
    }, { delegate: responses.url });

    const rec = await runCommand(deps, { kind: 'text', utterance: 'disarm the alarm' });

    expect(rec.outcome).toBe('refused');
    expect(rec.decisions[0]).toMatchObject({ reason: 'red_tier' });
    // A red-tier refusal must never be shopped to a second model.
    expect(rec.delegated).toBeUndefined();
    expect(responses.requests).toHaveLength(0);
    expect(ha.callServiceCalls).toHaveLength(0);
    await responses.close();
  });

  it('preserves an explicitly named advertised scene even when the phrase also contains a mood word', async () => {
    const { deps, ha } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: ARGS_MOVIE_SCENE }] }, { text: 'Done.' }],
    });

    const rec = await runCommand(deps, {
      kind: 'text',
      utterance: 'party time: activate the Movie Time scene',
    });

    expect(rec.outcome).toBe('executed');
    expect(rec.decisions[0]).toMatchObject({ outcome: 'execute', entityIds: ['scene.movie_time'] });
    expect(ha.callServiceCalls).toHaveLength(1);
  });

  it.each(["don't turn on the kitchen lights", 'do not turn on the kitchen lights', 'should I turn on the kitchen lights?'])(
    'does not force a tool for negated or informational wording: %s',
    async (utterance) => {
      const { deps, ha, rt } = await makeDeps({
        responses: [{ functionCalls: [{ arguments: ARGS_KITCHEN }] }, { text: 'No action taken.' }],
      });

      const rec = await runCommand(deps, { kind: 'text', utterance });

      expect(rec.outcome).toBe('refused');
      expect(rec.decisions[0]).toMatchObject({ outcome: 'refuse', reason: 'not_an_action' });
      expect(ha.callServiceCalls).toHaveLength(0);
      expect(
        rt.received.some(
          (message) =>
            message.type === 'response.create' &&
            (message.response as { tool_choice?: string } | undefined)?.tool_choice === 'required',
        ),
      ).toBe(false);
    },
  );

  // Real transcripts from false wakes on the living-room satellite, each of
  // which executed a turn_on of five lights before this guard existed.
  it.each([
    'Excited and nervous, yeah.',
    'ChatGPT',
    "I'm great!",
    'Good morning.',
    'Shut up!',
    'Hey!',
    '', // transcription ran and heard nothing intelligible
  ])('takes no action when the model dismisses ordinary speech: %j', async (transcript) => {
    const { deps, ha } = await makeDeps({
      responses: [{ functionCalls: [{ name: 'dismiss', arguments: JSON.stringify({ reason: 'background_speech', tone: 'neutral' }) }] }],
    });

    const rec = await runCommand(deps, { kind: 'text', utterance: transcript });

    expect(rec.outcome).toBe('no_action');
    expect(rec.dismissed?.reason).toBe('background_speech');
    expect(ha.callServiceCalls).toHaveLength(0);
  });

  it('acts on a command whose verb no vocabulary list would have contained', async () => {
    const toggle = JSON.stringify({ action: 'toggle', domain: 'light', target: 'lights', area: 'Kitchen', tone: 'playful' });
    const { deps, ha } = await makeDeps({ responses: [{ functionCalls: [{ arguments: toggle }] }, { text: 'Done.' }] });

    // "hit" was never in CHANGE_WORDS, and under the old gate that silence was
    // indistinguishable from a non-command.
    const rec = await runCommand(deps, { kind: 'text', utterance: 'hit the lights' });

    expect(rec.outcome).toBe('executed');
    expect(rec.tone).toBe('playful');
    expect(ha.callServiceCalls).toHaveLength(1);
  });

  it.each([
    'turn on the kitchen lights',
    'all of the lights',
    'switch on the kitchen lights',
    'kitchen', // an area alone still reaches the policy engine
  ])('still lets a real command through: %j', async (utterance) => {
    const { deps, ha } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: ARGS_KITCHEN }] }, { text: 'Done.' }],
    });

    const rec = await runCommand(deps, { kind: 'text', utterance });

    expect(rec.outcome).toBe('executed');
    expect(ha.callServiceCalls).toHaveLength(1);
  });

  it('still lets an appearance word through to the policy engine', async () => {
    const brighter = JSON.stringify({
      action: 'turn_on',
      domain: 'light',
      target: 'lights',
      area: 'kitchen',
      light: { brightness_step_pct: 25 },
    });
    const { deps, ha } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: brighter }] }, { text: 'Done.' }],
    });
    for (const id of ['light.kitchen_ceiling', 'light.kitchen_island', 'light.kitchen_sink']) {
      const state = deps.registry.cache?.statesById.get(id);
      if (!state) throw new Error(`fixture is missing ${id}`);
      deps.registry.cache?.statesById.set(id, {
        ...state,
        attributes: { ...state.attributes, supported_color_modes: ['brightness'] },
      });
    }

    const rec = await runCommand(deps, { kind: 'text', utterance: 'make the kitchen brighter' });

    expect(rec.outcome).toBe('executed');
    expect(ha.callServiceCalls).toHaveLength(1);
  });

  it('allows a polite directive phrased as a question', async () => {
    const { deps, ha } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: ARGS_KITCHEN }] }, { text: 'Done.' }],
    });

    const rec = await runCommand(deps, { kind: 'text', utterance: 'could you turn on the kitchen lights?' });

    expect(rec.outcome).toBe('executed');
    expect(ha.callServiceCalls).toHaveLength(1);
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

  it('passes capability-checked light appearance data through to Home Assistant and telemetry', async () => {
    const argumentsJson = JSON.stringify({
      action: 'turn_on',
      domain: 'light',
      target: 'lights',
      area: 'kitchen',
      value: null,
      light: {
        brightness_pct: 35,
        rgb_color: null,
        color_temp_kelvin: 2700,
        effect: null,
        mood: null,
        transition_seconds: 3,
        flash: null,
      },
    });
    const { deps, ha } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: argumentsJson }] }, { text: 'Done.' }],
    });
    for (const id of ['light.kitchen_ceiling', 'light.kitchen_island', 'light.kitchen_sink']) {
      const state = deps.registry.cache?.statesById.get(id);
      if (!state) throw new Error(`fixture is missing ${id}`);
      deps.registry.cache?.statesById.set(id, {
        ...state,
        attributes: {
          ...state.attributes,
          supported_color_modes: ['color_temp', 'xy'],
          min_color_temp_kelvin: 2000,
          max_color_temp_kelvin: 6500,
          supported_features: 32,
        },
      });
    }

    const rec = await runCommand(deps, {
      kind: 'text',
      utterance: 'make the kitchen warm white at 35 percent over 3 seconds',
    });

    expect(rec.outcome).toBe('executed');
    expect(rec.decisions[0]?.serviceData).toEqual({
      brightness_pct: 35,
      color_temp_kelvin: 2700,
      transition: 3,
    });
    expect(ha.callServiceCalls[0]).toMatchObject({
      domain: 'light',
      service: 'turn_on',
      service_data: { brightness_pct: 35, color_temp_kelvin: 2700, transition: 3 },
    });
  });

  it('executes a plain bare turn_on in one round trip', async () => {
    const bare = JSON.stringify({ action: 'turn_on', domain: 'light', target: 'lights', area: 'Living Room', light: null });
    const { deps, ha, rt } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: bare }] }, { text: 'Done.' }],
    });

    const rec = await runCommand(deps, { kind: 'text', utterance: 'turn the living room lights back on' });

    expect(rec.outcome).toBe('executed');
    expect(rec.decisions).toHaveLength(1);
    expect(ha.callServiceCalls).toHaveLength(1);
    // Exactly one response.create beyond the acknowledgement: no retry, no
    // correction, nothing for a simple command to pay for.
    expect(rt.received.filter((message) => message.type === 'response.create')).toHaveLength(2);
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

  it('never executes a function call emitted during the optional acknowledgement', async () => {
    const { deps, ha } = await makeDeps({
      responses: [
        { functionCalls: [{ arguments: ARGS_KITCHEN }] },
        { functionCalls: [{ arguments: ARGS_KITCHEN }] },
      ],
    });

    const rec = await runCommand(deps, { kind: 'text', utterance: 'turn on the kitchen lights' });

    expect(rec.outcome).toBe('executed');
    expect(rec.function_calls).toHaveLength(1);
    expect(ha.callServiceCalls).toHaveLength(1);
  });

  it('treats unparseable function arguments as a command error but still answers the model', async () => {
    const { deps, ha, rt } = await makeDeps({
      responses: [{ functionCalls: [{ arguments: 'this is not json' }] }, { text: 'Sorry.' }],
    });
    // Must read as a device command, or the not-a-command guard refuses it
    // before the arguments are ever parsed.
    const rec = await runCommand(deps, { kind: 'text', utterance: 'turn on the kitchen lights' });
    expect(rec.outcome).toBe('error');
    expect(rec.error).toContain('bad function arguments');
    expect(ha.callServiceCalls).toHaveLength(0);
    const output = rt.received.find((m) => (m.item as { type?: string } | undefined)?.type === 'function_call_output');
    expect(output).toBeDefined();
  });

  it('executes a valid corrected call after a malformed call in the same response', async () => {
    const { deps, ha } = await makeDeps({
      responses: [
        { functionCalls: [{ arguments: '{"action":"turn_on","domain' }, { arguments: ARGS_KITCHEN }] },
        { text: 'Done.' },
      ],
    });

    const rec = await runCommand(deps, { kind: 'text', utterance: 'turn on the kitchen lights' });

    expect(rec.outcome).toBe('executed');
    expect(rec.error).toBeUndefined();
    expect(rec.function_calls).toHaveLength(2);
    expect(rec.decisions).toHaveLength(2);
    expect(rec.decisions[0]).toMatchObject({ outcome: 'refuse', reason: 'bad_arguments' });
    expect(rec.decisions[1]).toMatchObject({ outcome: 'execute', service: 'turn_on', verified: true });
    expect(ha.callServiceCalls).toHaveLength(1);
  });

  describe('flourishes', () => {
    const RAINBOW = {
      phrases: ['super gay', 'super gay and horny'],
      durationMs: 12_000,
      light: {
        brightness_pct: 100,
        brightness_step_pct: null,
        rgb_color: null,
        color_temp_kelvin: null,
        effect: 'prism',
        mood: null,
        transition_seconds: null,
        flash: null,
      },
      rotation: null,
    };

    /** The live easter egg: a colour walk around the room, not a bulb effect. */
    const RAINBOW_ROTATION = {
      phrases: ['super gay', 'super gay and horny'],
      durationMs: 5_000,
      light: {
        brightness_pct: 100,
        brightness_step_pct: null,
        rgb_color: [255, 0, 0] as [number, number, number],
        color_temp_kelvin: null,
        effect: null,
        mood: null,
        transition_seconds: null,
        flash: null,
      },
      rotation: {
        colors: [
          [255, 0, 0],
          [255, 120, 0],
          [255, 240, 0],
          [0, 255, 60],
          [0, 140, 255],
          [190, 0, 255],
        ] as Array<[number, number, number]>,
        intervalMs: 450,
        transitionSeconds: 0,
        brightnessPct: 100,
      },
    };

    /** Give the kitchen lights Hue-like effect support and a known current look. */
    function makeKitchenEffectCapable(deps: PipelineDeps): void {
      for (const id of ['light.kitchen_ceiling', 'light.kitchen_island', 'light.kitchen_sink']) {
        const state = deps.registry.cache?.statesById.get(id);
        if (!state) throw new Error(`fixture is missing ${id}`);
        deps.registry.cache?.statesById.set(id, {
          ...state,
          state: 'on',
          attributes: {
            ...state.attributes,
            color_mode: 'color_temp',
            brightness: 140,
            color_temp_kelvin: 2700,
            supported_color_modes: ['color_temp', 'xy'],
            supported_features: 44,
            effect_list: ['off', 'candle', 'prism'],
            effect: 'off',
          },
        });
      }
    }

    it('runs a typed flourish without opening a Realtime session at all', async () => {
      const { deps, ha, rt, scheduler } = await makeDeps({ responses: [] });
      deps.cfg.flourishes = [RAINBOW];
      makeKitchenEffectCapable(deps);

      const rec = await runCommand(deps, { kind: 'text', utterance: 'make it super gay in the kitchen' });

      expect(rec.outcome).toBe('executed');
      expect(rec.decisions[0]).toMatchObject({ outcome: 'execute', service: 'turn_on' });
      expect(rec.decisions[0]?.serviceData).toEqual({ brightness_pct: 100, effect: 'prism' });
      expect(ha.callServiceCalls).toHaveLength(1);
      // No model round trip: no session, no tokens, no cost.
      expect(rt.sessions).toHaveLength(0);
      expect(rec.usage.inputTextTokens).toBe(0);
      expect(scheduler.live[0]?.delayMs).toBe(12_000);
    });

    it('puts the lights back exactly as they were when the restore fires', async () => {
      const { deps, ha, scheduler } = await makeDeps({ responses: [] });
      deps.cfg.flourishes = [RAINBOW];
      makeKitchenEffectCapable(deps);

      await runCommand(deps, { kind: 'text', utterance: 'make it super gay in the kitchen' });
      expect(ha.callServiceCalls).toHaveLength(1);

      scheduler.live[0]!.fn();
      await vi.waitFor(() => expect(ha.callServiceCalls.length).toBeGreaterThanOrEqual(3));

      const restores = ha.callServiceCalls.slice(1);
      expect(restores[0]).toMatchObject({ domain: 'light', service: 'turn_on', service_data: { effect: 'off' } });
      expect(restores[1]).toMatchObject({
        domain: 'light',
        service: 'turn_on',
        service_data: { brightness: 140, color_temp_kelvin: 2700 },
      });
    });

    it('takes over a spoken command even when the model refuses to call the tool', async () => {
      const { deps, ha, scheduler } = await makeDeps({
        responses: [{ text: "I can't help with that." }],
      });
      deps.cfg.flourishes = [RAINBOW];
      makeKitchenEffectCapable(deps);

      const rec = await runCommand(deps, {
        kind: 'text',
        utterance: 'make it super gay and horny in the kitchen',
      });

      expect(rec.outcome).toBe('executed');
      expect(ha.callServiceCalls).toHaveLength(1);
      expect(scheduler.live).toHaveLength(1);
    });

    it('records the flourish outcome even when the model is forced into a tool call meanwhile', async () => {
      // Regression: the model answered with text, the retry forced a
      // control_device call, and its response.done completed the command while
      // the flourish was still awaiting HA — the record landed as `error` with
      // no decisions even though the lights had fired.
      const { deps, ha, scheduler } = await makeDeps({
        responses: [
          { text: "I can't help with that." },
          { functionCalls: [{ arguments: ARGS_KITCHEN }] },
          { text: 'Done.' },
        ],
      });
      deps.cfg.flourishes = [RAINBOW];
      makeKitchenEffectCapable(deps);

      const rec = await runCommand(deps, {
        kind: 'text',
        utterance: 'make it super gay and horny in the kitchen',
      });

      expect(rec.outcome).toBe('executed');
      expect(rec.error).toBeUndefined();
      expect(rec.decisions).toHaveLength(1);
      expect(rec.decisions[0]).toMatchObject({ outcome: 'execute', service: 'turn_on' });
      // Only the flourish touched HA; the model's forced call was ignored.
      expect(ha.callServiceCalls).toHaveLength(1);
      expect(scheduler.live).toHaveLength(1);
    });

    it('is unaffected by the not-a-command guard, even with no model call at all', async () => {
      // The flourish is matched on the transcript and short-circuits before the
      // model path, so the guard that refuses non-commands can never reach it.
      const { deps, ha, rt, scheduler } = await makeDeps({ responses: [] });
      deps.cfg.flourishes = [RAINBOW];
      makeKitchenEffectCapable(deps);

      const rec = await runCommand(deps, { kind: 'text', utterance: 'super gay in the kitchen' });

      expect(rec.outcome).toBe('executed');
      expect(rec.decisions[0]).toMatchObject({ outcome: 'execute', service: 'turn_on' });
      expect(ha.callServiceCalls).toHaveLength(1);
      expect(rt.sessions).toHaveLength(0); // never even opened a session
      expect(scheduler.live).toHaveLength(1);
    });

    it('cancels a pending restore when a later command claims the same lights', async () => {
      const { deps, ha, scheduler } = await makeDeps({
        responses: [{ functionCalls: [{ arguments: ARGS_KITCHEN }] }, { text: 'Done.' }],
      });
      deps.cfg.flourishes = [RAINBOW];
      makeKitchenEffectCapable(deps);

      await runCommand(deps, { kind: 'text', utterance: 'make it super gay in the kitchen' });
      expect(scheduler.live).toHaveLength(1);

      const rec = await runCommand(deps, { kind: 'text', utterance: 'turn on the kitchen lights' });

      expect(rec.outcome).toBe('executed');
      expect(scheduler.live).toHaveLength(0);
      expect(ha.callServiceCalls).toHaveLength(2); // flourish + the new command, no restore
    });

    it('refuses a flourish it cannot pin to an area rather than lighting the whole house', async () => {
      const { deps, ha } = await makeDeps({ responses: [] });
      deps.cfg.flourishes = [RAINBOW];
      makeKitchenEffectCapable(deps);

      const rec = await runCommand(deps, { kind: 'text', utterance: 'make it super gay' });

      expect(rec.outcome).toBe('refused');
      expect(rec.decisions[0]).toMatchObject({ reason: 'no_area_for_flourish' });
      expect(ha.callServiceCalls).toHaveLength(0);
    });

    it.each([
      'super gay and horny',
      'hey can you make it super gay and horny in here please',
      'kitchen lights super gay and horny now',
      'SUPER GAY AND HORNY!',
    ])('fires the rainbow easter egg wherever the phrase sits in the utterance: %j', async (utterance) => {
      const { deps, ha } = await makeDeps({ responses: [] });
      deps.cfg.flourishes = [RAINBOW_ROTATION];
      makeKitchenEffectCapable(deps);

      const rec = await runCommand(deps, { kind: 'text', utterance, originArea: 'Kitchen' });

      // Never reaches the model: no session is opened, so no tool choice, no
      // dismissal, and nothing to refuse or reinterpret.
      expect(rec.outcome).toBe('executed');
      expect(rec.function_calls).toHaveLength(0);
      expect(ha.callServiceCalls[0]).toMatchObject({
        domain: 'light',
        service: 'turn_on',
        service_data: { rgb_color: [255, 0, 0], brightness_pct: 100 },
      });
      // And it holds a restore, so the room goes back to exactly what it was.
      expect(deps.flourish.pendingCount).toBeGreaterThan(0);
      deps.flourish.stop();
    });

    it('still fires the easter egg when the model tries to dismiss the utterance', async () => {
      const { deps, ha } = await makeDeps({
        responses: [
          { functionCalls: [{ name: 'dismiss', arguments: JSON.stringify({ reason: 'not_about_the_house', tone: 'playful' }) }] },
        ],
        transcript: 'make it super gay and horny',
      });
      deps.cfg.flourishes = [RAINBOW_ROTATION];
      makeKitchenEffectCapable(deps);

      // A spoken one goes through the session for transcription, and the
      // transcript match has to beat whatever the model decided.
      const rec = await runCommand(deps, { kind: 'text', utterance: 'make it super gay and horny', originArea: 'Kitchen' });

      expect(rec.outcome).toBe('executed');
      expect(rec.dismissed).toBeUndefined();
      expect(ha.callServiceCalls).toHaveLength(1);
      deps.flourish.stop();
    });

    it('prefers the longest matching easter-egg phrase', async () => {
      const { deps, ha } = await makeDeps({ responses: [] });
      deps.cfg.flourishes = [
        { ...RAINBOW, phrases: ['super gay'] },
        RAINBOW_ROTATION,
      ];
      makeKitchenEffectCapable(deps);

      const rec = await runCommand(deps, { kind: 'text', utterance: 'make it super gay and horny', originArea: 'Kitchen' });

      expect(rec.outcome).toBe('executed');
      // "super gay and horny" beats the shorter "super gay", so the rotation
      // runs rather than the plain held effect.
      expect(ha.callServiceCalls[0]?.service_data).toMatchObject({ rgb_color: [255, 0, 0] });
      deps.flourish.stop();
    });

    it('leaves ordinary commands on the model path', async () => {
      const { deps, rt } = await makeDeps({
        responses: [{ functionCalls: [{ arguments: ARGS_KITCHEN }] }, { text: 'Done.' }],
      });
      deps.cfg.flourishes = [RAINBOW];

      const rec = await runCommand(deps, { kind: 'text', utterance: 'turn on the kitchen lights' });

      expect(rec.outcome).toBe('executed');
      expect(rt.sessions).toHaveLength(1);
    });
  });

  it('fails cleanly when session.update is rejected', async () => {
    const { deps } = await makeDeps({ responses: [], errorOnUpdate: 'bad model' });
    const rec = await runCommand(deps, { kind: 'text', utterance: 'turn on the kitchen lights' });
    expect(rec.outcome).toBe('error');
    expect(rec.error).toContain('bad model');
  });

  it('treats a failed model response as an error rather than a successful no_action', async () => {
    const { deps, ha } = await makeDeps({ responses: [{ status: 'failed' }] });

    const rec = await runCommand(deps, { kind: 'text', utterance: 'turn on the kitchen lights' });

    expect(rec.outcome).toBe('error');
    expect(rec.error).toBe('realtime response failed');
    expect(ha.callServiceCalls).toHaveLength(0);
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
