// Env + voicebridge.yaml → one validated, typed Config.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const DEFAULT_MODEL = 'gpt-realtime-2.1-mini';

const MatchingSchema = z
  .object({
    min_confidence: z.number().min(0).max(1).default(0.6),
    max_collective_targets: z.number().int().positive().default(10),
  })
  .prefault({});

const YamlSchema = z
  .object({
    session: z
      .object({
        mode: z.enum(['per_utterance', 'warm']).default('per_utterance'),
        model: z.string().default(DEFAULT_MODEL),
        transcribe_input: z.boolean().default(true),
        ack_response: z.boolean().default(true),
      })
      .prefault({}),
    policy: z
      .object({
        dry_run: z.boolean().default(false),
        tiers: z
          .object({
            green: z.array(z.string()).default(['light', 'fan', 'switch', 'media_player', 'scene', 'script']),
            yellow: z.array(z.string()).default(['lock', 'cover', 'climate']),
            red: z.array(z.string()).default(['alarm_control_panel']),
          })
          .prefault({}),
        yellow_allow: z.array(z.string()).default([]),
        matching: MatchingSchema,
        area_aliases: z.record(z.string(), z.array(z.string())).prefault({}),
      })
      .prefault({}),
    satellites: z.record(z.string(), z.string()).prefault({}),
    telemetry: z.object({ jsonl_path: z.string().default('var/commands.jsonl') }).prefault({}),
  })
  .prefault({});

export interface PolicyConfig {
  dryRun: boolean;
  tiers: { green: string[]; yellow: string[]; red: string[] };
  yellowAllow: string[];
  matching: { minConfidence: number; maxCollectiveTargets: number };
  areaAliases: Record<string, string[]>;
}

export interface Config {
  openaiApiKey: string | undefined;
  haUrl: string | undefined;
  haToken: string | undefined;
  realtimeUrl: string;
  ffmpegPath: string;
  configPath: string;
  configFileFound: boolean;
  session: { mode: 'per_utterance' | 'warm'; model: string; transcribeInput: boolean; ackResponse: boolean };
  policy: PolicyConfig;
  satellites: Record<string, string>;
  telemetry: { jsonlPath: string };
}

export class ConfigError extends Error {}

/** Loads config. Missing voicebridge.yaml falls back to the documented defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config {
  const configPath = resolve(cwd, env.VOICEBRIDGE_CONFIG ?? 'voicebridge.yaml');
  const configFileFound = existsSync(configPath);

  let raw: unknown = {};
  if (configFileFound) {
    try {
      raw = parse(readFileSync(configPath, 'utf8')) ?? {};
    } catch (err) {
      throw new ConfigError(`Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const parsed = YamlSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid config ${configPath}:\n${issues}`);
  }
  const y = parsed.data;

  return {
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    haUrl: env.HA_URL ? env.HA_URL.replace(/\/+$/, '') : undefined,
    haToken: env.HA_TOKEN || undefined,
    realtimeUrl: env.VOICEBRIDGE_REALTIME_URL || 'wss://api.openai.com/v1/realtime',
    ffmpegPath: env.VOICEBRIDGE_FFMPEG || 'ffmpeg',
    configPath,
    configFileFound,
    session: {
      mode: y.session.mode,
      model: env.VOICEBRIDGE_MODEL || y.session.model,
      transcribeInput: y.session.transcribe_input,
      ackResponse: y.session.ack_response,
    },
    policy: {
      dryRun: y.policy.dry_run,
      tiers: y.policy.tiers,
      yellowAllow: y.policy.yellow_allow,
      matching: {
        minConfidence: y.policy.matching.min_confidence,
        maxCollectiveTargets: y.policy.matching.max_collective_targets,
      },
      areaAliases: y.policy.area_aliases,
    },
    satellites: y.satellites,
    telemetry: { jsonlPath: resolve(cwd, y.telemetry.jsonl_path) },
  };
}

/** The env vars a live run needs; doctor reports these individually. */
export function missingEnv(cfg: Config): string[] {
  const missing: string[] = [];
  if (!cfg.openaiApiKey) missing.push('OPENAI_API_KEY');
  if (!cfg.haUrl) missing.push('HA_URL');
  if (!cfg.haToken) missing.push('HA_TOKEN');
  return missing;
}
