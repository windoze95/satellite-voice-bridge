// Pure light capability planning. Home Assistant silently drops unsupported
// light service fields; the bridge instead selects concrete capable leaf lights
// (or refuses) before the fixed executor allowlist is allowed to run.
import { displayName, type RegistryCache } from '../ha/registry.js';

const FEATURE_EFFECT = 4;
const FEATURE_FLASH = 8;
const FEATURE_TRANSITION = 32;
const COLOR_MODES = new Set(['hs', 'xy', 'rgb', 'rgbw', 'rgbww']);
const DEFAULT_MIN_KELVIN = 2000;
const DEFAULT_MAX_KELVIN = 6535;

export type LightCapabilityPlan =
  | {
      ok: true;
      entityIds: string[];
      serviceData: Record<string, unknown>;
      skippedEntityIds: string[];
      notes: string[];
    }
  | {
      ok: false;
      reason: 'no_available_targets' | 'unsupported_light_capability' | 'unsupported_effect' | 'no_common_color_temperature';
      message: string;
    };

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function groupMembers(cache: RegistryCache, entityId: string): string[] {
  return stringList(cache.statesById.get(entityId)?.attributes.entity_id)
    .filter((member) => member.startsWith('light.'))
    .sort();
}

/** Recursively replace HA light groups with their leaf members and deduplicate. */
export function flattenLightTargets(cache: RegistryCache, entityIds: string[]): string[] {
  const leaves = new Set<string>();
  const expanded = new Set<string>();
  const active = new Set<string>();

  const visit = (entityId: string): void => {
    if (active.has(entityId)) return;
    const members = groupMembers(cache, entityId);
    if (members.length === 0) {
      leaves.add(entityId);
      return;
    }
    if (expanded.has(entityId)) return;
    expanded.add(entityId);
    active.add(entityId);
    for (const member of members) visit(member);
    active.delete(entityId);
  };

  for (const entityId of [...entityIds].sort()) visit(entityId);
  return [...leaves].sort();
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function colorModes(cache: RegistryCache, entityId: string): string[] {
  return stringList(cache.statesById.get(entityId)?.attributes.supported_color_modes).map(normalized);
}

function supportedFeatures(cache: RegistryCache, entityId: string): number {
  const value = cache.statesById.get(entityId)?.attributes.supported_features;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function supportsBrightness(cache: RegistryCache, entityId: string): boolean {
  return colorModes(cache, entityId).some((mode) => mode !== 'onoff' && mode !== 'unknown');
}

function supportsColor(cache: RegistryCache, entityId: string): boolean {
  return colorModes(cache, entityId).some((mode) => COLOR_MODES.has(mode));
}

function supportsColorTemperature(cache: RegistryCache, entityId: string): boolean {
  const modes = colorModes(cache, entityId);
  return modes.includes('color_temp') || modes.some((mode) => COLOR_MODES.has(mode));
}

function effects(cache: RegistryCache, entityId: string): string[] {
  if ((supportedFeatures(cache, entityId) & FEATURE_EFFECT) === 0) return [];
  return stringList(cache.statesById.get(entityId)?.attributes.effect_list);
}

function findEffect(cache: RegistryCache, entityId: string, wanted: string): string | null {
  const wantedNormalized = normalized(wanted);
  return effects(cache, entityId).find((effect) => normalized(effect) === wantedNormalized) ?? null;
}

function exactEffectCohort(
  matches: Array<{ entityId: string; effect: string }>,
  requested: string,
): { entityIds: string[]; effect: string } | null {
  const groups = new Map<string, string[]>();
  for (const match of matches) {
    const entityIds = groups.get(match.effect) ?? [];
    entityIds.push(match.entityId);
    groups.set(match.effect, entityIds);
  }
  const best = [...groups.entries()].sort(([aEffect, aIds], [bEffect, bIds]) => {
    if (aIds.length !== bIds.length) return bIds.length - aIds.length;
    if (aEffect === requested && bEffect !== requested) return -1;
    if (bEffect === requested && aEffect !== requested) return 1;
    return aEffect < bEffect ? -1 : aEffect > bEffect ? 1 : 0;
  })[0];
  return best ? { effect: best[0], entityIds: best[1].sort() } : null;
}

function effectPlan(
  cache: RegistryCache,
  entityIds: string[],
  requested: string,
): { entityIds: string[]; effect: string } | null {
  const matches = entityIds
    .map((entityId) => ({ entityId, effect: findEffect(cache, entityId, requested) }))
    .filter((match): match is { entityId: string; effect: string } => match.effect !== null);
  return exactEffectCohort(matches, requested);
}

function available(cache: RegistryCache, entityId: string): boolean {
  const state = cache.statesById.get(entityId)?.state;
  return state !== undefined && state !== 'unavailable' && state !== 'unknown';
}

function numberAttribute(cache: RegistryCache, entityId: string, name: string, fallback: number): number {
  const value = cache.statesById.get(entityId)?.attributes[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function names(cache: RegistryCache, entityIds: string[]): string {
  return entityIds.map((id) => `${displayName(cache, id)} (${id})`).join(', ');
}

/**
 * Validate and specialize an already-allowlisted light service call.
 * Calls without advanced service data retain their original target behavior.
 */
export function planLightCapabilities(
  cache: RegistryCache,
  entityIds: string[],
  serviceData: Record<string, unknown>,
  service = 'turn_on',
): LightCapabilityPlan {
  const capabilityKeys = [
    'brightness_pct',
    'brightness_step_pct',
    'rgb_color',
    'color_temp_kelvin',
    'effect',
    'transition',
    'flash',
  ];
  if (!capabilityKeys.some((key) => key in serviceData)) {
    return { ok: true, entityIds, serviceData, skippedEntityIds: [], notes: [] };
  }

  const leaves = flattenLightTargets(cache, entityIds);
  let candidates = leaves.filter((entityId) => available(cache, entityId));
  const skipped = new Set(leaves.filter((entityId) => !available(cache, entityId)));
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'no_available_targets',
      message: `No selected lights are currently available${leaves.length > 0 ? `: ${names(cache, leaves)}` : ''}`,
    };
  }

  const retain = (supports: (entityId: string) => boolean): void => {
    const next = candidates.filter(supports);
    for (const entityId of candidates) if (!next.includes(entityId)) skipped.add(entityId);
    candidates = next;
  };

  const notes: string[] = [];
  const requested: string[] = [];
  if ('brightness_pct' in serviceData || 'brightness_step_pct' in serviceData) {
    requested.push('brightness');
    retain((entityId) => supportsBrightness(cache, entityId));
  }
  if ('rgb_color' in serviceData) {
    requested.push('color');
    retain((entityId) => supportsColor(cache, entityId));
  }
  if ('color_temp_kelvin' in serviceData) {
    requested.push('color temperature');
    retain((entityId) => supportsColorTemperature(cache, entityId));
  }
  if ('transition' in serviceData) {
    requested.push('transition');
  }
  if ('flash' in serviceData) {
    requested.push('flash');
    if (service === 'turn_off') {
      const immediate = candidates.filter((entityId) => (supportedFeatures(cache, entityId) & FEATURE_FLASH) === 0);
      if (immediate.length > 0) {
        notes.push(`flash unsupported (base turn-off still applies): ${names(cache, immediate)}`);
      }
    } else {
      retain((entityId) => (supportedFeatures(cache, entityId) & FEATURE_FLASH) !== 0);
    }
  }

  const plannedData = { ...serviceData };
  if (typeof serviceData.effect === 'string') {
    requested.push(`effect "${serviceData.effect}"`);
    const plannedEffect = effectPlan(cache, candidates, serviceData.effect);
    if (!plannedEffect) {
      const availableEffects = [...new Set(candidates.flatMap((entityId) => effects(cache, entityId)).map(normalized))].sort();
      return {
        ok: false,
        reason: 'unsupported_effect',
        message:
          `No available selected lights support effect "${serviceData.effect}"` +
          (availableEffects.length > 0 ? `. Available effects: ${availableEffects.join(', ')}` : ''),
      };
    }
    const capable = new Set(plannedEffect.entityIds);
    for (const entityId of candidates) if (!capable.has(entityId)) skipped.add(entityId);
    candidates = plannedEffect.entityIds;
    plannedData.effect = plannedEffect.effect;
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'unsupported_light_capability',
      message: `No available selected lights support ${requested.join(' with ')}`,
    };
  }

  if ('transition' in serviceData) {
    const immediate = candidates.filter((entityId) => (supportedFeatures(cache, entityId) & FEATURE_TRANSITION) === 0);
    if (immediate.length > 0) {
      notes.push(`transition unsupported (base control still applies immediately): ${names(cache, immediate)}`);
    }
  }

  if (typeof serviceData.color_temp_kelvin === 'number') {
    const min = Math.max(
      ...candidates.map((entityId) => numberAttribute(cache, entityId, 'min_color_temp_kelvin', DEFAULT_MIN_KELVIN)),
    );
    const max = Math.min(
      ...candidates.map((entityId) => numberAttribute(cache, entityId, 'max_color_temp_kelvin', DEFAULT_MAX_KELVIN)),
    );
    if (min > max) {
      return {
        ok: false,
        reason: 'no_common_color_temperature',
        message: 'The selected lights do not share a common color-temperature range',
      };
    }
    const requestedKelvin = Math.round(serviceData.color_temp_kelvin);
    const kelvin = Math.min(max, Math.max(min, requestedKelvin));
    plannedData.color_temp_kelvin = kelvin;
    if (kelvin !== requestedKelvin) notes.push(`color temperature clamped to ${kelvin} K`);
  }

  const skippedEntityIds = [...skipped].sort();
  if (skippedEntityIds.length > 0) notes.push(`skipped unsupported or unavailable: ${names(cache, skippedEntityIds)}`);
  return {
    ok: true,
    entityIds: [...candidates].sort(),
    serviceData: plannedData,
    skippedEntityIds,
    notes,
  };
}
