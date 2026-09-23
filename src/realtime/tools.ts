// The model↔policy boundary — single source of truth for what the model may say.
//
// Three tools, and the session forces a choice between them: every utterance
// yields exactly one explicit, logged decision from a model that heard the
// audio. There is no "reply with prose instead of deciding" path, because that
// path is what used to require the bridge to second-guess the model with word
// lists.
//
// RED verbs/domains are deliberately IN the enums: the model must be able to
// express them so the policy engine can refuse deterministically and loggably.
// Safety never relies on the model censoring itself.
import { z } from 'zod';

export const CONTROL_ACTIONS = [
  'turn_on',
  'turn_off',
  'toggle',
  'set',
  'open',
  'close',
  'stop',
  'lock',
  'unlock',
  'activate',
  'play',
  'pause',
  'disarm',
] as const;

export const CONTROL_DOMAINS = [
  'light',
  'fan',
  'switch',
  'media_player',
  'scene',
  'script',
  'cover',
  'lock',
  'climate',
  'alarm_control_panel',
] as const;

/**
 * How the utterance was *said*, not what it said. The Realtime model receives
 * the raw audio, so prosody is available to it and to nothing else in this
 * system — every other guard here reads a text transcript. Closed enum so the
 * value is usable as a lookup key rather than free text.
 */
export const TONES = [
  'neutral',
  'intimate',
  'playful',
  'urgent',
  'tired',
  'annoyed',
  'excited',
  'hushed',
] as const;

/**
 * Named lighting intents. The model picks the mood and the area; the local
 * composer (policy/mood.ts) decides which bulb does what. Deliberately a closed
 * set: an open-ended mood string would put appearance invention back in the
 * model, which is the thing that needed correcting round trips.
 */
export const MOODS = [
  'intimate',
  'romantic',
  'cozy',
  'focus',
  'clinical',
  'party',
  'cinema',
  'wake',
  'wind_down',
  'normal',
] as const;

/** Why an utterance was not a command. All five end the follow-up window. */
export const DISMISS_REASONS = [
  'background_speech',
  'question',
  'prohibition',
  'not_about_the_house',
  'unclear',
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];
export type ControlDomain = (typeof CONTROL_DOMAINS)[number];
export type Tone = (typeof TONES)[number];
export type Mood = (typeof MOODS)[number];
export type DismissReason = (typeof DISMISS_REASONS)[number];

export interface LightOptions {
  brightness_pct: number | null;
  brightness_step_pct: number | null;
  rgb_color: [number, number, number] | null;
  color_temp_kelvin: number | null;
  effect: string | null;
  mood: Mood | null;
  transition_seconds: number | null;
  flash: 'short' | 'long' | null;
}

export interface ProposedAction {
  action: ControlAction;
  domain: ControlDomain;
  target: string;
  area: string | null;
  value: number | string | null;
  light: LightOptions | null;
  tone: Tone;
}

export interface DismissDecision {
  reason: DismissReason;
  tone: Tone;
  note: string | null;
}

export interface DelegateRequest {
  request: string;
  why: string;
  tone: Tone;
}

const LIGHT_PROPERTIES = {
  brightness_pct: { type: ['number', 'null'], minimum: 0, maximum: 100 },
  brightness_step_pct: {
    type: ['number', 'null'],
    minimum: -100,
    maximum: 100,
    description: 'Relative brightness change: positive is brighter, negative is dimmer. Must be non-zero.',
  },
  rgb_color: {
    type: ['array', 'null'],
    items: { type: 'integer', minimum: 0, maximum: 255 },
    minItems: 3,
    maxItems: 3,
  },
  color_temp_kelvin: { type: ['number', 'null'], minimum: 1 },
  effect: {
    type: ['string', 'null'],
    description: 'Exact advertised effect name, or "off" to stop an effect.',
  },
  mood: {
    type: ['string', 'null'],
    enum: [...MOODS, null],
    description:
      'A named lighting mood. Prefer this over inventing colors whenever the user described a FEELING or STYLE rather than a specific appearance. The bridge renders it across the area using each light\'s real capabilities, so do not also set rgb_color, color_temp_kelvin, or effect.',
  },
  transition_seconds: { type: ['number', 'null'], minimum: 0, maximum: 6553 },
  flash: { type: ['string', 'null'], enum: ['short', 'long', null] },
} as const;

const CONTROL_DEVICE_PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...CONTROL_ACTIONS] },
    domain: { type: 'string', enum: [...CONTROL_DOMAINS] },
    target: { type: 'string', description: "Device or group as spoken, e.g. 'ceiling fan', 'lights', 'front door'" },
    area: { type: ['string', 'null'], description: 'Area name from HOUSE if stated or implied; null otherwise' },
    value: {
      type: ['number', 'string', 'null'],
      description: 'Non-light percentage/temperature value, or null. Use light for every light setting.',
    },
    light: {
      type: ['object', 'null'],
      description: 'Light-only settings, or null. mood, rgb_color, color_temp_kelvin, and effect are mutually exclusive.',
      properties: LIGHT_PROPERTIES,
      additionalProperties: false,
    },
  },
  required: ['action', 'domain', 'target'],
  additionalProperties: false,
} as const;

const TONE_PROPERTY = {
  type: 'string',
  enum: [...TONES],
  description:
    'How it was SAID — judge from the voice (pace, volume, warmth, breathiness), not from the words. Use "neutral" only when the delivery is genuinely flat.',
} as const;

/** Tool definition sent in session.update (GA Realtime shape). */
export const CONTROL_DEVICE_TOOL = {
  type: 'function',
  name: 'control_device',
  description:
    'Control a smart-home device, group, or scene. Call this whenever the user wants something in the house changed. ' +
    'target is the device/group name as spoken (for whole-group commands use the domain plural, e.g. "lights"); ' +
    'area is a room/area name exactly as listed in HOUSE, or null when none was stated or implied; ' +
    'value is for non-light percentages or temperatures; put every light setting in light; ' +
    'use light.mood for a feeling or style, and rgb_color/color_temp_kelvin for an appearance the user named exactly.',
  parameters: {
    ...CONTROL_DEVICE_PARAMETERS,
    properties: { ...CONTROL_DEVICE_PARAMETERS.properties, tone: TONE_PROPERTY },
    required: [...CONTROL_DEVICE_PARAMETERS.required, 'tone'],
  },
} as const;

/**
 * The utterance was not a command. A wake word fires on ordinary conversation
 * more often than anyone would like: "Excited and nervous, yeah." once produced
 * a clean turn_on of five lights. Giving that outcome its own tool means the
 * model states it — hearing the room, the pauses, and who was being addressed —
 * instead of the bridge inferring it from a vocabulary list.
 */
export const DISMISS_TOOL = {
  type: 'function',
  name: 'dismiss',
  description:
    'Take no action. Call this when the utterance was not a command addressed to you: people talking to each other, ' +
    'speech that happens to mention the house, a question about state rather than a request to change it, ' +
    'a prohibition ("don\'t turn on the lights"), or something you simply could not make sense of. ' +
    'Dismissing is always safe and always correct when in doubt — a missed command costs one repeat, a wrong action costs trust.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', enum: [...DISMISS_REASONS] },
      tone: TONE_PROPERTY,
      note: {
        type: ['string', 'null'],
        description: 'At most one short clause on what you heard. Logged for tuning, never spoken.',
      },
    },
    required: ['reason', 'tone'],
    additionalProperties: false,
  },
} as const;

/**
 * Hand off to the slower, stronger model. Calling this is not a failure — it is
 * the correct answer whenever getting it right needs more thought than a
 * low-latency voice model should spend. The bridge runs the result through the
 * same policy engine, so delegating grants no additional authority.
 */
export const DELEGATE_TOOL = {
  type: 'function',
  name: 'delegate',
  description:
    'Hand this utterance to a stronger model that will plan the house changes. Call this instead of guessing when the ' +
    'request needs real coordination (several rooms, or every light doing something different), depends on reasoning ' +
    'about what the user is doing, or is simply beyond a confident single call. Prefer delegating over a call you are unsure about.',
  parameters: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description: 'What the user wants, in your own words, including anything implied by how they said it.',
      },
      why: { type: 'string', description: 'One clause on why this needs more thought.' },
      tone: TONE_PROPERTY,
    },
    required: ['request', 'why', 'tone'],
    additionalProperties: false,
  },
} as const;

/**
 * The delegate reads a transcript, not audio, so it cannot judge tone; the fast
 * model's reading is carried over instead. Shape follows the Responses API.
 */
export const DELEGATE_CONTROL_DEVICE_TOOL = {
  type: 'function',
  name: 'control_device',
  description: CONTROL_DEVICE_TOOL.description,
  parameters: CONTROL_DEVICE_PARAMETERS,
} as const;

const NullableNumber = z.union([z.number().finite(), z.null()]);
const LightOptionsSchema = z
  .object({
    brightness_pct: NullableNumber.refine((v) => v === null || (v >= 0 && v <= 100), 'must be between 0 and 100').default(null),
    brightness_step_pct: NullableNumber.refine(
      (v) => v === null || (v >= -100 && v <= 100 && Math.abs(v) >= 1),
      'must be between -100 and 100 and have magnitude at least 1',
    ).default(null),
    rgb_color: z
      .union([z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]), z.null()])
      .default(null),
    color_temp_kelvin: NullableNumber.refine((v) => v === null || v >= 1, 'must be at least 1').default(null),
    effect: z.union([z.string().trim().min(1).max(100), z.null()]).default(null),
    mood: z.union([z.enum(MOODS), z.null()]).default(null),
    transition_seconds: NullableNumber.refine((v) => v === null || (v >= 0 && v <= 6553), 'must be between 0 and 6553').default(null),
    flash: z.union([z.enum(['short', 'long']), z.null()]).default(null),
  })
  .strict();

const ArgsSchema = z
  .object({
    action: z.enum(CONTROL_ACTIONS),
    domain: z.enum(CONTROL_DOMAINS),
    target: z.string().min(1),
    area: z.union([z.string(), z.null()]).default(null),
    value: z.union([z.number(), z.string(), z.null()]).default(null),
    light: z.union([LightOptionsSchema, z.null()]).default(null),
    // Absent tone is a neutral read, not a malformed call: a delegated proposal
    // never carries one, and refusing the whole action over a missing adverb
    // would trade a working light for a logging field.
    tone: z.enum(TONES).default('neutral'),
  })
  .strict()
  .superRefine((args, ctx) => {
    const light = args.light;
    if (!light) return;

    const populated = Object.values(light).some((value) => value !== null);
    if (populated && args.domain !== 'light') {
      ctx.addIssue({ code: 'custom', path: ['light'], message: 'light settings are only valid for the light domain' });
    }
    if (populated && args.value !== null) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'value cannot be combined with light settings' });
    }
    if (light.brightness_pct !== null && light.brightness_step_pct !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['light'],
        message: 'brightness_pct and brightness_step_pct are mutually exclusive',
      });
    }

    // A mood is rendered from the area's live capabilities, so pairing it with a
    // hand-picked appearance would mean two answers to the same question.
    const modes = [light.rgb_color, light.color_temp_kelvin, light.effect, light.mood].filter((value) => value !== null);
    if (modes.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['light'],
        message: 'mood, rgb_color, color_temp_kelvin, and effect are mutually exclusive',
      });
    }
    if (light.mood !== null && light.brightness_step_pct !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['light'],
        message: 'mood cannot be combined with brightness_step_pct',
      });
    }

    if (populated && args.action !== 'turn_on' && args.action !== 'set' && args.action !== 'turn_off') {
      ctx.addIssue({ code: 'custom', path: ['action'], message: `${args.action} cannot include light settings` });
    }
    if (
      args.action === 'turn_off' &&
      (light.brightness_pct !== null ||
        light.brightness_step_pct !== null ||
        light.rgb_color !== null ||
        light.color_temp_kelvin !== null ||
        light.effect !== null ||
        light.mood !== null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['light'],
        message: 'turn_off only accepts transition_seconds and flash light settings',
      });
    }
  });

const DismissSchema = z
  .object({
    reason: z.enum(DISMISS_REASONS),
    tone: z.enum(TONES).default('neutral'),
    note: z.union([z.string().trim().max(200), z.null()]).default(null),
  })
  .strict();

const DelegateSchema = z
  .object({
    request: z.string().trim().min(1).max(2000),
    why: z.string().trim().max(500).default(''),
    tone: z.enum(TONES).default('neutral'),
  })
  .strict();

export type ParsedArgs = { ok: true; action: ProposedAction } | { ok: false; error: string };
export type ParsedDismiss = { ok: true; dismiss: DismissDecision } | { ok: false; error: string };
export type ParsedDelegate = { ok: true; delegate: DelegateRequest } | { ok: false; error: string };

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

function parseJson(argumentsJson: string): { ok: true; raw: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, raw: JSON.parse(argumentsJson) as unknown };
  } catch {
    return { ok: false, error: 'arguments were not valid JSON' };
  }
}

/** Parse the model's control_device arguments JSON string. Never throws. */
export function parseControlDeviceArgs(argumentsJson: string): ParsedArgs {
  const json = parseJson(argumentsJson);
  if (!json.ok) return { ok: false, error: json.error };
  let raw = json.raw;
  // A populated `light` object unambiguously identifies the allowlisted light
  // domain. Realtime occasionally omits the redundant domain field when
  // emitting several parallel per-light calls; normalize only that safe case.
  if (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    !('domain' in raw) &&
    'light' in raw &&
    raw.light !== null &&
    typeof raw.light === 'object' &&
    !Array.isArray(raw.light)
  ) {
    raw = { ...raw, domain: 'light' };
  }
  const parsed = ArgsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  return { ok: true, action: parsed.data };
}

/** Parse the model's dismiss arguments JSON string. Never throws. */
export function parseDismissArgs(argumentsJson: string): ParsedDismiss {
  const json = parseJson(argumentsJson);
  if (!json.ok) return { ok: false, error: json.error };
  const parsed = DismissSchema.safeParse(json.raw);
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  return { ok: true, dismiss: parsed.data };
}

/** Parse the model's delegate arguments JSON string. Never throws. */
export function parseDelegateArgs(argumentsJson: string): ParsedDelegate {
  const json = parseJson(argumentsJson);
  if (!json.ok) return { ok: false, error: json.error };
  const parsed = DelegateSchema.safeParse(json.raw);
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  return { ok: true, delegate: parsed.data };
}
