// Handoff to the slower, stronger model.
//
// The fast Realtime model is optimized for answering in a few hundred
// milliseconds, which is the right trade for "turn off the kitchen lights" and
// the wrong one for "something cozy but I still need to read." Rather than
// prompt-engineering the fast model into competence it does not have, it is
// given a way to say "this one needs more thought" — and a policy refusal that
// looks like a near-miss escalates here too, instead of re-asking the model that
// just failed.
//
// This grants no new authority: whatever comes back is an ordinary
// ProposedAction list and goes through the same policy engine as anything else.
import type { DelegateConfig } from '../config.js';
import type { Logger } from '../logger.js';
import {
  DELEGATE_CONTROL_DEVICE_TOOL,
  parseControlDeviceArgs,
  type ProposedAction,
  type Tone,
} from './tools.js';

export interface DelegateUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export type DelegateResult =
  | { ok: true; actions: ProposedAction[]; text: string | null; usage: DelegateUsage; model: string }
  | { ok: false; error: string };

export interface DelegateOptions {
  cfg: DelegateConfig;
  apiKey: string;
  /** Same HOUSE map and rules the fast model was given. */
  instructions: string;
  /** What the fast model understood the user to want. */
  request: string;
  /** Verbatim transcript, when one is available — the paraphrase can lose detail. */
  transcript?: string;
  /** The fast model's read of the delivery; the delegate only sees text. */
  tone: Tone;
  originArea?: string;
  logger: Logger;
  url?: string;
  fetchImpl?: typeof fetch;
}

const DELEGATE_RULES = `You are the deliberate half of a voice-controlled smart home. A fast model heard the user and handed this to you because it needed more thought than a sub-second answer allows.

- Answer ONLY with control_device calls. Make as many as the request needs — one per group of lights that should look the same. Do not narrate.
- You are being waited on in real time and the user hears nothing until the devices move. Decide and call; do not deliberate over equally good options.
- Use ONLY the area names and device names from HOUSE. Never invent a device, area, or scene.
- When lights should differ from each other, target them individually by their exact names from the AREA's individual-light lines, and give each call its own settings.
- Respect each light's advertised capabilities: only send rgb_color to lights listed as RGB-capable, only send color_temp_kelvin within the stated range, and only send an effect that is advertised.
- Prefer light.mood when one of the named moods already describes the request; the bridge will render it across the room. Use explicit settings when the user wants something more specific than a mood.
- If the request cannot be satisfied with the devices in HOUSE, make no calls.`;

interface ResponsesOutput {
  type: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type: string; text?: string }>;
}

interface ResponsesBody {
  status?: string;
  model?: string;
  error?: { message?: string };
  incomplete_details?: { reason?: string };
  output?: ResponsesOutput[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

const EMPTY_USAGE: DelegateUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };

function usageFrom(body: ResponsesBody): DelegateUsage {
  return {
    inputTokens: body.usage?.input_tokens ?? 0,
    cachedTokens: body.usage?.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    reasoningTokens: body.usage?.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * Ask the strong model to plan this request. Never throws and never rejects:
 * a delegation that fails is a command that did not happen, not a crashed
 * bridge, and the caller reports it as an ordinary refusal.
 */
export async function delegateCommand(opts: DelegateOptions): Promise<DelegateResult> {
  const url = opts.url ?? opts.cfg.url;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.cfg.timeoutMs);

  const context = [
    opts.transcript ? `The user said, verbatim: "${opts.transcript}"` : null,
    `The fast model understood this as: ${opts.request}`,
    `It heard the delivery as: ${opts.tone}.`,
    opts.originArea ? `The device that heard this is in: ${opts.originArea}. When no area is stated, prefer devices there.` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: opts.cfg.model,
        instructions: `${DELEGATE_RULES}\n\n${opts.instructions}`,
        input: [{ role: 'user', content: context }],
        tools: [DELEGATE_CONTROL_DEVICE_TOOL],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        reasoning: { effort: opts.cfg.reasoningEffort },
        max_output_tokens: 2000,
        store: false,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ok: false, error: `delegate HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` };
    }

    const body = (await response.json()) as ResponsesBody;
    if (body.error?.message) return { ok: false, error: `delegate error: ${body.error.message}` };

    const outputs = body.output ?? [];
    const actions: ProposedAction[] = [];
    const malformed: string[] = [];
    for (const output of outputs) {
      if (output.type !== 'function_call' || output.name !== 'control_device') continue;
      const parsed = parseControlDeviceArgs(output.arguments ?? '');
      if (parsed.ok) {
        // The delegate reads text, so it cannot hear delivery; carry the fast
        // model's reading through so mood rendering stays consistent.
        actions.push({ ...parsed.action, tone: opts.tone });
      } else {
        malformed.push(parsed.error);
      }
    }

    const text =
      outputs
        .filter((output) => output.type === 'message')
        .flatMap((output) => output.content ?? [])
        .map((part) => part.text ?? '')
        .join(' ')
        .trim() || null;

    if (actions.length === 0) {
      if (malformed.length > 0) {
        return { ok: false, error: `delegate sent bad function arguments: ${malformed.join('; ')}` };
      }
      // A truncated response is a different failure from a considered refusal,
      // and only one of the two is worth retrying or raising a limit over.
      if (body.status === 'incomplete') {
        return { ok: false, error: `delegate response incomplete: ${body.incomplete_details?.reason ?? 'unknown'}` };
      }
    }

    opts.logger.debug('delegate responded', {
      model: body.model ?? opts.cfg.model,
      calls: actions.length,
      malformed: malformed.length,
    });
    return { ok: true, actions, text, usage: usageFrom(body), model: body.model ?? opts.cfg.model };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: `delegate timed out after ${opts.cfg.timeoutMs} ms` };
    }
    return { ok: false, error: `delegate failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

export { EMPTY_USAGE as EMPTY_DELEGATE_USAGE };
