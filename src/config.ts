// Env + voicebridge.yaml → one validated, typed Config.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { LightOptions } from './realtime/tools.js';

export const DEFAULT_MODEL = 'gpt-realtime-2.1-mini';

const MatchingSchema = z
  .object({
    min_confidence: z.number().min(0).max(1).default(0.6),
    max_collective_targets: z.number().int().positive().default(10),
  })
  .prefault({});

const SatelliteSchema = z.union([
  // Backwards-compatible placement-only form. It remains useful for WAV/text
  // testing, but `voicebridge run` needs the object form below to connect.
  z.string().min(1).transform((area) => ({
    area,
    host: undefined,
    port: 6053,
    ha_entry_id: undefined,
    encryption_key_env: undefined,
  })),
  z
    .object({
      area: z.string().min(1).optional(),
      host: z.string().min(1),
      port: z.number().int().min(1).max(65_535).default(6053),
      // Stock Satellite1 firmware receives a dynamic Noise key from HA. The
      // bridge fetches it through HA's admin websocket API using this id.
      ha_entry_id: z.string().min(1).optional(),
      // Fallback for custom/static ESPHome configurations. The key itself
      // stays in .env; YAML contains only the environment-variable name.
      encryption_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    })
    .strict(),
]);

const RgbSchema = z.tuple([
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
]);

// A flourish is a spoken phrase that gets a fixed, short-lived look and then
// puts the lights back. Deliberately local: the model is never asked, so a
// refusal or a creative reinterpretation cannot swallow it.
const FlourishSchema = z
  .object({
    phrases: z.array(z.string().min(1)).min(1),
    duration_seconds: z.number().positive().max(600).default(12),
    brightness_pct: z.number().min(0).max(100).optional(),
    rgb_color: RgbSchema.optional(),
    color_temp_kelvin: z.number().positive().optional(),
    effect: z.string().min(1).optional(),
    transition_seconds: z.number().min(0).max(6553).optional(),
    // Give each light its own colour and step the assignment along: a rainbow
    // that actually travels around the room, unlike a per-bulb effect.
    rotate_rgb: z.array(RgbSchema).min(2).optional(),
    rotate_interval_seconds: z.number().positive().max(60).default(1),
    rotate_transition_seconds: z.number().min(0).max(10).default(0.2),
  })
  .strict()
  .refine(
    (f) =>
      f.effect !== undefined ||
      f.rgb_color !== undefined ||
      f.color_temp_kelvin !== undefined ||
      f.brightness_pct !== undefined ||
      f.rotate_rgb !== undefined,
    'a flourish needs at least one of effect, rgb_color, color_temp_kelvin, brightness_pct, or rotate_rgb',
  )
  .refine(
    (f) => [f.effect, f.rgb_color, f.color_temp_kelvin, f.rotate_rgb].filter((v) => v !== undefined).length <= 1,
    'effect, rgb_color, color_temp_kelvin, and rotate_rgb are mutually exclusive',
  );

const YamlSchema = z
  .object({
    session: z
      .object({
        mode: z.enum(['per_utterance', 'warm']).default('per_utterance'),
        model: z.string().default(DEFAULT_MODEL),
        transcribe_input: z.boolean().default(true),
        ack_response: z.boolean().default(false),
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
    satellites: z.record(z.string(), SatelliteSchema).prefault({}),
    flourishes: z.array(FlourishSchema).default([]),
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

export interface SatelliteConfig {
  area: string | undefined;
  host: string | undefined;
  port: number;
  haEntryId: string | undefined;
  encryptionKeyEnv: string | undefined;
  /** Resolved from encryptionKeyEnv at load time; never written to logs or telemetry. */
  encryptionKey: string | undefined;
}

export interface RotationConfig {
  colors: Array<[number, number, number]>;
  intervalMs: number;
  transitionSeconds: number;
  brightnessPct: number | null;
}

export interface FlourishConfig {
  phrases: string[];
  durationMs: number;
  /** Reuses the model-facing light shape so flourishes get the same validation. */
  light: LightOptions;
  /** Set when the flourish walks colours around the room instead of holding one look. */
  rotation: RotationConfig | null;
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
  satellites: Record<string, SatelliteConfig>;
  flourishes: FlourishConfig[];
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
    satellites: Object.fromEntries(
      Object.entries(y.satellites).map(([id, satellite]) => [
        id,
        {
          area: satellite.area,
          host: satellite.host,
          port: satellite.port,
          haEntryId: satellite.ha_entry_id,
          encryptionKeyEnv: satellite.encryption_key_env,
          encryptionKey: satellite.encryption_key_env ? env[satellite.encryption_key_env] || undefined : undefined,
        } satisfies SatelliteConfig,
      ]),
    ),
    flourishes: y.flourishes.map((f) => ({
      phrases: f.phrases,
      durationMs: Math.round(f.duration_seconds * 1000),
      light: {
        brightness_pct: f.brightness_pct ?? null,
        brightness_step_pct: null,
        // A rotation still needs a colour on the opening call so capability
        // planning keeps only colour-capable lights.
        rgb_color: f.rgb_color ?? f.rotate_rgb?.[0] ?? null,
        color_temp_kelvin: f.color_temp_kelvin ?? null,
        effect: f.effect ?? null,
        transition_seconds: f.transition_seconds ?? null,
        flash: null,
      },
      rotation: f.rotate_rgb
        ? {
            colors: f.rotate_rgb,
            intervalMs: Math.round(f.rotate_interval_seconds * 1000),
            transitionSeconds: f.rotate_transition_seconds,
            brightnessPct: f.brightness_pct ?? null,
          }
        : null,
    })),
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
