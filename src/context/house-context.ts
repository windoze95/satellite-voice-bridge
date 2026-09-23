// Registry cache → the Realtime session instructions: role, rules, and a
// compact HOUSE map. Output is deterministically ordered so identical registries
// produce identical prompts (prompt-cache friendly).
import type { PolicyConfig } from '../config.js';
import { displayName, effectiveAreaId, type RegistryCache } from '../ha/registry.js';
import { normalize } from '../policy/resolve.js';

const RULES = `You are the voice of a private smart home. You hear short spoken commands, and you answer by calling exactly one tool — never by talking. Nothing you write is ever spoken aloud: there is no speaker. The only thing the user perceives is the house changing.

Choosing a tool (you must call one):
- control_device — the user wants something in the house to change. This is the common case. Prefer it whenever a reasonable person in the room would have reached for a light switch.
- dismiss — the utterance was not a command aimed at you. The wake word fires on ordinary conversation; people talk near this device all day. Dismissing costs the user one repeat, while acting on overheard speech costs their trust, so dismiss whenever the utterance was not addressed to you.
- delegate — the request is real but needs more thought than you should spend: several rooms at once, every light doing something different, or anything where you would otherwise be guessing. Delegating is a good outcome, not a failure.

Reading the user:
- Set tone on every call from HOW it was said — pace, volume, warmth, breathiness — not from the words. A command murmured late at night and the same words barked across a room want different light, and tone is the only way the house can tell.
- Take the hint. "Hit the lights", "kill it in here", "it's too bright" are commands. Act on what was meant, not on whether a particular verb was used.
- Requests can be implied by mood. If someone describes a feeling, an activity, or an atmosphere — including irreverent or adult wording — treat it as a lighting request and pick the light.mood that fits. Never moralize, never refuse a harmless lighting request over its wording, and never ask a question: replies are logged, not spoken, so nobody can hear or answer one.

Lighting:
- For a feeling or a style, set light.mood and let the house render it: intimate, romantic, cozy, focus, clinical, party, cinema, wake, wind_down, normal. It knows which bulbs exist in that room and what each one can do — you do not have to choose colours per bulb, and you should not.
- For an appearance the user named exactly ("purple", "60 percent", "warm white", "over five seconds"), use the explicit fields instead: rgb_color, color_temp_kelvin, brightness_pct, brightness_step_pct, effect, transition_seconds, flash. Named colours map to their conventional sRGB values; "warm" is about 2700 K and "daylight" about 6500 K. Never pass a colour name as a string.
- light.mood is mutually exclusive with rgb_color, color_temp_kelvin, and effect. So are those three with each other. brightness_pct and brightness_step_pct are mutually exclusive.
- Relative changes ("brighter", "dim it a bit") use brightness_step_pct with a sensible non-zero magnitude. A qualitative request is specified enough to act on.
- "Make it dark" means turn_off unless the wording implies dim-but-on. "Turn off the effect" or "stop the effect" keeps the lights on with effect "off".
- Only use an effect name that HOUSE advertises for that area.

Targeting:
- Use ONLY area names, area aliases, and device names from HOUSE. An indented "aliases:" line lists the spoken aliases for the canonical name on the AREA line above it. Set area to the canonical AREA name exactly as written; never put alias text in the area value. If one alias is listed under several AREAs, pass the alias through unchanged so policy can resolve the whole set. Set area to null only when no area was stated or implied.
- "[area] lights" means all lights in that area: target "lights" with that area. Do not substitute a similarly named device or group.
- target is the device or group as spoken; for whole-group commands use the domain plural.
- If the request names something absent from HOUSE, delegate rather than inventing a device, area, or scene.

Refusals are not yours to make. A locked door, an alarm panel, or anything else you are unsure is permitted still gets a control_device call — the house authorizes it separately and logs the outcome. Your job is to say what was asked for, accurately.`;

interface LightCapabilities {
  brightness: boolean;
  rgb: boolean;
  minKelvin: number | null;
  maxKelvin: number | null;
  effects: Set<string>;
  flash: boolean;
  transition: boolean;
}

interface IndividualLightCapabilities {
  rgb: Set<string>;
  effects: Set<string>;
  temperature: Set<string>;
}

const BRIGHTNESS_MODES = new Set(['brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww', 'white']);
const COLOR_MODES = new Set(['hs', 'xy', 'rgb', 'rgbw', 'rgbww']);
const LIGHT_FEATURE_EFFECT = 4;
const LIGHT_FEATURE_FLASH = 8;
const LIGHT_FEATURE_TRANSITION = 32;
const DEFAULT_MIN_KELVIN = 2000;
const DEFAULT_MAX_KELVIN = 6535;

function newLightCapabilities(): LightCapabilities {
  return {
    brightness: false,
    rgb: false,
    minKelvin: null,
    maxKelvin: null,
    effects: new Set<string>(),
    flash: false,
    transition: false,
  };
}

function newIndividualLightCapabilities(): IndividualLightCapabilities {
  return { rgb: new Set<string>(), effects: new Set<string>(), temperature: new Set<string>() };
}

function addLightCapabilities(capabilities: LightCapabilities, attributes: Record<string, unknown>): void {
  const modes = Array.isArray(attributes.supported_color_modes)
    ? attributes.supported_color_modes.filter((mode): mode is string => typeof mode === 'string')
    : [];
  capabilities.brightness ||= modes.some((mode) => BRIGHTNESS_MODES.has(mode));
  const supportsColor = modes.some((mode) => COLOR_MODES.has(mode));
  capabilities.rgb ||= supportsColor;

  if (modes.includes('color_temp')) {
    const minKelvin = attributes.min_color_temp_kelvin;
    const maxKelvin = attributes.max_color_temp_kelvin;
    if (typeof minKelvin === 'number' && Number.isFinite(minKelvin)) {
      capabilities.minKelvin =
        capabilities.minKelvin === null ? minKelvin : Math.max(capabilities.minKelvin, minKelvin);
    }
    if (typeof maxKelvin === 'number' && Number.isFinite(maxKelvin)) {
      capabilities.maxKelvin =
        capabilities.maxKelvin === null ? maxKelvin : Math.min(capabilities.maxKelvin, maxKelvin);
    }
  } else if (supportsColor) {
    // Home Assistant converts Kelvin input to a supported color space.
    capabilities.minKelvin = capabilities.minKelvin === null
      ? DEFAULT_MIN_KELVIN
      : Math.max(capabilities.minKelvin, DEFAULT_MIN_KELVIN);
    capabilities.maxKelvin = capabilities.maxKelvin === null
      ? DEFAULT_MAX_KELVIN
      : Math.min(capabilities.maxKelvin, DEFAULT_MAX_KELVIN);
  }

  const features = attributes.supported_features;
  if (
    typeof features === 'number' &&
    Number.isInteger(features) &&
    (features & LIGHT_FEATURE_EFFECT) !== 0 &&
    Array.isArray(attributes.effect_list)
  ) {
    for (const effect of attributes.effect_list) {
      if (typeof effect === 'string' && effect.length > 0) capabilities.effects.add(effect);
    }
  }

  if (typeof features === 'number' && Number.isInteger(features)) {
    capabilities.flash ||= (features & LIGHT_FEATURE_FLASH) !== 0;
    capabilities.transition ||= (features & LIGHT_FEATURE_TRANSITION) !== 0;
  }
}

function addActionableLightCapabilities(
  capabilities: LightCapabilities,
  cache: RegistryCache,
  entityId: string,
  seen = new Set<string>(),
): void {
  if (seen.has(entityId)) return;
  seen.add(entityId);
  const state = cache.statesById.get(entityId);
  if (!state) return;
  const members = Array.isArray(state.attributes.entity_id)
    ? state.attributes.entity_id.filter(
        (member): member is string => typeof member === 'string' && member.startsWith('light.'),
      )
    : [];
  if (members.length > 0) {
    for (const member of members) addActionableLightCapabilities(capabilities, cache, member, seen);
    return;
  }
  if (state.state !== 'unavailable' && state.state !== 'unknown') {
    addLightCapabilities(capabilities, state.attributes);
  }
}

function renderLightCapabilities(capabilities: LightCapabilities | undefined): string | null {
  if (!capabilities) return null;
  const controls: string[] = [];
  if (capabilities.brightness) {
    controls.push('light.brightness_pct=0..100');
    controls.push('light.brightness_step_pct=-100..100(nonzero)');
  }
  if (capabilities.rgb) controls.push('light.rgb_color=[r,g,b]');
  if (
    capabilities.minKelvin !== null &&
    capabilities.maxKelvin !== null &&
    capabilities.minKelvin <= capabilities.maxKelvin
  ) {
    controls.push(`light.color_temp_kelvin=${capabilities.minKelvin}..${capabilities.maxKelvin}`);
  }
  if (capabilities.effects.size > 0) {
    controls.push(`light.effect=${[...capabilities.effects].sort((a, b) => a.localeCompare(b)).join('|')}`);
  }
  if (capabilities.flash) controls.push('light.flash=short|long');
  if (capabilities.transition) controls.push('light.transition_seconds=0..6553');
  return controls.length > 0 ? controls.join('; ') : null;
}

/** Which domains get advertised to the model (green + yellow; red stays unlisted). */
export function advertisedDomains(cfg: PolicyConfig): string[] {
  return [...cfg.tiers.green, ...cfg.tiers.yellow];
}

export function buildHouseMap(cache: RegistryCache, cfg: PolicyConfig): string {
  const domains = advertisedDomains(cfg);
  const byArea = new Map<string | null, Map<string, string[]>>();
  const lightCapabilitiesByArea = new Map<string | null, LightCapabilities>();
  const individualLightCapabilitiesByArea = new Map<string | null, IndividualLightCapabilities>();

  const entityIds = [...cache.entitiesById.keys()].sort();
  for (const entityId of entityIds) {
    const entry = cache.entitiesById.get(entityId);
    if (!entry) continue;
    const domain = entityId.split('.', 1)[0] ?? '';
    if (!domains.includes(domain)) continue;
    if (entry.disabled_by !== null || entry.hidden_by !== null) continue;
    if (entry.entity_category !== null && entry.entity_category !== undefined) continue;

    const areaId = effectiveAreaId(cache, entityId);
    const areaMap = byArea.get(areaId) ?? new Map<string, string[]>();
    byArea.set(areaId, areaMap);
    const list = areaMap.get(domain) ?? [];
    areaMap.set(domain, list);

    const aliases = entry.aliases ?? [];
    const name = displayName(cache, entityId);
    list.push(name + (aliases.length > 0 ? ` (aka ${aliases.join(', ')})` : ''));

    if (domain === 'light') {
      const capabilities = lightCapabilitiesByArea.get(areaId) ?? newLightCapabilities();
      lightCapabilitiesByArea.set(areaId, capabilities);
      addActionableLightCapabilities(capabilities, cache, entityId);

      const state = cache.statesById.get(entityId);
      const members = Array.isArray(state?.attributes.entity_id)
        ? state.attributes.entity_id.filter((member): member is string => typeof member === 'string')
        : [];
      if (state && state.state !== 'unavailable' && state.state !== 'unknown' && members.length === 0) {
        const modes = Array.isArray(state.attributes.supported_color_modes)
          ? state.attributes.supported_color_modes.filter((mode): mode is string => typeof mode === 'string')
          : [];
        const individual = individualLightCapabilitiesByArea.get(areaId) ?? newIndividualLightCapabilities();
        individualLightCapabilitiesByArea.set(areaId, individual);
        const supportsColor = modes.some((mode) => COLOR_MODES.has(mode));
        if (supportsColor) individual.rgb.add(name);
        if (supportsColor || modes.includes('color_temp')) individual.temperature.add(name);
        const features = state.attributes.supported_features;
        if (
          typeof features === 'number' &&
          Number.isInteger(features) &&
          (features & LIGHT_FEATURE_EFFECT) !== 0 &&
          Array.isArray(state.attributes.effect_list) &&
          state.attributes.effect_list.some((effect) => typeof effect === 'string' && effect !== 'off')
        ) {
          individual.effects.add(name);
        }
      }
    }
  }

  const lines: string[] = ['HOUSE:'];
  const areas = [...cache.areasById.values()].sort((a, b) => a.name.localeCompare(b.name));
  const renderArea = (
    label: string,
    areaMap: Map<string, string[]> | undefined,
    aliases: string[] = [],
    lightCapabilities?: LightCapabilities,
    individualLightCapabilities?: IndividualLightCapabilities,
  ): void => {
    if (!areaMap || areaMap.size === 0) return;
    lines.push(`AREA: ${label}`);
    if (aliases.length > 0) lines.push(`  aliases: ${aliases.join(', ')}`);
    for (const domain of [...areaMap.keys()].sort()) {
      const names = areaMap.get(domain) ?? [];
      lines.push(`  ${domain}: ${names.sort((a, b) => a.localeCompare(b)).join('; ')}`);
      if (domain === 'light') {
        const capabilities = renderLightCapabilities(lightCapabilities);
        if (capabilities) lines.push(`    capabilities: ${capabilities}`);
        if (individualLightCapabilities && individualLightCapabilities.rgb.size > 0) {
          lines.push(`    individual RGB lights: ${[...individualLightCapabilities.rgb].sort().join('; ')}`);
        }
        if (individualLightCapabilities && individualLightCapabilities.effects.size > 0) {
          lines.push(`    individual effect lights: ${[...individualLightCapabilities.effects].sort().join('; ')}`);
        }
        if (individualLightCapabilities && individualLightCapabilities.temperature.size > 0) {
          lines.push(`    individual temperature lights: ${[...individualLightCapabilities.temperature].sort().join('; ')}`);
        }
      }
    }
  };
  for (const area of areas) {
    const aliases = Object.entries(cfg.areaAliases)
      .filter(([alias, areaNames]) =>
        alias.trim().length > 0 && areaNames.some((areaName) => normalize(areaName) === normalize(area.name)),
      )
      .map(([alias]) => alias.trim())
      .sort((a, b) => a.localeCompare(b));
    renderArea(
      area.name,
      byArea.get(area.area_id),
      aliases,
      lightCapabilitiesByArea.get(area.area_id),
      individualLightCapabilitiesByArea.get(area.area_id),
    );
  }
  renderArea(
    '(no area)',
    byArea.get(null),
    [],
    lightCapabilitiesByArea.get(null),
    individualLightCapabilitiesByArea.get(null),
  );
  return lines.join('\n');
}

export function buildInstructions(cache: RegistryCache, cfg: PolicyConfig, originArea?: string): string {
  const parts = [RULES, '', buildHouseMap(cache, cfg)];
  if (originArea) {
    parts.push('', `The device that heard this command is in: ${originArea}. When no area is stated, prefer devices there.`);
  }
  return parts.join('\n');
}
