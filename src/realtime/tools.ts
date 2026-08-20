// The control_device contract — single source of truth for the model↔policy boundary.
// RED verbs/domains are deliberately IN the enums: the model must be able to express
// them so the policy engine can refuse deterministically and loggably. Safety never
// relies on the model censoring itself.
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

export type ControlAction = (typeof CONTROL_ACTIONS)[number];
export type ControlDomain = (typeof CONTROL_DOMAINS)[number];

export interface LightOptions {
  brightness_pct: number | null;
  rgb_color: [number, number, number] | null;
  color_temp_kelvin: number | null;
  effect: string | null;
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
}

/** Tool definition sent in session.update (GA Realtime shape). */
export const CONTROL_DEVICE_TOOL = {
  type: 'function',
  name: 'control_device',
  description:
    'Control a smart-home device, group, or scene. Call this whenever the user wants something in the house changed. ' +
    'target is the device/group name as spoken (for whole-group commands use the domain plural, e.g. "lights"); ' +
    'area is a room/area name exactly as listed in HOUSE, or null when none was stated or implied; ' +
    'value is for non-light percentages or temperatures; put every light setting in light; ' +
    'light contains optional light-only settings. Use rgb_color for both named and explicit RGB colors.',
  parameters: {
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
        description: 'Light-only settings, or null. Color, color temperature, and effect are mutually exclusive.',
        properties: {
          brightness_pct: { type: ['number', 'null'], minimum: 0, maximum: 100 },
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
          transition_seconds: { type: ['number', 'null'], minimum: 0, maximum: 6553 },
          flash: { type: ['string', 'null'], enum: ['short', 'long', null] },
        },
        additionalProperties: false,
      },
    },
    required: ['action', 'domain', 'target'],
    additionalProperties: false,
  },
} as const;

const NullableNumber = z.union([z.number().finite(), z.null()]);
const LightOptionsSchema = z
  .object({
    brightness_pct: NullableNumber.refine((v) => v === null || (v >= 0 && v <= 100), 'must be between 0 and 100').default(null),
    rgb_color: z
      .union([z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]), z.null()])
      .default(null),
    color_temp_kelvin: NullableNumber.refine((v) => v === null || v >= 1, 'must be at least 1').default(null),
    effect: z.union([z.string().trim().min(1).max(100), z.null()]).default(null),
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

    const modes = [light.rgb_color, light.color_temp_kelvin, light.effect].filter((value) => value !== null);
    if (modes.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['light'],
        message: 'rgb_color, color_temp_kelvin, and effect are mutually exclusive',
      });
    }

    if (populated && args.action !== 'turn_on' && args.action !== 'set' && args.action !== 'turn_off') {
      ctx.addIssue({ code: 'custom', path: ['action'], message: `${args.action} cannot include light settings` });
    }
    if (
      args.action === 'turn_off' &&
      (light.brightness_pct !== null || light.rgb_color !== null || light.color_temp_kelvin !== null || light.effect !== null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['light'],
        message: 'turn_off only accepts transition_seconds and flash light settings',
      });
    }
  });

export type ParsedArgs = { ok: true; action: ProposedAction } | { ok: false; error: string };

/** Parse the model's arguments JSON string. Never throws. */
export function parseControlDeviceArgs(argumentsJson: string): ParsedArgs {
  let raw: unknown;
  try {
    raw = JSON.parse(argumentsJson);
  } catch {
    return { ok: false, error: 'arguments were not valid JSON' };
  }
  const parsed = ArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, action: parsed.data };
}
