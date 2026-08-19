// Orchestrator: one spoken/typed command through Realtime → policy → HA,
// with T0–T8 telemetry. Everything meets here.
import type { AudioSource } from './audio/source.js';
import type { Config } from './config.js';
import { buildInstructions } from './context/house-context.js';
import type { HAClient } from './ha/client.js';
import { executeAction } from './ha/executor.js';
import type { Registry } from './ha/registry.js';
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
import { parseControlDeviceArgs } from './realtime/tools.js';
import { decide } from './policy/engine.js';
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

export async function runCommand(deps: PipelineDeps, input: CommandInput, opts: { dryRun?: boolean } = {}): Promise<CommandRecord> {
  const { cfg, logger } = deps;
  const source = input.kind === 'audio' ? input.source : null;
  const trace = new CommandTrace(input.kind === 'text' ? 'text' : source!.kind, cfg.session.model, cfg.session.mode);
  if (input.kind === 'text') trace.utterance = input.utterance;
  trace.mark('t0');

  const policyCfg = opts.dryRun ? { ...cfg.policy, dryRun: true } : cfg.policy;

  const finishRecord = (): CommandRecord => {
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

  const originArea = source ? cfg.satellites[source.id] : undefined;
  const instructions = buildInstructions(cache, policyCfg);

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
    await driveCommand({ deps, input, trace, client, cache, policyCfg, originArea });
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
}

function driveCommand(ctx: DriveContext): Promise<void> {
  const { deps, input, trace, client, cache, policyCfg, originArea } = ctx;
  const source = input.kind === 'audio' ? input.source : null;
  const ackWanted = deps.cfg.session.ackResponse;

  return new Promise<void>((resolve, reject) => {
    let completed = false;
    let executionChain: Promise<void> = Promise.resolve();
    let pendingExecutions = 0;
    let sawFunctionCall = false;
    let firstResponseDone = false;
    let ackRequested = false;
    let currentText = '';
    const timers: NodeJS.Timeout[] = [];

    const cleanup = (): void => {
      completed = true;
      for (const t of timers) clearTimeout(t);
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
      if (completed || !firstResponseDone || pendingExecutions > 0 || !sawFunctionCall) return;
      if (ackWanted && !ackRequested) {
        ackRequested = true;
        currentText = '';
        try {
          client.send({ type: 'response.create' });
        } catch (err) {
          // The action already ran; a lost ack is not a command failure.
          deps.logger.warn('ack request failed', { error: err instanceof Error ? err.message : String(err) });
          complete();
        }
        return;
      }
      if (!ackWanted) complete();
    };

    const handleCall = async (event: FunctionCallArgumentsDone): Promise<void> => {
      if (completed) return;
      trace.mark('t4');
      const parsed = parseControlDeviceArgs(event.arguments);
      let output: { ok: boolean; message: string; entities: string[] };

      if (!parsed.ok) {
        trace.functionCalls.push({ name: event.name, args: event.arguments });
        trace.decisions.push({ outcome: 'refuse', tier: 'unknown', reason: 'bad_arguments', message: parsed.error, entityIds: [] });
        trace.error = `model sent bad function arguments: ${parsed.error}`;
        output = { ok: false, message: `invalid arguments: ${parsed.error}`, entities: [] };
      } else {
        trace.functionCalls.push({ name: event.name, args: parsed.action });
        const decision = decide(cache, policyCfg, parsed.action, originArea);
        trace.mark('t5');
        const summary = {
          outcome: decision.outcome,
          tier: decision.tier,
          reason: decision.reason,
          message: decision.message,
          entityIds: decision.entityIds,
          service: decision.resolved?.service,
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
          output = { ok: false, message: decision.message, entities: [] };
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
        case 'input_audio_buffer.speech_stopped':
          trace.mark('t3');
          source?.stop();
          return;
        case 'conversation.item.input_audio_transcription.completed':
          trace.transcript = (event as TranscriptionCompleted).transcript;
          return;
        case 'response.function_call_arguments.done':
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
          trace.addUsage(usageFromRaw((event as ResponseDone).response?.usage));
          if (!firstResponseDone) {
            firstResponseDone = true;
            if (!sawFunctionCall) {
              trace.outcome = 'no_action';
              trace.ack = currentText || undefined;
              complete();
            } else {
              maybeFinishAfterResponse();
            }
          } else {
            trace.ack = currentText || undefined;
            complete();
          }
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
      if (originArea) {
        client.send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: `The device that heard this command is in: ${originArea}. When no area is stated, prefer devices there.` }],
          },
        });
      }

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
