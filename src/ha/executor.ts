// The ONLY place a Home Assistant service call can originate. The action×domain
// map is a fixed allowlist: arbitrary service execution is impossible by construction.
import type { CommandTrace } from '../telemetry.js';
import type { LightOptions } from '../realtime/tools.js';
import type { HAClient } from './client.js';
import type { CallServiceResult, StateChangedData } from './types.js';

export type Verification = 'state' | 'fire_and_forget';

export interface ResolvedAction {
  tier: 'green' | 'yellow';
  domain: string;
  service: string;
  serviceData: Record<string, unknown>;
  entityIds: string[];
  verification: Verification;
}

export type ServiceMapping =
  | { ok: true; service: string; serviceData: Record<string, unknown>; verification: Verification }
  | { ok: false; reason: 'unsupported_action' | 'missing_value' | 'invalid_value'; message: string };

function pct(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value).replace('%', ''));
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function needsValue(domain: string, action: string): ServiceMapping {
  return { ok: false, reason: 'missing_value', message: `"${action}" on ${domain} needs a numeric value` };
}

const unsupported = (domain: string, action: string): ServiceMapping => ({
  ok: false,
  reason: 'unsupported_action',
  message: `"${action}" is not supported for ${domain}`,
});

const invalid = (domain: string, field: string): ServiceMapping => ({
  ok: false,
  reason: 'invalid_value',
  message: `Invalid ${field} for ${domain}`,
});

function lightData(light: LightOptions | null | undefined): Record<string, unknown> | null {
  if (!light) return {};
  if ([light.rgb_color, light.color_temp_kelvin, light.effect].filter((value) => value !== null).length > 1) return null;
  if (light.brightness_pct !== null && light.brightness_step_pct !== null) return null;
  const data: Record<string, unknown> = {};
  if (light.brightness_pct !== null) {
    const brightness = pct(light.brightness_pct);
    if (brightness === null) return null;
    data.brightness_pct = brightness;
  }
  if (light.brightness_step_pct !== null) {
    const step = Math.round(light.brightness_step_pct);
    if (!Number.isFinite(light.brightness_step_pct) || step === 0 || step < -100 || step > 100) return null;
    data.brightness_step_pct = step;
  }
  if (light.rgb_color !== null) {
    if (
      light.rgb_color.length !== 3 ||
      light.rgb_color.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
    ) {
      return null;
    }
    data.rgb_color = [...light.rgb_color];
  }
  if (light.color_temp_kelvin !== null) {
    if (!Number.isFinite(light.color_temp_kelvin) || light.color_temp_kelvin < 1) return null;
    data.color_temp_kelvin = Math.round(light.color_temp_kelvin);
  }
  if (light.effect !== null) {
    const effect = light.effect.trim();
    if (effect.length === 0) return null;
    data.effect = effect;
  }
  if (light.transition_seconds !== null) {
    if (!Number.isFinite(light.transition_seconds) || light.transition_seconds < 0 || light.transition_seconds > 6553) return null;
    data.transition = light.transition_seconds;
  }
  if (light.flash !== null) data.flash = light.flash;
  return data;
}

/** Pure: (action, domain, legacy value, structured light settings) → an allowlisted HA service call or refusal. */
export function mapService(
  action: string,
  domain: string,
  value: number | string | null,
  light: LightOptions | null = null,
): ServiceMapping {
  const p = pct(value);
  if (domain !== 'light' && light && Object.values(light).some((setting) => setting !== null)) {
    return invalid(domain, 'light-only settings');
  }
  switch (domain) {
    case 'light': {
      const data = lightData(light);
      if (data === null) return invalid(domain, 'light settings');
      if (value !== null && Object.keys(data).length > 0) return invalid(domain, 'value/light settings conflict');
      if (p !== null) data.brightness_pct = p;
      if (action === 'turn_on') return { ok: true, service: 'turn_on', serviceData: data, verification: 'state' };
      if (action === 'turn_off') {
        const offData = Object.fromEntries(Object.entries(data).filter(([key]) => key === 'transition' || key === 'flash'));
        if (Object.keys(offData).length !== Object.keys(data).length) return invalid(domain, 'turn_off settings');
        return { ok: true, service: 'turn_off', serviceData: offData, verification: 'state' };
      }
      if (action === 'toggle') {
        if (Object.keys(data).length > 0) return invalid(domain, 'toggle settings');
        return { ok: true, service: 'toggle', serviceData: {}, verification: 'state' };
      }
      if (action === 'set') {
        return Object.keys(data).length > 0
          ? { ok: true, service: 'turn_on', serviceData: data, verification: 'state' }
          : needsValue(domain, action);
      }
      return unsupported(domain, action);
    }
    case 'fan':
      if (action === 'turn_on') return { ok: true, service: 'turn_on', serviceData: p !== null ? { percentage: p } : {}, verification: 'state' };
      if (action === 'turn_off') return { ok: true, service: 'turn_off', serviceData: {}, verification: 'state' };
      if (action === 'toggle') return { ok: true, service: 'toggle', serviceData: {}, verification: 'state' };
      if (action === 'set') return p !== null ? { ok: true, service: 'set_percentage', serviceData: { percentage: p }, verification: 'state' } : needsValue(domain, action);
      return unsupported(domain, action);
    case 'switch':
      if (action === 'turn_on' || action === 'turn_off' || action === 'toggle') return { ok: true, service: action, serviceData: {}, verification: 'state' };
      return unsupported(domain, action);
    case 'media_player':
      if (action === 'play') return { ok: true, service: 'media_play', serviceData: {}, verification: 'state' };
      if (action === 'pause') return { ok: true, service: 'media_pause', serviceData: {}, verification: 'state' };
      if (action === 'stop') return { ok: true, service: 'media_stop', serviceData: {}, verification: 'state' };
      if (action === 'turn_on' || action === 'turn_off') return { ok: true, service: action, serviceData: {}, verification: 'state' };
      if (action === 'set') return p !== null ? { ok: true, service: 'volume_set', serviceData: { volume_level: p / 100 }, verification: 'fire_and_forget' } : needsValue(domain, action);
      return unsupported(domain, action);
    case 'scene':
      if (action === 'activate' || action === 'turn_on') return { ok: true, service: 'turn_on', serviceData: {}, verification: 'fire_and_forget' };
      return unsupported(domain, action);
    case 'script':
      if (action === 'activate' || action === 'turn_on') return { ok: true, service: 'turn_on', serviceData: {}, verification: 'fire_and_forget' };
      if (action === 'turn_off') return { ok: true, service: 'turn_off', serviceData: {}, verification: 'fire_and_forget' };
      return unsupported(domain, action);
    case 'cover':
      if (action === 'open' || action === 'turn_on') return { ok: true, service: 'open_cover', serviceData: {}, verification: 'state' };
      if (action === 'close' || action === 'turn_off') return { ok: true, service: 'close_cover', serviceData: {}, verification: 'state' };
      if (action === 'stop') return { ok: true, service: 'stop_cover', serviceData: {}, verification: 'state' };
      if (action === 'set') return p !== null ? { ok: true, service: 'set_cover_position', serviceData: { position: p }, verification: 'state' } : needsValue(domain, action);
      return unsupported(domain, action);
    case 'lock':
      if (action === 'lock' || action === 'unlock') return { ok: true, service: action, serviceData: {}, verification: 'state' };
      return unsupported(domain, action);
    case 'climate':
      if (action === 'set') {
        const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
        if (!Number.isFinite(n)) return needsValue(domain, action);
        return { ok: true, service: 'set_temperature', serviceData: { temperature: n }, verification: 'fire_and_forget' };
      }
      if (action === 'turn_on' || action === 'turn_off') return { ok: true, service: action, serviceData: {}, verification: 'fire_and_forget' };
      return unsupported(domain, action);
    default:
      return unsupported(domain, action);
  }
}

export interface ExecutionResult {
  ok: boolean;
  verified: boolean;
  confirmedEntityIds: string[];
  error?: string;
}

/**
 * Executes a resolved action and verifies causally: HA's call_service result
 * carries a context id, and state_changed events caused by it carry the same id
 * (or it as parent). T6=send, T7=result, T8=first causally-matched state change.
 */
export async function executeAction(
  client: HAClient,
  resolved: ResolvedAction,
  trace: CommandTrace,
  opts: { confirmTimeoutMs?: number } = {},
): Promise<ExecutionResult> {
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 3000;
  const targets = new Set(resolved.entityIds);
  const confirmed = new Set<string>();

  let contextId: string | null = null;
  let settleConfirm: (() => void) | null = null;

  const check = (data: StateChangedData): void => {
    const ctx = data.new_state?.context;
    if (!ctx || !contextId) return;
    if (ctx.id === contextId || ctx.parent_id === contextId) {
      trace.mark('t8');
      confirmed.add(data.entity_id);
      if (confirmed.size === targets.size) settleConfirm?.();
    }
  };
  // Events for our targets can beat the call_service result over the socket;
  // buffer them until the causal context id is known.
  const early: StateChangedData[] = [];
  const onStateChanged = (data: StateChangedData): void => {
    if (!targets.has(data.entity_id) || !data.new_state?.context) return;
    if (contextId === null) early.push(data);
    else check(data);
  };
  client.on('state_changed', onStateChanged);

  try {
    trace.mark('t6');
    let result: CallServiceResult;
    try {
      result = await client.callService(resolved.domain, resolved.service, resolved.serviceData, resolved.entityIds);
    } catch (err) {
      return {
        ok: false,
        verified: false,
        confirmedEntityIds: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    trace.mark('t7');
    contextId = result.context?.id ?? null;
    for (const data of early) check(data);
    early.length = 0;

    if (resolved.verification === 'fire_and_forget' || !contextId) {
      trace.copyMark('t7', 't8');
      return { ok: true, verified: resolved.verification === 'fire_and_forget', confirmedEntityIds: [] };
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, confirmTimeoutMs);
      timer.unref?.();
      settleConfirm = () => {
        clearTimeout(timer);
        resolve();
      };
      if (confirmed.size === targets.size) settleConfirm();
    });
    return { ok: true, verified: confirmed.size > 0, confirmedEntityIds: [...confirmed] };
  } finally {
    client.off('state_changed', onStateChanged);
  }
}
