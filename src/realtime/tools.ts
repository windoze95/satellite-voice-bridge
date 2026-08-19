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

export interface ProposedAction {
  action: ControlAction;
  domain: ControlDomain;
  target: string;
  area: string | null;
  value: number | string | null;
}

/** Tool definition sent in session.update (GA Realtime shape). */
export const CONTROL_DEVICE_TOOL = {
  type: 'function',
  name: 'control_device',
  description:
    'Control a smart-home device, group, or scene. Call this whenever the user wants something in the house changed. ' +
    'target is the device/group name as spoken (for whole-group commands use the domain plural, e.g. "lights"); ' +
    'area is a room/area name exactly as listed in HOUSE, or null when none was stated or implied; ' +
    'value is a percent 0-100 for brightness/speed/volume/position, or degrees for temperature.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...CONTROL_ACTIONS] },
      domain: { type: 'string', enum: [...CONTROL_DOMAINS] },
      target: { type: 'string', description: "Device or group as spoken, e.g. 'ceiling fan', 'lights', 'front door'" },
      area: { type: ['string', 'null'], description: 'Area name from HOUSE if stated or implied; null otherwise' },
      value: { type: ['number', 'string', 'null'], description: 'Percent 0-100, or temperature in degrees, or null' },
    },
    required: ['action', 'domain', 'target'],
  },
} as const;

const ArgsSchema = z
  .object({
    action: z.enum(CONTROL_ACTIONS),
    domain: z.enum(CONTROL_DOMAINS),
    target: z.string().min(1),
    area: z.union([z.string(), z.null()]).default(null),
    value: z.union([z.number(), z.string(), z.null()]).default(null),
  })
  .strict();

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
