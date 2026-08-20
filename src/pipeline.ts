// Orchestrator: one spoken/typed command through Realtime → policy → HA,
// with T0–T8 telemetry. Everything meets here.
import type { AudioSource } from './audio/source.js';
import type { Config } from './config.js';
import { buildInstructions } from './context/house-context.js';
import type { HAClient } from './ha/client.js';
import { executeAction } from './ha/executor.js';
import { displayName, type Registry } from './ha/registry.js';
import type { Logger } from './logger.js';
import type { RealtimeClient } from './realtime/client.js';
import {
  usageFromRaw,
  type FunctionCallArgumentsDone,
  type OutputTextDelta,
  type ResponseDone,
  type ServerEvent,
  type TranscriptionCompleted,
} from './realtime/events.js';
import type { SessionManager } from './realtime/session.js';
import { CONTROL_DEVICE_TOOL, parseControlDeviceArgs } from './realtime/tools.js';
import { decide } from './policy/engine.js';
import { normalize } from './policy/resolve.js';
import { appendRecord, CommandTrace, type CommandRecord } from './telemetry.js';

export interface PipelineDeps {
  cfg: Config;
  logger: Logger;
  haClient: HAClient;
  registry: Registry;
  sessions: SessionManager;
}

export type CommandInput = { kind: 'text'; utterance: string } | { kind: 'audio'; source: AudioSource };

const COMMAND_TIMEOUT_MS = 30_000;
const NO_SPEECH_GRACE_MS = 5_000;
const TRANSCRIPT_GRACE_MS = 750;
const CHANGE_WORDS = new Set([
  'activate',
  'blink',
  'brighten',
  'brighter',
  'close',
  'darken',
  'darker',
  'dim',
  'dimmer',
  'flash',
  'lock',
  'make',
  'open',
  'pause',
  'play',
  'set',
  'start',
  'stop',
  'switch',
  'toggle',
  'turn',
  'unlock',
]);
const IMPLIED_LIGHT_CHANGE_WORDS = new Set([
  'clinical',
  'cozy',
  'erotic',
  'erotica',
  'gay',
  'horny',
  'party',
  'romantic',
  'sensual',
  'sexy',
  'sterile',
  'sterilite',
  'sterilites',
  'sterilights',
]);
const DEVICE_WORDS = new Set([
  'blind',
  'blinds',
  'bulb',
  'bulbs',
  'cover',
  'covers',
  'fan',
  'fans',
  'lamp',
  'lamps',
  'light',
  'lights',
  'lock',
  'locks',
  'scene',
  'script',
  'shade',
  'shades',
  'switch',
  'switches',
  'thermostat',
  'tv',
]);
const NEGATION_WORDS = new Set(['dont', 'never']);
const INFORMATION_QUESTION_PREFIXES = [
  'am i ',
  'are the ',
  'can i ',
  'did i ',
  'do i ',
  'do the ',
  'does ',
  'how ',
  'is it ',
  'may i ',
  'should i ',
  'what ',
  'when ',
  'where ',
  'which ',
  'why ',
  'would it ',
];

function containsPhrase(text: string, phrase: string): boolean {
  const wanted = normalize(phrase);
  return wanted.length > 0 && (` ${text} `.includes(` ${wanted} `) || text === wanted);
}

function blocksDeviceAction(utterance: string): boolean {
  const text = normalize(utterance);
  if (!text) return false;
  const words = new Set(text.split(' '));
  if ([...NEGATION_WORDS].some((word) => words.has(word))) return true;
  if (` ${text} `.includes(' do not ') || text.startsWith('please not ')) return true;
  if (['can you not ', 'could you not ', 'will you not ', 'would you not '].some((prefix) => text.startsWith(prefix))) return true;
  if (INFORMATION_QUESTION_PREFIXES.some((prefix) => text.startsWith(prefix))) return true;
  return (
    utterance.trim().endsWith('?') &&
    !['can you ', 'could you ', 'will you ', 'would you '].some((prefix) => text.startsWith(prefix))
  );
}

function hasImpliedLightingMood(utterance: string): boolean {
  const words = new Set(normalize(utterance).split(' '));
  return [...IMPLIED_LIGHT_CHANGE_WORDS].some((word) => words.has(word));
}

function hasExplicitOffIntent(utterance: string): boolean {
  const text = ` ${normalize(utterance)} `;
  return text.includes(' turn off ') || text.includes(' switch off ') || text.trimStart().startsWith('stop ');
}

function explicitlyRequestsScene(utterance: string, target: string): boolean {
  const text = normalize(utterance);
  return new Set(text.split(' ')).has('scene') && containsPhrase(text, target);
}

function areaForUtterance(
  utterance: string,
  cache: NonNullable<Registry['cache']>,
  policyCfg: Config['policy'],
  originArea?: string,
): string | undefined {
  const text = normalize(utterance);
  const candidates: Array<{ phrase: string; value: string }> = [];
  for (const area of cache.areasById.values()) {
    candidates.push({ phrase: area.name, value: area.name });
    for (const alias of area.aliases ?? []) candidates.push({ phrase: alias, value: area.name });
  }
  for (const [alias, areaNames] of Object.entries(policyCfg.areaAliases)) {
    candidates.push({ phrase: alias, value: areaNames.length === 1 ? areaNames[0]! : alias });
  }
  candidates.sort((a, b) => normalize(b.phrase).length - normalize(a.phrase).length);
  return candidates.find((candidate) => containsPhrase(text, candidate.phrase))?.value ?? originArea;
}

function lightMoodCorrectionTool(area: string): unknown {
  const properties = CONTROL_DEVICE_TOOL.parameters.properties;
  return {
    ...CONTROL_DEVICE_TOOL,
    description:
      'Apply the user-requested visual mood to the area lights. Choose supported appearance settings from HOUSE.',
    parameters: {
      ...CONTROL_DEVICE_TOOL.parameters,
      properties: {
        ...properties,
        action: { type: 'string', enum: ['turn_on'] },
        domain: { type: 'string', enum: ['light'] },
        target: { type: 'string', enum: ['lights'] },
        light: {
          ...properties.light,
          type: 'object',
          description: 'Required visual appearance chosen from the advertised HOUSE capabilities.',
          anyOf: [
            { required: ['brightness_pct'], properties: { brightness_pct: { type: 'number', minimum: 0, maximum: 100 } } },
            {
              required: ['rgb_color'],
              properties: {
                rgb_color: {
                  type: 'array',
                  items: { type: 'integer', minimum: 0, maximum: 255 },
                  minItems: 3,
                  maxItems: 3,
                },
              },
            },
            { required: ['color_temp_kelvin'], properties: { color_temp_kelvin: { type: 'number', minimum: 1 } } },
            { required: ['effect'], properties: { effect: { type: 'string' } } },
          ],
        },
        area: { type: 'string', enum: [area] },
      },
      required: [...CONTROL_DEVICE_TOOL.parameters.required, 'area', 'light'],
    },
  };
}

function shouldRetryWithRequiredTool(
  utterance: string,
  cache: NonNullable<Registry['cache']>,
  policyCfg: Config['policy'],
  originArea?: string,
): boolean {
  const text = normalize(utterance);
  if (!text) return false;
  if (blocksDeviceAction(utterance)) return false;
  const words = new Set(text.split(' '));
  const hasChange = [...CHANGE_WORDS].some((word) => words.has(word));
  const hasImpliedLightChange = hasImpliedLightingMood(utterance);
  if (!hasChange && !hasImpliedLightChange) return false;
  if ([...DEVICE_WORDS].some((word) => words.has(word))) return true;
  if (hasImpliedLightChange && originArea) return true;

  const areaPhrases = [
    ...[...cache.areasById.values()].flatMap((area) => [area.name, ...(area.aliases ?? [])]),
    ...Object.keys(policyCfg.areaAliases),
  ];
  if (areaPhrases.some((phrase) => containsPhrase(text, phrase))) return true;

  for (const entityId of cache.entitiesById.keys()) {
    if (containsPhrase(text, displayName(cache, entityId))) return true;
  }
  return false;
}

export async function runCommand(deps: PipelineDeps, input: CommandInput, opts: { dryRun?: boolean } = {}): Promise<CommandRecord> {
  const { cfg, logger } = deps;
  const source = input.kind === 'audio' ? input.source : null;
  const trace = new CommandTrace(input.kind === 'text' ? 'text' : source!.kind, cfg.session.model, cfg.session.mode);
  if (input.kind === 'text') trace.utterance = input.utterance;
  trace.mark('t0');

  const policyCfg = opts.dryRun ? { ...cfg.policy, dryRun: true } : cfg.policy;

  const finishRecord = (): CommandRecord => {
    // Also covers failures before a Realtime session is acquired (HA down,
    // authentication failure, etc.). Satellite microphones must never be left
    // streaming merely because the command exited early.
    source?.stop();
    const rec = trace.finish();
    appendRecord(cfg.telemetry.jsonlPath, rec);
    logger.info('command finished', { cmd_id: rec.cmd_id, outcome: rec.outcome, error: rec.error, d: rec.d as unknown });
    return rec;
  };

  const cache = deps.registry.cache;
  if (!cache || deps.haClient.state !== 'ready') {
    trace.error = 'Home Assistant is not connected';
    return finishRecord();
  }

  const originArea = source ? cfg.satellites[source.id]?.area : undefined;
  const baseInstructions = buildInstructions(cache, policyCfg);
  const instructions = originArea
    ? `${baseInstructions}\n\nThe device that heard this command is in: ${originArea}. When no area is stated, prefer devices there.`
    : baseInstructions;

  let client: RealtimeClient;
  try {
    ({ client } = await deps.sessions.acquire(instructions, input.kind === 'audio'));
  } catch (err) {
    trace.error = `OpenAI session failed: ${err instanceof Error ? err.message : String(err)}`;
    return finishRecord();
  }
  trace.mark('t1');

  let failed = false;
  try {
    await driveCommand({ deps, input, trace, client, cache, policyCfg, originArea, instructions });
  } catch (err) {
    failed = true;
    if (!trace.error) trace.error = err instanceof Error ? err.message : String(err);
  } finally {
    source?.stop();
    deps.sessions.release(client, { failed });
  }
  return finishRecord();
}

interface DriveContext {
  deps: PipelineDeps;
  input: CommandInput;
  trace: CommandTrace;
  client: RealtimeClient;
  cache: NonNullable<Registry['cache']>;
  policyCfg: Config['policy'];
  originArea: string | undefined;
  instructions: string;
}

function driveCommand(ctx: DriveContext): Promise<void> {
  const { deps, input, trace, client, cache, policyCfg, originArea, instructions } = ctx;
  const source = input.kind === 'audio' ? input.source : null;
  const ackWanted = deps.cfg.session.ackResponse;

  return new Promise<void>((resolve, reject) => {
    let completed = false;
    let executionChain: Promise<void> = Promise.resolve();
    let pendingExecutions = 0;
    let sawFunctionCall = false;
    let functionResponseDone = false;
    let responsePhase: 'primary' | 'retry' | 'correction' | 'ack' = 'primary';
    let ackRequested = false;
    let ackResponseDone = false;
    let correctionWanted = false;
    let correctionRequested = false;
    let correctionArea: string | undefined;
    let waitingForTranscript = false;
    let validFunctionCalls = 0;
    const malformedCallErrors: string[] = [];
    let currentText = '';
    const timers: NodeJS.Timeout[] = [];
    let resolveTranscript: ((transcript: string | undefined) => void) | undefined;
    let transcriptWaitExpired = false;
    const transcriptPromise: Promise<string | undefined> =
      input.kind === 'text'
        ? Promise.resolve(input.utterance)
        : new Promise((resolveTranscriptPromise) => {
            resolveTranscript = resolveTranscriptPromise;
          });

    const cleanup = (): void => {
      completed = true;
      for (const t of timers) clearTimeout(t);
      resolveTranscript?.(undefined);
      resolveTranscript = undefined;
      client.off('event', onEvent);
      client.off('closed', onClosed);
      source?.stop();
    };
    const complete = (): void => {
      if (completed) return;
      cleanup();
      resolve();
    };
    const fail = (err: Error): void => {
      if (completed) return;
      cleanup();
      reject(err);
    };

    timers.push(setTimeout(() => fail(new Error('command timed out')), COMMAND_TIMEOUT_MS));

    const maybeFinishAfterResponse = (): void => {
      if (completed || !functionResponseDone || pendingExecutions > 0 || !sawFunctionCall) return;
      if (validFunctionCalls === 0 && malformedCallErrors.length > 0 && !trace.error) {
        trace.error = `model sent bad function arguments: ${malformedCallErrors.join('; ')}`;
      }
      if (correctionWanted && !correctionRequested && correctionArea) {
        correctionRequested = true;
        responsePhase = 'correction';
        sawFunctionCall = false;
        functionResponseDone = false;
        currentText = '';
        try {
          client.send({
            type: 'response.create',
            response: {
              tool_choice: 'required',
              tools: [lightMoodCorrectionTool(correctionArea)],
              instructions:
                `${instructions}\n\n` +
                'Correct the previous rejected call. The user described a visual lighting mood, not a named scene or device. Call control_device with domain "light", target "lights", the canonical stated/origin area, and supported appearance settings chosen from HOUSE.',
            },
          });
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      if (ackWanted) {
        if (!ackRequested) {
          ackRequested = true;
          responsePhase = 'ack';
          currentText = '';
          try {
            client.send({ type: 'response.create', response: { tool_choice: 'none' } });
          } catch (err) {
            // The action already ran; a lost ack is not a command failure.
            deps.logger.warn('ack request failed', { error: err instanceof Error ? err.message : String(err) });
            complete();
          }
          return;
        }
        if (ackResponseDone) complete();
        return;
      }
      complete();
    };

    const finishNoToolResponse = (spoken: string | undefined): void => {
      if (completed) return;
      if (
        responsePhase === 'primary' &&
        spoken &&
        shouldRetryWithRequiredTool(spoken, cache, policyCfg, originArea)
      ) {
        responsePhase = 'retry';
        currentText = '';
        try {
          client.send({
            type: 'response.create',
            response: {
              tool_choice: 'required',
              instructions:
                `${instructions}\n\n` +
                'The user made a clear, harmless smart-home change request. Call control_device now. If the wording describes a lighting mood, control the stated area lights with domain "light" and target "lights"; do not invent or select a scene. Choose supported appearance settings from HOUSE.',
            },
          });
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      trace.outcome = 'no_action';
      trace.ack = currentText || undefined;
      complete();
    };

    const commandTextForSafety = async (): Promise<string | undefined> => {
      if (input.kind === 'text') return input.utterance;
      if (trace.transcript !== undefined) return trace.transcript;
      if (transcriptWaitExpired) return undefined;
      const timeout = new Promise<undefined>((resolveTimeout) => {
        timers.push(setTimeout(() => resolveTimeout(undefined), TRANSCRIPT_GRACE_MS));
      });
      const spoken = await Promise.race([transcriptPromise, timeout]);
      if (spoken === undefined) transcriptWaitExpired = true;
      return spoken;
    };

    const handleCall = async (event: FunctionCallArgumentsDone): Promise<void> => {
      if (completed) return;
      trace.mark('t4');
      const spoken = await commandTextForSafety();
      if (completed) return;
      if (spoken && blocksDeviceAction(spoken)) {
        trace.mark('t5');
        trace.functionCalls.push({ name: event.name, args: event.arguments });
        trace.decisions.push({
          outcome: 'refuse',
          tier: 'unknown',
          reason: 'not_an_action',
          message: 'The utterance was a prohibition or informational question, not a device-change request.',
          entityIds: [],
        });
        trace.outcome = 'refused';
        client.send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: event.call_id,
            output: JSON.stringify({
              ok: false,
              message: 'No action taken: the utterance did not request a device change.',
              entities: [],
            }),
          },
        });
        return;
      }
      const parsed = parseControlDeviceArgs(event.arguments);
      let output: { ok: boolean; message: string; entities: string[] };

      if (!parsed.ok) {
        trace.functionCalls.push({ name: event.name, args: event.arguments });
        trace.decisions.push({ outcome: 'refuse', tier: 'unknown', reason: 'bad_arguments', message: parsed.error, entityIds: [] });
        malformedCallErrors.push(parsed.error);
        output = { ok: false, message: `invalid arguments: ${parsed.error}`, entities: [] };
      } else {
        validFunctionCalls++;
        trace.functionCalls.push({ name: event.name, args: parsed.action });
        if (
          spoken &&
          hasImpliedLightingMood(spoken) &&
          !hasExplicitOffIntent(spoken) &&
          parsed.action.domain === 'scene' &&
          !explicitlyRequestsScene(spoken, parsed.action.target)
        ) {
          correctionArea = areaForUtterance(spoken, cache, policyCfg, originArea);
          correctionWanted = correctionArea !== undefined;
          trace.mark('t5');
          trace.decisions.push({
            outcome: 'refuse',
            tier: 'green',
            reason: 'mood_requires_light_settings',
            message: 'Visual lighting moods must be expressed as light appearance settings, not an arbitrary named scene.',
            entityIds: [],
          });
          trace.outcome = 'refused';
          client.send({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: event.call_id,
              output: JSON.stringify({
                ok: false,
                message: correctionWanted
                  ? 'That call treated a visual lighting mood as a named scene. Retry using domain light, target lights, the canonical area, and supported appearance settings from HOUSE.'
                  : 'No action taken: the visual lighting mood did not include a safely resolvable area.',
                entities: [],
              }),
            },
          });
          return;
        }
        const decision = decide(cache, policyCfg, parsed.action, originArea);
        if (
          spoken &&
          !correctionRequested &&
          hasImpliedLightingMood(spoken) &&
          !hasExplicitOffIntent(spoken) &&
          (parsed.action.domain === 'scene' || parsed.action.domain === 'light') &&
          !(parsed.action.domain === 'scene' && explicitlyRequestsScene(spoken, parsed.action.target)) &&
          decision.outcome === 'refuse' &&
          (decision.reason === 'no_confident_match' || decision.reason === 'no_devices_in_scope')
        ) {
          correctionArea = areaForUtterance(spoken, cache, policyCfg, originArea);
          correctionWanted = correctionArea !== undefined;
        }
        trace.mark('t5');
        const summary = {
          outcome: decision.outcome,
          tier: decision.tier,
          reason: decision.reason,
          message: decision.message,
          entityIds: decision.entityIds,
          service: decision.resolved?.service,
          serviceData: decision.resolved?.serviceData,
          verified: undefined as boolean | undefined,
        };
        if (decision.outcome === 'execute' && decision.resolved) {
          const result = await executeAction(deps.haClient, decision.resolved, trace);
          if (completed) return; // command already failed/finished; leave the record alone
          summary.verified = result.verified;
          if (result.ok) {
            trace.outcome = 'executed';
            output = { ok: true, message: decision.message, entities: decision.entityIds };
          } else {
            trace.outcome = 'error';
            trace.error = result.error ?? 'Home Assistant call failed';
            output = { ok: false, message: trace.error, entities: decision.entityIds };
          }
        } else if (decision.outcome === 'dry_run') {
          if (trace.outcome !== 'executed') trace.outcome = 'dry_run';
          output = { ok: true, message: decision.message, entities: decision.entityIds };
        } else {
          if (trace.outcome === 'error') trace.outcome = 'refused';
          output = {
            ok: false,
            message: correctionWanted
              ? 'That call treated a visual lighting mood as a named scene or device. Retry using domain light, target lights, the canonical area, and supported appearance settings from HOUSE.'
              : decision.message,
            entities: [],
          };
        }
        trace.decisions.push(summary);
        deps.logger.info('policy decision', {
          cmd_id: trace.cmdId,
          outcome: decision.outcome,
          tier: decision.tier,
          reason: decision.reason,
          entities: decision.entityIds,
        });
      }

      if (completed) return;
      client.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(output) },
      });
    };

    const onEvent = (event: ServerEvent): void => {
      if (completed) return;
      switch (event.type) {
        case 'input_audio_buffer.speech_started':
          source?.speechStarted?.();
          return;
        case 'input_audio_buffer.speech_stopped':
          trace.mark('t3');
          source?.stop();
          return;
        case 'conversation.item.input_audio_transcription.completed':
          trace.transcript = (event as TranscriptionCompleted).transcript;
          resolveTranscript?.(trace.transcript);
          resolveTranscript = undefined;
          if (waitingForTranscript) {
            waitingForTranscript = false;
            finishNoToolResponse(trace.transcript);
          }
          return;
        case 'response.function_call_arguments.done':
          if (responsePhase === 'ack') {
            deps.logger.warn('ignored function call in acknowledgement response', {
              name: (event as FunctionCallArgumentsDone).name,
            });
            return;
          }
          sawFunctionCall = true;
          pendingExecutions++;
          executionChain = executionChain
            .then(() => handleCall(event as FunctionCallArgumentsDone))
            .catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))))
            .finally(() => {
              pendingExecutions--;
              maybeFinishAfterResponse();
            });
          return;
        case 'response.output_text.delta':
          currentText += (event as OutputTextDelta).delta;
          return;
        case 'response.done': {
          const response = (event as ResponseDone).response;
          trace.addUsage(usageFromRaw(response?.usage));
          if (response?.status && response.status !== 'completed') {
            if (responsePhase === 'ack') {
              deps.logger.warn('acknowledgement response did not complete', { status: response.status });
              complete();
            } else {
              fail(new Error(`realtime response ${response.status}`));
            }
            return;
          }
          if (responsePhase === 'ack') {
            ackResponseDone = true;
            trace.ack = currentText || undefined;
            maybeFinishAfterResponse();
            return;
          }

          if (!sawFunctionCall) {
            const spoken = input.kind === 'text' ? input.utterance : trace.transcript;
            if (input.kind === 'audio' && responsePhase === 'primary' && !spoken) {
              waitingForTranscript = true;
              timers.push(setTimeout(() => {
                if (!waitingForTranscript || completed) return;
                waitingForTranscript = false;
                finishNoToolResponse(undefined);
              }, TRANSCRIPT_GRACE_MS));
              return;
            }
            finishNoToolResponse(spoken);
            return;
          }

          functionResponseDone = true;
          maybeFinishAfterResponse();
          return;
        }
        case 'error': {
          const err = (event as { error?: { message?: string } }).error;
          fail(new Error(`realtime error: ${err?.message ?? 'unknown'}`));
          return;
        }
        default:
          return;
      }
    };
    const onClosed = (): void => {
      fail(new Error('realtime connection closed mid-command'));
    };
    client.on('event', onEvent);
    client.on('closed', onClosed);

    try {
      if (input.kind === 'text') {
        client.send({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: input.utterance }] },
        });
        trace.mark('t3');
        client.send({ type: 'response.create' });
      } else {
        void (async () => {
          for await (const frame of input.source.frames()) {
            if (completed) return;
            trace.mark('t2');
            client.send({ type: 'input_audio_buffer.append', audio: frame.toString('base64') });
          }
          // Source exhausted: if server VAD never saw an end of speech, don't hang.
          if (!completed && !trace.has('t3')) {
            timers.push(setTimeout(() => {
              if (!trace.has('t3')) fail(new Error('no speech detected in audio'));
            }, NO_SPEECH_GRACE_MS));
          }
        })().catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
      }
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
