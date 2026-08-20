// Phrase-triggered temporary light flourishes: capture what the lights look
// like, apply a short-lived appearance, then put them back exactly as they were.
//
// Deliberately local and deterministic — the model is never consulted for these
// phrases, so neither a refusal nor a creative reinterpretation can swallow the
// command. Targeting and capability checks still go through the normal policy
// engine, so a flourish can only ever touch lights the model could have touched.
import type { FlourishConfig } from '../config.js';
import type { RegistryCache } from '../ha/registry.js';
import { normalize } from './resolve.js';

const COLOR_MODES = new Set(['hs', 'xy', 'rgb', 'rgbw', 'rgbww']);
/** Home Assistant reports "no effect running" inconsistently across integrations. */
const NO_EFFECT = new Set(['off', 'none', '']);

export interface LightSnapshot {
  entityId: string;
  on: boolean;
  /** Raw 0..255 brightness, as Home Assistant reports and accepts it. */
  brightness: number | null;
  colorTempKelvin: number | null;
  rgbColor: [number, number, number] | null;
  effect: string | null;
  supportsEffect: boolean;
}

export interface RestoreCall {
  service: 'turn_on' | 'turn_off';
  serviceData: Record<string, unknown>;
  entityIds: string[];
}

/** Longest matching phrase wins, so "super gay and horny" beats "super gay". */
export function matchFlourish(utterance: string, flourishes: FlourishConfig[]): FlourishConfig | undefined {
  const text = ` ${normalize(utterance)} `;
  let best: { flourish: FlourishConfig; length: number } | undefined;
  for (const flourish of flourishes) {
    for (const phrase of flourish.phrases) {
      const wanted = normalize(phrase);
      if (wanted.length === 0 || !text.includes(` ${wanted} `)) continue;
      if (!best || wanted.length > best.length) best = { flourish, length: wanted.length };
    }
  }
  return best?.flourish;
}

function numberAttribute(attributes: Record<string, unknown>, name: string): number | null {
  const value = attributes[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rgbAttribute(attributes: Record<string, unknown>): [number, number, number] | null {
  const value = attributes.rgb_color;
  if (!Array.isArray(value) || value.length !== 3) return null;
  const channels = value.filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  if (channels.length !== 3) return null;
  return [Math.round(channels[0]!), Math.round(channels[1]!), Math.round(channels[2]!)];
}

export function snapshotLights(cache: RegistryCache, entityIds: string[]): LightSnapshot[] {
  return entityIds.map((entityId) => {
    const state = cache.statesById.get(entityId);
    const attributes = state?.attributes ?? {};
    const colorMode = typeof attributes.color_mode === 'string' ? attributes.color_mode : null;
    const effect = typeof attributes.effect === 'string' ? attributes.effect : null;
    const supportedModes = Array.isArray(attributes.supported_color_modes)
      ? attributes.supported_color_modes.filter((m): m is string => typeof m === 'string')
      : [];
    const features = numberAttribute(attributes, 'supported_features') ?? 0;

    return {
      entityId,
      on: state?.state === 'on',
      brightness: numberAttribute(attributes, 'brightness'),
      // Only the mode Home Assistant reports as active is authoritative; the
      // other color attribute is a stale conversion of it.
      colorTempKelvin: colorMode === 'color_temp' ? numberAttribute(attributes, 'color_temp_kelvin') : null,
      rgbColor: colorMode !== null && COLOR_MODES.has(colorMode) ? rgbAttribute(attributes) : null,
      effect: effect !== null && !NO_EFFECT.has(effect.toLowerCase()) ? effect : null,
      supportsEffect: (features & 4) !== 0 || supportedModes.length > 0,
    };
  });
}

/**
 * Ordered calls that put the snapshot back. Lights that had no effect running
 * get an explicit `effect: off` first: setting only a color would leave the
 * flourish's effect running on integrations that treat the two independently.
 */
export function restorePlan(snapshots: LightSnapshot[]): RestoreCall[] {
  const calls: RestoreCall[] = [];

  const clearEffect = snapshots
    .filter((s) => s.on && s.effect === null && s.supportsEffect)
    .map((s) => s.entityId)
    .sort();
  if (clearEffect.length > 0) {
    calls.push({ service: 'turn_on', serviceData: { effect: 'off' }, entityIds: clearEffect });
  }

  const groups = new Map<string, RestoreCall>();
  for (const snapshot of snapshots.filter((s) => s.on)) {
    const serviceData: Record<string, unknown> = {};
    if (snapshot.brightness !== null) serviceData.brightness = Math.round(snapshot.brightness);
    if (snapshot.effect !== null) serviceData.effect = snapshot.effect;
    else if (snapshot.rgbColor !== null) serviceData.rgb_color = snapshot.rgbColor;
    else if (snapshot.colorTempKelvin !== null) serviceData.color_temp_kelvin = Math.round(snapshot.colorTempKelvin);

    const key = JSON.stringify(serviceData);
    const existing = groups.get(key);
    if (existing) existing.entityIds.push(snapshot.entityId);
    else groups.set(key, { service: 'turn_on', serviceData, entityIds: [snapshot.entityId] });
  }
  for (const call of groups.values()) calls.push({ ...call, entityIds: [...call.entityIds].sort() });

  const off = snapshots
    .filter((s) => !s.on)
    .map((s) => s.entityId)
    .sort();
  if (off.length > 0) calls.push({ service: 'turn_off', serviceData: {}, entityIds: off });

  return calls;
}
