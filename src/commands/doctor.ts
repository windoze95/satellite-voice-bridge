// voicebridge doctor — check every dependency in order, ✓/✗/⚠/– per line,
// exit 1 if anything hard-fails. Designed so a paste of its output is a
// complete diagnosis.
import { spawnSync } from 'node:child_process';
import { ConfigError, loadConfig, type Config } from '../config.js';
import { advertisedDomains, buildInstructions } from '../context/house-context.js';
import { HAAuthError, HAClient } from '../ha/client.js';
import { Registry } from '../ha/registry.js';
import { Logger } from '../logger.js';
import { RealtimeClient } from '../realtime/client.js';
import { buildSessionConfig } from '../realtime/session.js';
import { parseControlDeviceArgs, type ProposedAction } from '../realtime/tools.js';
import type { FunctionCallArgumentsDone, ServerEvent } from '../realtime/events.js';

type Status = 'ok' | 'fail' | 'warn' | 'skip';
const ICON: Record<Status, string> = { ok: '✓', fail: '✗', warn: '⚠', skip: '–' };

let failed = false;
function report(status: Status, name: string, detail: string, startedAt?: number): void {
  if (status === 'fail') failed = true;
  const ms = startedAt !== undefined ? ` (${Math.round(performance.now() - startedAt)} ms)` : '';
  console.log(`${ICON[status]} ${name}: ${detail}${ms}`);
}

const SYNTHETIC_INSTRUCTIONS = `You are the voice-command interpreter for a smart home. Translate commands into a single control_device function call using ONLY devices from HOUSE.

HOUSE:
AREA: Test Room
  light: Test Light
  fan: Test Fan
  switch: Test Switch`;

export function environmentCheck(
  cfg: Pick<Config, 'openaiApiKey' | 'haUrl' | 'haToken'>,
): { ok: boolean; detail: string } {
  const missing: string[] = [];
  if (!cfg.openaiApiKey) missing.push('OPENAI_API_KEY');
  if (!cfg.haUrl) missing.push('HA_URL');
  if (!cfg.haToken) missing.push('HA_TOKEN');
  return missing.length === 0
    ? { ok: true, detail: `OPENAI_API_KEY=[set], HA_URL=${cfg.haUrl!}, HA_TOKEN=[set]` }
    : { ok: false, detail: `missing ${missing.join(', ')} — fill them in .env` };
}

export async function doctor(args: string[]): Promise<number> {
  const printContext = args.includes('--print-context');
  failed = false;

  // 1. config
  let cfg: Config;
  try {
    cfg = loadConfig();
    report(cfg.configFileFound ? 'ok' : 'warn', 'config', cfg.configFileFound ? `${cfg.configPath} valid` : 'voicebridge.yaml not found — using defaults');
  } catch (err) {
    report('fail', 'config', err instanceof ConfigError ? err.message : String(err));
    return 1;
  }

  // 2. env
  const env = environmentCheck(cfg);
  report(env.ok ? 'ok' : 'fail', 'env', env.detail);

  // 3. ffmpeg (audio path only)
  {
    const res = spawnSync(cfg.ffmpegPath, ['-version'], { encoding: 'utf8' });
    if (res.status === 0) report('ok', 'ffmpeg', String(res.stdout).split('\n', 1)[0] ?? cfg.ffmpegPath);
    else report('warn', 'ffmpeg', `${cfg.ffmpegPath} not runnable — 'voicebridge say' (audio path) unavailable`);
  }

  const logger = new Logger({ level: 'error' });

  // ---- Home Assistant chain ----
  let haClient: HAClient | null = null;
  let registry: Registry | null = null;
  const haConfigured = Boolean(cfg.haUrl && cfg.haToken);

  if (!cfg.haUrl) {
    report('skip', 'ha http', 'HA_URL not set');
  } else {
    const t = performance.now();
    try {
      const res = await fetch(`${cfg.haUrl}/api/`, { signal: AbortSignal.timeout(5000) });
      report('ok', 'ha http', `reachable (HTTP ${res.status})`, t);
    } catch (err) {
      report('fail', 'ha http', `${cfg.haUrl} unreachable: ${err instanceof Error ? err.message : String(err)}`, t);
    }
  }

  if (!haConfigured) {
    report('skip', 'ha auth', 'HA_URL/HA_TOKEN not set');
    report('skip', 'ha registry', 'requires ha auth');
    report('skip', 'ha service', 'requires ha auth');
  } else {
    const t = performance.now();
    registry = new Registry(logger, { voiceDomains: advertisedDomains(cfg.policy), cacheDumpPath: 'var/registry-cache.json' });
    haClient = new HAClient({ url: cfg.haUrl!, token: cfg.haToken!, logger, retry: false, onSync: (c) => registry!.sync(c) });
    registry.attach(haClient);
    try {
      await haClient.start();
      report('ok', 'ha auth', 'token accepted, websocket ready', t);
    } catch (err) {
      const hint = err instanceof HAAuthError ? ' (mint a long-lived token from an ADMIN HA user)' : '';
      report('fail', 'ha auth', `${err instanceof Error ? err.message : String(err)}${hint}`, t);
      haClient.stop();
      haClient = null;
    }

    if (haClient && registry.cache) {
      const c = registry.cache;
      const status = c.entitiesById.size === 0 ? 'fail' : 'ok';
      report(status, 'ha registry', `areas=${c.areasById.size} devices=${c.devicesById.size} entities=${c.entitiesById.size}`);
    } else {
      report('skip', 'ha registry', 'requires ha auth');
    }

    if (haClient) {
      const t2 = performance.now();
      try {
        const result = await haClient.request<{ context?: { id?: string } }>({
          type: 'call_service',
          domain: 'persistent_notification',
          service: 'create',
          service_data: { notification_id: 'voicebridge_doctor', title: 'voicebridge', message: 'doctor check — safe to ignore' },
        });
        await haClient.request({
          type: 'call_service',
          domain: 'persistent_notification',
          service: 'dismiss',
          service_data: { notification_id: 'voicebridge_doctor' },
        });
        report('ok', 'ha service', `persistent_notification round-trip, context ${result?.context?.id ? 'present' : 'MISSING'}`, t2);
      } catch (err) {
        report('fail', 'ha service', err instanceof Error ? err.message : String(err), t2);
      }
    } else {
      report('skip', 'ha service', 'requires ha auth');
    }
  }

  if (printContext && registry?.cache) {
    const context = buildInstructions(registry.cache, cfg.policy);
    console.log('\n----- generated house context (session instructions) -----');
    console.log(context);
    console.log(`----- ${context.length} chars ≈ ${Math.round(context.length / 4)} tokens -----\n`);
  }

  // ---- OpenAI chain ----
  if (!cfg.openaiApiKey) {
    report('skip', 'openai auth', 'OPENAI_API_KEY not set');
    report('skip', 'realtime session', 'requires openai auth');
    report('skip', 'function call', 'requires realtime session');
  } else {
    let authOk = false;
    {
      const t = performance.now();
      try {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${cfg.openaiApiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        authOk = res.ok;
        report(res.ok ? 'ok' : 'fail', 'openai auth', res.ok ? 'key accepted' : `HTTP ${res.status}${res.status === 401 ? ' — invalid key' : ''}`, t);
      } catch (err) {
        report('fail', 'openai auth', err instanceof Error ? err.message : String(err), t);
      }
    }

    if (!authOk) {
      report('skip', 'realtime session', 'requires openai auth');
      report('skip', 'function call', 'requires realtime session');
    } else {
      let rt: RealtimeClient | null = null;
      const t = performance.now();
      try {
        rt = await RealtimeClient.connect({ url: cfg.realtimeUrl, apiKey: cfg.openaiApiKey, model: cfg.session.model, logger });
        await rt.updateSession(buildSessionConfig({ instructions: SYNTHETIC_INSTRUCTIONS, audio: false, transcribe: false }));
        report('ok', 'realtime session', `created+updated [${cfg.session.model}]`, t);
      } catch (err) {
        report('fail', 'realtime session', `[${cfg.session.model}] ${err instanceof Error ? err.message : String(err)}`, t);
        rt?.close();
        rt = null;
      }

      if (!rt) {
        report('skip', 'function call', 'requires realtime session');
      } else {
        const t2 = performance.now();
        try {
          const action = await syntheticFunctionCall(rt);
          report('ok', 'function call', `control_device ${JSON.stringify(action)}`, t2);
        } catch (err) {
          report('fail', 'function call', err instanceof Error ? err.message : String(err), t2);
        }
        rt.close();
      }
    }
  }

  haClient?.stop();
  return failed ? 1 : 0;
}

/** Send a canned utterance against the synthetic context; expect a tool call. */
function syntheticFunctionCall(rt: RealtimeClient): Promise<ProposedAction> {
  return new Promise((resolve, reject) => {
    let textReply = '';
    const timer = setTimeout(() => {
      rt.off('event', onEvent);
      reject(new Error('timed out waiting for a function call'));
    }, 10_000);
    const finish = (fn: () => void): void => {
      clearTimeout(timer);
      rt.off('event', onEvent);
      fn();
    };
    const onEvent = (event: ServerEvent): void => {
      if (event.type === 'response.function_call_arguments.done') {
        const done = event as FunctionCallArgumentsDone;
        const parsed = parseControlDeviceArgs(done.arguments);
        finish(() => (parsed.ok ? resolve(parsed.action) : reject(new Error(`unparseable arguments: ${parsed.error}`))));
      } else if (event.type === 'response.output_text.delta') {
        textReply += (event as { delta?: string }).delta ?? '';
      } else if (event.type === 'response.done' && textReply) {
        finish(() => reject(new Error(`model replied with text instead of a tool call: "${textReply.slice(0, 120)}"`)));
      } else if (event.type === 'error') {
        const err = (event as { error?: { message?: string } }).error;
        finish(() => reject(new Error(err?.message ?? 'realtime error')));
      }
    };
    rt.on('event', onEvent);
    rt.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'turn on the test light' }] },
    });
    rt.send({ type: 'response.create' });
  });
}
