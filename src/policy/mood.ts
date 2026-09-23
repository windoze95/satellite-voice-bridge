// The lighting composer: a named mood plus a tone become concrete per-light
// settings, locally and deterministically.
//
// Why this is not the model's job. Asking a low-latency voice model to invent an
// RGB triple for every bulb in a room means it must hold the room's inventory,
// each bulb's capabilities, and a colour scheme in its head at once — and when it
// got that wrong the bridge could only reject the call and ask again, paying a
// second round trip to the same model that had just failed. The division here is
// the one each side is actually good at: the model recognizes *which mood* is
// being asked for (and hears how it was asked), the bridge knows exactly which
// bulbs exist and what each can do.
//
// Costs no tokens and no round trip. Every value is capability-checked before it
// reaches the executor allowlist, exactly as a spoken appearance request is.
import type { MoodOverrides } from '../config.js';
import { displayName, type RegistryCache } from '../ha/registry.js';
import type { Mood, Tone } from '../realtime/tools.js';
import {
  available,
  flattenLightTargets,
  kelvinRange,
  supportsBrightness,
  supportsColor,
  supportsColorTemperature,
} from './light-capabilities.js';

/**
 * What a light is FOR, which is what decides its part in a mood.
 *
 * - `key`   — the room's general illumination (ceilings, mains, the big group)
 * - `accent` — colour-capable character lighting (strips, lamps, sconces, fan globes)
 * - `utility` — task lighting nobody sets a mood with (closets, cabinets, stairs)
 */
export type LightRole = 'key' | 'accent' | 'utility';

export interface MoodLayer {
  /** Preferred appearance for colour-capable lights. */
  rgb: [number, number, number] | null;
  /** Fallback for colour-temperature-only lights, and for `rgb: null` layers. */
  kelvin: number | null;
  brightnessPct: number;
  /** This role stays dark for this mood. */
  off: boolean;
}

export type MoodRecipe = Record<LightRole, MoodLayer>;

const layer = (
  brightnessPct: number,
  colour: { rgb?: [number, number, number]; kelvin?: number } = {},
): MoodLayer => ({
  rgb: colour.rgb ?? null,
  kelvin: colour.kelvin ?? null,
  brightnessPct,
  off: false,
});

const OFF: MoodLayer = { rgb: null, kelvin: null, brightnessPct: 0, off: true };

/**
 * The house style. Warm ends sit near 2000–2700 K, working light near 4000 K,
 * and anything meant to read as "clinical" goes to the top of the range.
 * Overridable per-mood in voicebridge.yaml, so taste is config, not code.
 */
export const MOOD_RECIPES: Record<Mood, MoodRecipe> = {
  intimate: {
    key: layer(8, { kelvin: 2200 }),
    accent: layer(14, { rgb: [255, 92, 40], kelvin: 2000 }),
    utility: OFF,
  },
  romantic: {
    key: layer(12, { kelvin: 2200 }),
    accent: layer(20, { rgb: [255, 60, 80], kelvin: 2100 }),
    utility: OFF,
  },
  cozy: {
    key: layer(35, { kelvin: 2500 }),
    accent: layer(40, { rgb: [255, 140, 60], kelvin: 2400 }),
    utility: layer(20, { kelvin: 2700 }),
  },
  focus: {
    key: layer(90, { kelvin: 4500 }),
    accent: layer(60, { kelvin: 4000 }),
    utility: layer(70, { kelvin: 4000 }),
  },
  clinical: {
    key: layer(100, { kelvin: 6500 }),
    accent: layer(100, { kelvin: 6500 }),
    utility: layer(100, { kelvin: 6500 }),
  },
  party: {
    key: layer(60, { rgb: [180, 0, 255], kelvin: 2700 }),
    accent: layer(100, { rgb: [0, 140, 255], kelvin: 2700 }),
    utility: OFF,
  },
  cinema: {
    key: OFF,
    accent: layer(10, { rgb: [40, 60, 255], kelvin: 2200 }),
    utility: OFF,
  },
  wake: {
    key: layer(80, { kelvin: 4000 }),
    accent: layer(55, { rgb: [255, 180, 90], kelvin: 3000 }),
    utility: layer(60, { kelvin: 3500 }),
  },
  wind_down: {
    key: layer(25, { kelvin: 2200 }),
    accent: layer(25, { rgb: [255, 120, 50], kelvin: 2200 }),
    utility: layer(15, { kelvin: 2400 }),
  },
  // The "put it back to something functional" mood. Deliberately plain: neutral
  // white at a working level, no colour on anything.
  normal: {
    key: layer(85, { kelvin: 4000 }),
    accent: layer(70, { kelvin: 3500 }),
    utility: layer(70, { kelvin: 4000 }),
  },
};

/**
 * How the utterance was said, folded into how it looks. This is the whole point
 * of carrying tone: "set the mood" murmured and "set the mood" barked should not
 * land on the same brightness. A scale under 1 dims and a negative shift warms.
 */
export const TONE_BIAS: Record<Tone, { brightness: number; kelvin: number }> = {
  neutral: { brightness: 1, kelvin: 0 },
  intimate: { brightness: 0.55, kelvin: -600 },
  hushed: { brightness: 0.6, kelvin: -400 },
  tired: { brightness: 0.6, kelvin: -500 },
  playful: { brightness: 1.05, kelvin: 100 },
  excited: { brightness: 1.15, kelvin: 200 },
  urgent: { brightness: 1.4, kelvin: 700 },
  annoyed: { brightness: 1, kelvin: 0 },
};

const UTILITY_NAME = /\b(closet|pantry|garage|laundry|utility|cabinet|cupboard|toe.?kick|night.?light|stair|step|shelf)\b/i;
const KEY_NAME = /\b(ceiling|overhead|main|downlight|recessed|can|chandelier|pendant|flush)\b/i;
const ACCENT_NAME = /\b(strip|lamp|accent|bias|cove|sconce|fan|globe|backlight|uplight|torchiere|neon|led)\b/i;

/**
 * Name first, capability second. A bulb's colour support says what it *can* do,
 * not what it is for — the office fan globes are RGB but they are still the room's
 * character lighting, and a closet strip is still a closet.
 */
export function classifyLight(cache: RegistryCache, entityId: string): LightRole {
  const name = displayName(cache, entityId);
  if (UTILITY_NAME.test(name)) return 'utility';
  if (KEY_NAME.test(name)) return 'key';
  if (ACCENT_NAME.test(name)) return 'accent';
  // An on/off-only bulb can express nothing but presence, so it is never the
  // thing carrying a mood.
  if (!supportsBrightness(cache, entityId)) return 'utility';
  return supportsColor(cache, entityId) ? 'accent' : 'key';
}

export interface MoodCall {
  service: 'turn_on' | 'turn_off';
  serviceData: Record<string, unknown>;
  entityIds: string[];
}

export type MoodPlan =
  | { ok: true; calls: MoodCall[]; entityIds: string[]; notes: string[] }
  | { ok: false; reason: 'no_available_targets'; message: string };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function applyOverrides(recipe: MoodRecipe, override: MoodOverrides | undefined): MoodRecipe {
  if (!override) return recipe;
  const merged = { ...recipe };
  for (const role of ['key', 'accent', 'utility'] as const) {
    const patch = override[role];
    if (!patch) continue;
    merged[role] = {
      rgb: patch.rgb ?? merged[role].rgb,
      kelvin: patch.kelvin ?? merged[role].kelvin,
      brightnessPct: patch.brightnessPct ?? merged[role].brightnessPct,
      off: patch.off ?? merged[role].off,
    };
  }
  return merged;
}

/**
 * Render one light's share of a layer, keeping only what the bulb can actually
 * do. Home Assistant silently drops unsupported fields, which is how a request
 * ends up looking like it worked while the bulb sits there unchanged.
 */
function settingsFor(
  cache: RegistryCache,
  entityId: string,
  spec: MoodLayer,
  brightnessScale: number,
  kelvinShift: number,
  transitionSeconds: number | null,
): { service: 'turn_on' | 'turn_off'; serviceData: Record<string, unknown> } {
  const withTransition = (data: Record<string, unknown>): Record<string, unknown> =>
    transitionSeconds === null ? data : { ...data, transition: transitionSeconds };

  if (spec.off) return { service: 'turn_off', serviceData: withTransition({}) };

  const data: Record<string, unknown> = {};
  if (spec.rgb !== null && supportsColor(cache, entityId)) {
    data.rgb_color = [...spec.rgb];
  } else if (spec.kelvin !== null && supportsColorTemperature(cache, entityId)) {
    const range = kelvinRange(cache, entityId);
    data.color_temp_kelvin = Math.round(clamp(spec.kelvin + kelvinShift, range.min, range.max));
  }

  if (supportsBrightness(cache, entityId)) {
    // Never scale a mood down to nothing: a light the recipe meant to be on
    // should stay visibly on however quietly it was asked for.
    data.brightness_pct = Math.round(clamp(spec.brightnessPct * brightnessScale, 1, 100));
  }
  return { service: 'turn_on', serviceData: withTransition(data) };
}

/**
 * A mood + the area's lights → grouped, capability-checked service calls.
 *
 * `brightnessPct` overrides the recipe's overall level when the user named one
 * ("something cozy but brighter"), scaling every layer rather than flattening
 * them, so the relationship between key and accent survives.
 */
export function composeMood(
  cache: RegistryCache,
  entityIds: string[],
  mood: Mood,
  tone: Tone,
  opts: {
    brightnessPct?: number | null;
    transitionSeconds?: number | null;
    overrides?: Record<string, MoodOverrides>;
  } = {},
): MoodPlan {
  const recipe = applyOverrides(MOOD_RECIPES[mood], opts.overrides?.[mood]);
  const leaves = flattenLightTargets(cache, entityIds);
  const candidates = leaves.filter((entityId) => available(cache, entityId));
  const notes: string[] = [];

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'no_available_targets',
      message:
        'No selected lights are currently available' +
        (leaves.length > 0 ? `: ${leaves.map((id) => `${displayName(cache, id)} (${id})`).join(', ')}` : ''),
    };
  }
  const unavailable = leaves.filter((entityId) => !available(cache, entityId));
  if (unavailable.length > 0) {
    notes.push(`skipped unavailable: ${unavailable.map((id) => `${displayName(cache, id)} (${id})`).join(', ')}`);
  }

  const bias = TONE_BIAS[tone];
  // A stated brightness replaces the tone's scaling rather than compounding with
  // it — the user said a number, and that outranks how they sounded.
  const brightnessScale =
    typeof opts.brightnessPct === 'number' && Number.isFinite(opts.brightnessPct)
      ? clamp(opts.brightnessPct, 1, 100) / Math.max(1, recipe.key.brightnessPct)
      : bias.brightness;
  const kelvinShift = typeof opts.brightnessPct === 'number' ? 0 : bias.kelvin;

  const roles = new Map<string, LightRole>(candidates.map((entityId) => [entityId, classifyLight(cache, entityId)]));

  // An area of nothing but closets still deserves an answer when asked for a
  // mood. Rather than turning the room off, treat what is there as the accents.
  const litRoles = new Set([...roles.values()].filter((role) => !recipe[role].off));
  if (litRoles.size === 0) {
    const fallback = recipe.accent.off ? recipe.key : recipe.accent;
    if (!fallback.off) {
      for (const entityId of roles.keys()) roles.set(entityId, recipe.accent.off ? 'key' : 'accent');
      notes.push('no key or accent lighting here; applied the mood to what is available');
    }
  }

  const groups = new Map<string, MoodCall>();
  for (const entityId of candidates) {
    const role = roles.get(entityId) ?? 'key';
    const { service, serviceData } = settingsFor(
      cache,
      entityId,
      recipe[role],
      brightnessScale,
      kelvinShift,
      opts.transitionSeconds ?? null,
    );
    const key = `${service}:${JSON.stringify(serviceData)}`;
    const existing = groups.get(key);
    if (existing) existing.entityIds.push(entityId);
    else groups.set(key, { service, serviceData, entityIds: [entityId] });
  }

  const calls = [...groups.values()]
    .map((call) => ({ ...call, entityIds: [...call.entityIds].sort() }))
    // turn_off first, so a room never flashes bright before settling.
    .sort((a, b) => (a.service === b.service ? a.entityIds[0]!.localeCompare(b.entityIds[0]!) : a.service === 'turn_off' ? -1 : 1));

  return { ok: true, calls, entityIds: [...candidates].sort(), notes };
}
