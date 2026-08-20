// Per-command latency trace (T0–T8), token usage, cost, JSONL record, console summary.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type TKey = 't0' | 't1' | 't2' | 't3' | 't4' | 't5' | 't6' | 't7' | 't8';

export interface Usage {
  inputTextTokens: number;
  inputAudioTokens: number;
  cachedTextTokens: number;
  cachedAudioTokens: number;
  outputTextTokens: number;
}

/** USD per 1M tokens (verified against OpenAI model pages, 2026-08). */
export const MODEL_PRICES: Record<string, { textIn: number; cachedText: number; textOut: number; audioIn: number; cachedAudio: number }> = {
  'gpt-realtime-2.1-mini': { textIn: 0.6, cachedText: 0.06, textOut: 2.4, audioIn: 10, cachedAudio: 0.3 },
  'gpt-realtime-2.1': { textIn: 4, cachedText: 0.4, textOut: 24, audioIn: 32, cachedAudio: 0.4 },
};

export function estimateCostUsd(model: string, u: Usage): number | null {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  const usd =
    (p.textIn * Math.max(0, u.inputTextTokens - u.cachedTextTokens) +
      p.cachedText * u.cachedTextTokens +
      p.audioIn * Math.max(0, u.inputAudioTokens - u.cachedAudioTokens) +
      p.cachedAudio * u.cachedAudioTokens +
      p.textOut * u.outputTextTokens) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

export type Outcome = 'executed' | 'dry_run' | 'refused' | 'no_action' | 'error';

export interface DecisionSummary {
  outcome: 'execute' | 'dry_run' | 'refuse';
  tier?: string;
  reason?: string;
  message: string;
  entityIds: string[];
  service?: string;
  serviceData?: Record<string, unknown>;
  verified?: boolean;
}

export interface Deltas {
  session_setup?: number;
  model?: number;
  policy?: number;
  ha_ack?: number;
  confirm?: number;
  speech_to_ack?: number;
  speech_to_action?: number;
}

export interface CommandRecord {
  ts: string;
  cmd_id: string;
  source: 'text' | 'wav' | 'satellite';
  ok: boolean;
  outcome: Outcome;
  utterance?: string;
  transcript?: string;
  model: string;
  session_mode: string;
  function_calls: Array<{ name: string; args: unknown }>;
  decisions: DecisionSummary[];
  t: Partial<Record<TKey, number>>;
  d: Deltas;
  usage: Usage;
  cost_usd: number | null;
  ack?: string;
  error?: string;
}

export class CommandTrace {
  readonly cmdId = randomUUID().slice(0, 8);
  utterance?: string;
  transcript?: string;
  ack?: string;
  error?: string;
  outcome: Outcome = 'error';
  readonly functionCalls: Array<{ name: string; args: unknown }> = [];
  readonly decisions: DecisionSummary[] = [];
  readonly usage: Usage = { inputTextTokens: 0, inputAudioTokens: 0, cachedTextTokens: 0, cachedAudioTokens: 0, outputTextTokens: 0 };
  private readonly mono: Partial<Record<TKey, number>> = {};
  private readonly wall: Partial<Record<TKey, number>> = {};

  constructor(
    readonly source: 'text' | 'wav' | 'satellite',
    readonly model: string,
    readonly sessionMode: string,
  ) {}

  /** Stamp a timestamp; first stamp wins so retries can't rewrite history. */
  mark(k: TKey): void {
    if (this.mono[k] === undefined) {
      this.mono[k] = performance.now();
      this.wall[k] = Date.now();
    }
  }

  /** Copy one mark onto another (e.g. fire-and-forget actions set T8 := T7). */
  copyMark(from: TKey, to: TKey): void {
    if (this.mono[to] === undefined && this.mono[from] !== undefined) {
      this.mono[to] = this.mono[from];
      this.wall[to] = this.wall[from];
    }
  }

  /** Test hook / external clock injection. */
  markAt(k: TKey, monoMs: number, wallMs?: number): void {
    if (this.mono[k] === undefined) {
      this.mono[k] = monoMs;
      this.wall[k] = wallMs ?? Date.now();
    }
  }

  has(k: TKey): boolean {
    return this.mono[k] !== undefined;
  }

  addUsage(u: Partial<Usage>): void {
    for (const key of Object.keys(this.usage) as Array<keyof Usage>) {
      this.usage[key] += u[key] ?? 0;
    }
  }

  deltas(): Deltas {
    const d = (a: TKey, b: TKey): number | undefined => {
      const ma = this.mono[a];
      const mb = this.mono[b];
      return ma !== undefined && mb !== undefined ? Math.max(0, Math.round(mb - ma)) : undefined;
    };
    return {
      session_setup: d('t0', 't1'),
      model: d('t3', 't4'),
      policy: d('t4', 't5'),
      ha_ack: d('t6', 't7'),
      confirm: d('t7', 't8'),
      speech_to_ack: d('t3', 't7'),
      speech_to_action: d('t3', 't8'),
    };
  }

  finish(): CommandRecord {
    return {
      ts: new Date(this.wall.t0 ?? Date.now()).toISOString(),
      cmd_id: this.cmdId,
      source: this.source,
      ok: this.outcome === 'executed' || this.outcome === 'dry_run' || this.outcome === 'no_action',
      outcome: this.outcome,
      utterance: this.utterance,
      transcript: this.transcript,
      model: this.model,
      session_mode: this.sessionMode,
      function_calls: this.functionCalls,
      decisions: this.decisions,
      t: { ...this.wall },
      d: this.deltas(),
      usage: { ...this.usage },
      cost_usd: estimateCostUsd(this.model, this.usage),
      ack: this.ack,
      error: this.error,
    };
  }

  summaryLine(): string {
    return summaryLine(this.finish());
  }
}

/** One-line console summary of a finished command. */
export function summaryLine(rec: CommandRecord): string {
  {
    const icon = rec.outcome === 'executed' || rec.outcome === 'dry_run' ? '✔' : rec.outcome === 'no_action' ? '–' : '✖';
    const spoken = rec.transcript ?? rec.utterance ?? '(no utterance)';
    const parts: string[] = [`${icon} ${JSON.stringify(spoken)}`];

    const dec =
      rec.outcome === 'executed' || rec.outcome === 'dry_run'
        ? (rec.decisions.find((decision) => decision.outcome !== 'refuse') ?? rec.decisions[0])
        : rec.decisions[0];
    if (dec && dec.outcome !== 'refuse') {
      const ids = dec.entityIds.slice(0, 3).join(', ') + (dec.entityIds.length > 3 ? ` +${dec.entityIds.length - 3}` : '');
      const verb = dec.service ? dec.service.replace(/^turn_/, '') : '';
      parts.push(`→ ${ids}${verb ? ` ${verb}` : ''}${rec.outcome === 'dry_run' ? ' (dry-run)' : ''}`);
    } else if (dec) {
      parts.push(`refused (${dec.reason ?? 'policy'}: ${dec.message})`);
    } else if (rec.outcome === 'no_action' && rec.ack) {
      parts.push(`→ "${rec.ack}"`);
    } else if (rec.error) {
      parts.push(`error: ${rec.error}`);
    }

    const d = rec.d;
    if (d.speech_to_action !== undefined) {
      parts.push(
        `| speech→action ${d.speech_to_action} ms (model ${d.model ?? '?'} · policy ${d.policy ?? '?'} · ha ${d.ha_ack ?? '?'} · confirm ${d.confirm ?? '?'})`,
      );
    } else if (d.speech_to_ack !== undefined) {
      parts.push(`| speech→ack ${d.speech_to_ack} ms (model ${d.model ?? '?'} · policy ${d.policy ?? '?'} · ha ${d.ha_ack ?? '?'})`);
    } else if (d.model !== undefined) {
      parts.push(`| model ${d.model} ms`);
    }

    if (rec.cost_usd !== null) parts.push(`| $${rec.cost_usd.toFixed(4)}`);
    return parts.join(' ');
  }
}

/** Append one command record to the JSONL telemetry file. */
export function appendRecord(jsonlPath: string, rec: CommandRecord): void {
  try {
    mkdirSync(dirname(jsonlPath), { recursive: true });
    appendFileSync(jsonlPath, `${JSON.stringify(rec)}\n`);
  } catch {
    // Telemetry must never take the bridge down.
  }
}
