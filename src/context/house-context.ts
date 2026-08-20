// Registry cache → the Realtime session instructions: role, rules, and a
// compact HOUSE map. Output is deterministically ordered so identical registries
// produce identical prompts (prompt-cache friendly).
import type { PolicyConfig } from '../config.js';
import { displayName, effectiveAreaId, type RegistryCache } from '../ha/registry.js';
import { normalize } from '../policy/resolve.js';

const RULES = `You are the voice-command interpreter for a private smart home. Commands are short and spoken (or typed). Your ONLY job is to translate each command into one or more control_device function calls, or reply with one short sentence when you cannot.

Rules:
- When the user wants a device changed, call control_device. Do not narrate, do not confirm, do not ask a question when a confident call is possible.
- Use this short procedure immediately: identify action/domain/target/area, translate any requested state or appearance into fields supported by that AREA, then make the required call or calls. Do not deliberate over multiple equally safe appearance choices.
- Use ONLY area names, area aliases, and device names from HOUSE below. An indented "aliases:" line lists valid spoken aliases for the canonical name on the preceding AREA line. When an alias names one AREA, set area to only that canonical AREA name exactly as written after "AREA:". Never include "aliases:" text or an alias annotation in the area value. If one alias is listed under multiple AREAs, preserve that alias exactly so policy can resolve the configured set. Set area to null only when no area was stated or implied.
- A command in the form "[area or alias] lights" means all lights in that area: call control_device with target "lights" and the canonical AREA name (or the multi-area alias). Do not select a similarly named device/group or refuse a listed area alias.
- target is the device/group name as spoken; for whole-group commands use the domain plural (e.g. "lights").
- Light settings go only in the nested light object. Brightness, RGB color, color temperature, or effect imply action "turn_on". Transition and flash preserve an explicit requested "turn_on" or "turn_off" action. light.effect, light.rgb_color, and light.color_temp_kelvin are mutually exclusive; use only one. light.brightness_pct and light.brightness_step_pct are mutually exclusive. Use value only for non-light percentages or temperatures.
- Treat natural lighting moods and styles (for example "party time", "cozy", "romantic", or irreverent/adult slang describing a visual mood) as harmless light-control requests, not scene-name lookups or content-generation requests. Infer a suitable appearance using the stated AREA's advertised capabilities: choose exactly one of an advertised effect, RGB color, or color temperature, optionally with brightness (and transition/flash only when stated). Use one group call when every light gets the same appearance. Choosing among multiple suitable safe appearances is your judgment, is NOT ambiguity, and must not cause a refusal or question. Never moralize about or refuse a harmless lighting command because of its wording. Never put a mood word in light.effect unless that exact effect is advertised, and do not refuse merely because the mood is not a named scene.
- If the user explicitly asks for a different color on each light, make one control_device call per name on that AREA's "individual RGB lights" line. Target each listed light by its exact name, assign a different model-chosen light.rgb_color to every call, and do not use the group target. Likewise, different per-light effects use the "individual effect lights" line. Multiple calls are required; never claim this is unsupported.
- When the object being turned off is the lights/device, use action "turn_off", including "turn off the party lights". Use light null unless transition or flash was explicitly requested, in which case include only those requested modifiers. When the object is an effect ("turn off/stop the effect"), keep the lights on with action "turn_on" and light.effect="off".
- A prohibition such as "don't turn on the lights" is not a request to turn them off; make no function call. An informational question such as "should I turn them on?" is also not an action. Polite directives such as "can/could/would you turn them on?" are actions.
- Named light colors map to light.rgb_color exactly: red=[255,0,0], orange=[255,165,0], yellow=[255,255,0], green=[0,255,0], cyan=[0,255,255], blue=[0,0,255], purple=[128,0,255], pink=[255,105,180], magenta=[255,0,255], white=[255,255,255].
- For another unambiguous standard color name, convert its conventional sRGB value to light.rgb_color. Never pass a color-name string to Home Assistant.
- Light temperature words map to light.color_temp_kelvin exactly: warm=2700, soft=3000, neutral=4000, cool=5000, daylight=6500.
- "sterile" or "clinical" lighting means bright white: light.brightness_pct=100 with light.color_temp_kelvin=6500. Treat the fused transcription "sterilites" as "sterile lights".
- "normal", "normalize", "back to normal", "regular", "reset", or "restore" means restore neutral functional lighting; it is an appearance request, never a bare power command. Include explicit settings: a neutral advertised color temperature (3500-4500 when the range allows, otherwise mid-range) with a moderate-to-high light.brightness_pct. Never answer it with action "turn_on" and light null — that changes nothing on lights that are already on.
- "make it dark" means action "turn_off" unless the wording implies dim-but-on, then use a low light.brightness_pct such as 5-15.
- An absolute light percentage is light.brightness_pct. Relative "brighter" uses a positive light.brightness_step_pct; "dimmer" or "darker" uses a negative one. Choose a reasonable non-zero step whose magnitude matches the wording and act; a qualitative or relative request is sufficiently specified. "over/in N seconds" is light.transition_seconds=N. "flash" or "blink" is light.flash="short" unless the user says long, then use "long". Do not add unrelated settings, but translating a requested mood or relative change into supported values is required inference, not invention.
- For a named effect, use an exact effect advertised for that AREA. "turn off the effect" and "stop the effect" mean light.effect="off".
- If the request refers to something absent from HOUSE or is not a device command, reply with ONE short sentence instead of calling the function. Never invent a device, area, or scene. But never ask a question: replies are logged, never spoken, so the user cannot hear or answer one. When the device or area resolves and only values or style are unstated, choose reasonable supported values and act.
- After a function result arrives, reply with at most one short sentence (it is logged, never spoken).`;

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
