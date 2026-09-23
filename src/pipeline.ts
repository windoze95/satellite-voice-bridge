// Orchestrator: one spoken/typed command through Realtime → policy → HA,
// with T0–T8 telemetry. Everything meets here.
//
// The model is forced to choose a tool on every utterance — act, dismiss, or
// hand off — so intent is decided once, out loud, by the only participant that
// heard the audio. What remains here is authorization and execution, plus one
// narrow transcript veto that can stop an action but can never start one.
import type { AudioSource } from './audio/source.js';
import type { Config, FlourishConfig } from './config.js';
import { buildInstructions } from './context/house-context.js';
import type { HAClient } from './ha/client.js';
import { executeAction } from './ha/executor.js';
import type { FlourishManager } from './ha/flourish-manager.js';
import { type Registry } from './ha/registry.js';
import { matchFlourish, snapshotLights } from './policy/flourish.js';
import type { Logger } from './logger.js';
import type { RealtimeClient } from './realtime/client.js';
import { delegateCommand } from './realtime/delegate.js';
import {
  usageFromRaw,
  type FunctionCallArgumentsDone,
  type OutputTextDelta,
  type ResponseDone,
  type ServerEvent,
  type TranscriptionCompleted,
} from './realtime/events.js';
import type { SessionManager } from './realtime/session.js';
import {
  parseControlDeviceArgs,
  parseDelegateArgs,
  parseDismissArgs,
  type ProposedAction,
  type Tone,
} from './realtime/tools.js';
import { decide, type Decision } from './policy/engine.js';
import { normalize } from './policy/resolve.js';
import { appendRecord, CommandTrace, type CommandRecord, type DecisionSummary } from './telemetry.js';

export interface PipelineDeps {
  cfg: Config;
  logger: Logger;
  haClient: HAClient;
  registry: Registry;
  sessions: SessionManager;
  flourish: FlourishManager;
}

export type CommandInput =
  /** originArea lets a typed command stand in for a satellite's room. */
  | { kind: 'text'; utterance: string; originArea?: string }
  | { kind: 'audio'; source: AudioSource };

export interface RunCommandOptions {
  dryRun?: boolean;
  /** 0 for a wake-word command; 1+ for each follow-up on the same open mic. */
  followUpIndex?: number;
}

const COMMAND_TIMEOUT_MS = 30_000;
const NO_SPEECH_GRACE_MS = 5_000;
const TRANSCRIPT_GRACE_MS = 750;

/**
 * Policy refusals that mean "you were probably right, but you aimed badly".
 * These are worth a second opinion from the strong model; a red-tier or
 * not-opted-in refusal is a decision, not a near miss, and is never escalated.
 */
const ESCALATABLE_REASONS = new Set(['no_confident_match', 'ambiguous', 'no_devices_in_scope', 'unknown_area']);

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

/**
 * The one transcript check that survives, and it only ever says no.
 *
 * "Don't turn on the lights" and "should I turn them on?" are the two shapes
 * where a model reaching for its one obvious tool does real damage, and they are
 * cheap to spot in text. Everything else about whether an utterance was a
 * command is the model's call now — this cannot suppress a good command, only
 * stop a clearly inverted one.
 */
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

/**
 * Apply a configured flourish and arm its restore. Targeting still goes through
 * the normal policy engine, so this can only touch lights a spoken command
 * could have touched; only the *choice* of appearance is local and fixed.
 */
async function executeFlourish(
  deps: PipelineDeps,
  trace: CommandTrace,
  spoken: string,
  flourish: FlourishConfig,
  cache: NonNullable<Registry['cache']>,
  policyCfg: Config['policy'],
  originArea: string | undefined,
): Promise<void> {
  trace.mark('t4');
  const area = areaForUtterance(spoken, cache, policyCfg, originArea);
  if (!area) {
    trace.mark('t5');
    trace.decisions.push({
      outcome: 'refuse',
      tier: 'green',
      reason: 'no_area_for_flourish',
      message: 'No area was stated and the device that heard this has no configured room.',
      entityIds: [],
    });
    trace.outcome = 'refused';
    return;
  }

  const decision = decide(cache, policyCfg, {
    action: 'turn_on',
    domain: 'light',
    target: 'lights',
    area,
    value: null,
    light: flourish.light,
    tone: 'playful',
  });
  trace.mark('t5');
  const call = decision.calls[0];
  const summary: DecisionSummary = {
    outcome: decision.outcome,
    tier: decision.tier,
    reason: decision.reason,
    message: decision.message,
    entityIds: decision.entityIds,
    service: call?.service,
    serviceData: call?.serviceData,
  };

  if (decision.outcome === 'refuse') {
    trace.decisions.push(summary);
    trace.outcome = 'refused';
    return;
  }
  if (decision.outcome === 'dry_run' || !call) {
    trace.decisions.push(summary);
    trace.outcome = 'dry_run';
    return;
  }

  // Snapshot before the flourish lands, or we would restore the flourish itself.
  const entityIds = decision.entityIds;
  const snapshots = deps.flourish.snapshot(() => snapshotLights(cache, entityIds), entityIds);
  const result = await executeAction(deps.haClient, call, trace);
  summary.verified = result.verified;
  trace.decisions.push(summary);

  if (!result.ok) {
    trace.outcome = 'error';
    trace.error = result.error ?? 'Home Assistant call failed';
    return;
  }
  trace.outcome = 'executed';
  if (flourish.rotation) {
    deps.flourish.startRotation(entityIds, flourish.rotation, snapshots, flourish.durationMs);
  } else {
    deps.flourish.scheduleRestore(snapshots, flourish.durationMs);
  }
  deps.logger.info('flourish applied', {
    cmd_id: trace.cmdId,
    entities: entityIds,
    rotating: flourish.rotation !== null,
    restore_in_ms: flourish.durationMs,
  });
}

export async function runCommand(
  deps: PipelineDeps,
  input: CommandInput,
  opts: RunCommandOptions = {},
): Promise<CommandRecord> {
  const { cfg, logger } = deps;
  const source = input.kind === 'audio' ? input.source : null;
  const trace = new CommandTrace(input.kind === 'text' ? 'text' : source!.kind, cfg.session.model, cfg.session.mode);
  if (input.kind === 'text') trace.utterance = input.utterance;
  if (opts.followUpIndex) trace.followUpIndex = opts.followUpIndex;
  trace.mark('t0');

  const policyCfg = opts.dryRun ? { ...cfg.policy, dryRun: true } : cfg.policy;

  const finishRecord = (): CommandRecord => {
    // Also covers failures before a Realtime session is acquired (HA down,
    // authentication failure, etc.). Satellite microphones must never be left
    // streaming merely because the command exited early.
    source?.stop();
    const rec = trace.finish();
    // A follow-up window that closed in silence is not a command that failed;
    // nobody said anything. Recording one would put an error row in the
    // telemetry for every command that simply wasn't followed up.
    if (source?.expired === true && !trace.has('t3')) {
      rec.outcome = 'no_action';
      rec.ok = true;
      rec.error = undefined;
      return rec;
    }
    appendRecord(cfg.telemetry.jsonlPath, rec);
    logger.info('command finished', { cmd_id: rec.cmd_id, outcome: rec.outcome, error: rec.error, d: rec.d as unknown });
    return rec;
  };

  const cache = deps.registry.cache;
  if (!cache || deps.haClient.state !== 'ready') {
    trace.error = 'Home Assistant is not connected';
    return finishRecord();
  }

  const originArea = source ? cfg.satellites[source.id]?.area : input.kind === 'text' ? input.originArea : undefined;

  // A typed flourish needs no interpretation: run it without opening a Realtime
  // session at all. (Spoken ones still need the session for transcription and
  // are matched from the transcript inside driveCommand.)
  if (input.kind === 'text') {
    const flourish = matchFlourish(input.utterance, cfg.flourishes);
    if (flourish) {
      trace.mark('t3');
      await executeFlourish(deps, trace, input.utterance, flourish, cache, policyCfg, originArea);
      return finishRecord();
    }
  }

  const instructions = buildInstructions(cache, policyCfg, originArea);

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
    let responsePhase: 'primary' | 'ack' = 'primary';
    let ackRequested = false;
    let ackResponseDone = false;
    let waitingForTranscript = false;
    let flourishHandled = false;
    let delegationUsed = false;
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
      // A flourish owns the command; the model's (ignored) reply must not end it
      // early, or the record is written before the flourish has an outcome.
      if (flourishHandled) return;
      if (completed || !functionResponseDone || pendingExecutions > 0 || !sawFunctionCall) return;
      if (validFunctionCalls === 0 && malformedCallErrors.length > 0 && !trace.error) {
        trace.error = `model sent bad function arguments: ${malformedCallErrors.join('; ')}`;
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

    // Matched on the transcript, not on a function call: the model refuses some
    // of these phrases outright, and a refusal emits no call to intercept.
    const maybeStartFlourish = (spoken: string | undefined): boolean => {
      if (completed || flourishHandled || !spoken) return false;
      const flourish = matchFlourish(spoken, deps.cfg.flourishes);
      if (!flourish) return false;
      flourishHandled = true;
      executeFlourish(deps, trace, spoken, flourish, cache, policyCfg, originArea)
        .then(() => complete())
        .catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
      return true;
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

    const respond = (callId: string, output: { ok: boolean; message: string; entities: string[] }): void => {
      if (completed) return;
      try {
        client.send({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
        });
      } catch (err) {
        // The action already ran or was refused; the model's copy of the result
        // is a nicety, and a dead socket is reported by 'closed' anyway.
        deps.logger.warn('function output send failed', { error: err instanceof Error ? err.message : String(err) });
      }
    };

    /** Run every call in an authorized decision, recording each one. */
    const applyDecision = async (decision: Decision): Promise<{ ok: boolean; message: string; entities: string[] }> => {
      if (decision.outcome === 'refuse') {
        if (trace.outcome === 'error') trace.outcome = 'refused';
        trace.decisions.push({
          outcome: 'refuse',
          tier: decision.tier,
          reason: decision.reason,
          message: decision.message,
          entityIds: decision.entityIds,
        });
        return { ok: false, message: decision.message, entities: [] };
      }

      if (decision.outcome === 'dry_run') {
        for (const call of decision.calls) {
          trace.decisions.push({
            outcome: 'dry_run',
            tier: decision.tier,
            reason: decision.reason,
            message: decision.message,
            entityIds: call.entityIds,
            service: call.service,
            serviceData: call.serviceData,
          });
        }
        if (trace.outcome !== 'executed') trace.outcome = 'dry_run';
        return { ok: true, message: decision.message, entities: decision.entityIds };
      }

      // This command owns these lights now; a pending flourish restore would
      // otherwise undo it seconds later.
      deps.flourish.cancelFor(decision.entityIds);

      let anyOk = false;
      let lastError: string | undefined;
      for (const call of decision.calls) {
        const result = await executeAction(deps.haClient, call, trace);
        if (completed) return { ok: false, message: 'command already finished', entities: [] };
        trace.decisions.push({
          outcome: 'execute',
          tier: decision.tier,
          reason: decision.reason,
          message: decision.message,
          entityIds: call.entityIds,
          service: call.service,
          serviceData: call.serviceData,
          verified: result.verified,
        });
        if (result.ok) anyOk = true;
        else lastError = result.error ?? 'Home Assistant call failed';
      }

      if (anyOk) {
        trace.outcome = 'executed';
        // A mood spans several calls; one failing bulb group should not erase
        // the fact that the room changed.
        if (lastError) deps.logger.warn('part of a multi-call command failed', { cmd_id: trace.cmdId, error: lastError });
        return { ok: true, message: decision.message, entities: decision.entityIds };
      }
      trace.outcome = 'error';
      trace.error = lastError ?? 'Home Assistant call failed';
      return { ok: false, message: trace.error, entities: decision.entityIds };
    };

    /**
     * Hand the utterance to the strong model and authorize whatever it plans.
     * Reached when the fast model asked for help, or when policy refused
     * something that looked like a near miss.
     */
    const runDelegation = async (
      request: string,
      why: string,
      tone: Tone,
    ): Promise<{ ok: boolean; message: string; entities: string[] }> => {
      delegationUsed = true;
      trace.mark('t4a');
      const result = await delegateCommand({
        cfg: deps.cfg.delegate,
        url: deps.cfg.delegate.url,
        apiKey: deps.cfg.openaiApiKey ?? '',
        instructions,
        request,
        transcript: trace.transcript ?? trace.utterance,
        tone,
        originArea,
        logger: deps.logger,
      });
      trace.mark('t4b');
      if (completed) return { ok: false, message: 'command already finished', entities: [] };

      if (!result.ok) {
        trace.decisions.push({
          outcome: 'refuse',
          tier: 'unknown',
          reason: 'delegate_failed',
          message: result.error,
          entityIds: [],
        });
        if (trace.outcome === 'error') trace.outcome = 'refused';
        if (!trace.error) trace.error = result.error;
        return { ok: false, message: result.error, entities: [] };
      }

      trace.delegated = {
        model: result.model,
        why,
        usage: result.usage,
      };
      deps.logger.info('delegated command', {
        cmd_id: trace.cmdId,
        model: result.model,
        calls: result.actions.length,
        why,
      });

      if (result.actions.length === 0) {
        const message = result.text ?? 'The stronger model proposed no device changes.';
        trace.decisions.push({
          outcome: 'refuse',
          tier: 'unknown',
          reason: 'delegate_no_action',
          message,
          entityIds: [],
        });
        if (trace.outcome === 'error') trace.outcome = 'no_action';
        trace.ack = result.text ?? undefined;
        return { ok: false, message, entities: [] };
      }

      const messages: string[] = [];
      const entities: string[] = [];
      let anyOk = false;
      for (const action of result.actions) {
        trace.functionCalls.push({ name: 'control_device', args: action });
        const decision = decide(cache, policyCfg, action, originArea, { moodOverrides: deps.cfg.moods });
        trace.mark('t5');
        const output = await applyDecision(decision);
        if (completed) break;
        messages.push(output.message);
        entities.push(...output.entities);
        anyOk ||= output.ok;
      }
      return { ok: anyOk, message: messages.join(' | '), entities: [...new Set(entities)] };
    };

    const handleDismiss = async (event: FunctionCallArgumentsDone): Promise<void> => {
      if (completed || flourishHandled) return;
      trace.mark('t4');
      const spoken = await commandTextForSafety();
      if (completed || flourishHandled) return;
      // The transcript can land after the call; a flourish phrase still wins,
      // because those are exactly the phrasings a model tends to back away from.
      if (maybeStartFlourish(spoken)) return;

      const parsed = parseDismissArgs(event.arguments);
      trace.mark('t5');
      validFunctionCalls++;
      if (!parsed.ok) {
        // A malformed dismissal is still a dismissal: the model declined to act.
        trace.functionCalls.push({ name: event.name, args: event.arguments });
        trace.dismissed = { reason: 'unclear' };
      } else {
        trace.functionCalls.push({ name: event.name, args: parsed.dismiss });
        trace.tone = parsed.dismiss.tone;
        trace.dismissed = {
          reason: parsed.dismiss.reason,
          note: parsed.dismiss.note ?? undefined,
        };
      }
      trace.outcome = 'no_action';
      deps.logger.info('utterance dismissed', {
        cmd_id: trace.cmdId,
        reason: trace.dismissed.reason,
        tone: trace.tone,
      });
      respond(event.call_id, { ok: true, message: 'No action taken.', entities: [] });
    };

    const handleDelegate = async (event: FunctionCallArgumentsDone): Promise<void> => {
      if (completed || flourishHandled) return;
      trace.mark('t4');
      const spoken = await commandTextForSafety();
      if (completed || flourishHandled) return;
      if (maybeStartFlourish(spoken)) return;

      const parsed = parseDelegateArgs(event.arguments);
      if (!parsed.ok) {
        trace.functionCalls.push({ name: event.name, args: event.arguments });
        malformedCallErrors.push(parsed.error);
        respond(event.call_id, { ok: false, message: `invalid arguments: ${parsed.error}`, entities: [] });
        return;
      }
      validFunctionCalls++;
      trace.functionCalls.push({ name: event.name, args: parsed.delegate });
      trace.tone = parsed.delegate.tone;

      if (spoken !== undefined && blocksDeviceAction(spoken)) {
        trace.mark('t5');
        trace.decisions.push({
          outcome: 'refuse',
          tier: 'unknown',
          reason: 'not_an_action',
          message: 'The utterance was a prohibition or informational question, not a device-change request.',
          entityIds: [],
        });
        trace.outcome = 'refused';
        respond(event.call_id, { ok: false, message: 'No action taken: that was not a device-change request.', entities: [] });
        return;
      }

      if (!deps.cfg.delegate.enabled) {
        trace.mark('t5');
        trace.decisions.push({
          outcome: 'refuse',
          tier: 'unknown',
          reason: 'delegate_disabled',
          message: 'The model asked to delegate, but delegation is disabled in voicebridge.yaml',
          entityIds: [],
        });
        trace.outcome = 'refused';
        respond(event.call_id, { ok: false, message: 'Delegation is disabled.', entities: [] });
        return;
      }

      const output = await runDelegation(parsed.delegate.request, parsed.delegate.why, parsed.delegate.tone);
      respond(event.call_id, output);
    };

    const handleCall = async (event: FunctionCallArgumentsDone): Promise<void> => {
      if (completed || flourishHandled) return;
      trace.mark('t4');
      const spoken = await commandTextForSafety();
      if (completed || flourishHandled) return;
      // The transcript can land after the call; this is the flourish's last
      // chance to take over before the model's proposal is acted on.
      if (maybeStartFlourish(spoken)) return;

      // Needs a transcript. An undefined one means transcription never
      // reported — unknown, not innocent, but refusing on it would break real
      // commands whenever STT lags.
      if (spoken !== undefined && blocksDeviceAction(spoken)) {
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
        respond(event.call_id, {
          ok: false,
          message: 'No action taken: the utterance did not request a device change.',
          entities: [],
        });
        return;
      }

      const parsed = parseControlDeviceArgs(event.arguments);
      if (!parsed.ok) {
        trace.functionCalls.push({ name: event.name, args: event.arguments });
        trace.decisions.push({ outcome: 'refuse', tier: 'unknown', reason: 'bad_arguments', message: parsed.error, entityIds: [] });
        malformedCallErrors.push(parsed.error);
        respond(event.call_id, { ok: false, message: `invalid arguments: ${parsed.error}`, entities: [] });
        return;
      }

      validFunctionCalls++;
      const action: ProposedAction = parsed.action;
      trace.functionCalls.push({ name: event.name, args: action });
      if (!trace.tone) trace.tone = action.tone;

      const decision = decide(cache, policyCfg, action, originArea, { moodOverrides: deps.cfg.moods });
      trace.mark('t5');

      // A near-miss refusal is worth a better model rather than a second guess
      // from the same one. Only ever once per command.
      if (
        decision.outcome === 'refuse' &&
        decision.reason !== undefined &&
        ESCALATABLE_REASONS.has(decision.reason) &&
        deps.cfg.delegate.enabled &&
        !delegationUsed
      ) {
        deps.logger.info('escalating refused command', {
          cmd_id: trace.cmdId,
          reason: decision.reason,
        });
        trace.decisions.push({
          outcome: 'refuse',
          tier: decision.tier,
          reason: decision.reason,
          message: decision.message,
          entityIds: decision.entityIds,
        });
        const output = await runDelegation(
          spoken ?? `${action.action} ${action.target}${action.area ? ` in ${action.area}` : ''}`,
          `the fast model's call was refused: ${decision.reason}`,
          action.tone,
        );
        respond(event.call_id, output);
        return;
      }

      const output = await applyDecision(decision);
      deps.logger.info('policy decision', {
        cmd_id: trace.cmdId,
        outcome: decision.outcome,
        tier: decision.tier,
        reason: decision.reason,
        entities: decision.entityIds,
      });
      respond(event.call_id, output);
    };

    const dispatch = (event: FunctionCallArgumentsDone): Promise<void> => {
      switch (event.name) {
        case 'dismiss':
          return handleDismiss(event);
        case 'delegate':
          return handleDelegate(event);
        default:
          return handleCall(event);
      }
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
          if (maybeStartFlourish(trace.transcript)) {
            waitingForTranscript = false;
            return;
          }
          if (waitingForTranscript) {
            waitingForTranscript = false;
            finishNoToolResponse();
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
            .then(() => dispatch(event as FunctionCallArgumentsDone))
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
            if (input.kind === 'audio' && !spoken) {
              waitingForTranscript = true;
              timers.push(setTimeout(() => {
                if (!waitingForTranscript || completed) return;
                waitingForTranscript = false;
                finishNoToolResponse();
              }, TRANSCRIPT_GRACE_MS));
              return;
            }
            if (maybeStartFlourish(spoken)) return;
            finishNoToolResponse();
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

    /**
     * The model answered with prose despite tool_choice "required" — or the
     * response carried nothing at all. Treated as a dismissal so the record and
     * the follow-up window agree that nothing happened.
     */
    function finishNoToolResponse(): void {
      if (completed || flourishHandled) return;
      trace.outcome = 'no_action';
      trace.ack = currentText || undefined;
      if (!trace.dismissed) trace.dismissed = { reason: 'unclear', note: currentText || undefined };
      complete();
    }

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
            // An expired follow-up window has nothing in flight; waiting out the
            // grace period would just hold the satellite's mic open in silence.
            if (input.source.expired === true) {
              fail(new Error('follow-up window closed without speech'));
              return;
            }
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
