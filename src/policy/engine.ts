// The authorization gate. OpenAI proposes; this code decides. GREEN executes,
// YELLOW needs per-entity opt-in, RED and everything unknown is refused.
//
// A decision carries a LIST of calls: a named mood is rendered locally into one
// call per distinct appearance (see policy/mood.ts), and every one of them is
// authorized here on exactly the same terms as a single spoken command.
import type { MoodOverrides, PolicyConfig } from '../config.js';
import { mapService, type ResolvedAction } from '../ha/executor.js';
import { displayName, type RegistryCache } from '../ha/registry.js';
import type { ProposedAction } from '../realtime/tools.js';
import { planLightCapabilities } from './light-capabilities.js';
import { composeMood } from './mood.js';
import { resolveTargets } from './resolve.js';

export type Tier = 'green' | 'yellow' | 'red' | 'unknown';

export interface Decision {
  outcome: 'execute' | 'dry_run' | 'refuse';
  tier: Tier;
  reason?: string;
  /** Human/model-readable result of the decision; goes into function_call_output. */
  message: string;
  entityIds: string[];
  /** Executed in order. Empty on a refusal. */
  calls: ResolvedAction[];
}

export interface DecideOptions {
  moodOverrides?: Record<string, MoodOverrides>;
}

function tierOf(cfg: PolicyConfig, domain: string): Tier {
  if (cfg.tiers.green.includes(domain)) return 'green';
  if (cfg.tiers.yellow.includes(domain)) return 'yellow';
  if (cfg.tiers.red.includes(domain)) return 'red';
  return 'unknown';
}

const refuse = (tier: Tier, reason: string, message: string): Decision => ({
  outcome: 'refuse',
  tier,
  reason,
  message,
  entityIds: [],
  calls: [],
});

export function decide(
  cache: RegistryCache,
  cfg: PolicyConfig,
  proposed: ProposedAction,
  originArea?: string,
  opts: DecideOptions = {},
): Decision {
  const tier = tierOf(cfg, proposed.domain);
  if (tier === 'unknown') {
    return refuse('unknown', 'unknown_domain', `${proposed.domain} is not in any policy tier; refusing`);
  }
  if (tier === 'red') {
    return refuse('red', 'red_tier', `Controlling ${proposed.domain} by voice is never allowed`);
  }

  const mood = proposed.domain === 'light' ? (proposed.light?.mood ?? null) : null;
  if (mood !== null) return decideMood(cache, cfg, proposed, mood, originArea, opts);

  const mapping = mapService(proposed.action, proposed.domain, proposed.value, proposed.light);
  if (!mapping.ok) {
    return refuse(tier, mapping.reason, mapping.message);
  }

  // Capability planning flattens and deduplicates HA light groups. Defer the
  // collective limit until after that step so duplicate group/member registry
  // rows neither falsely inflate nor bypass the real leaf-target count.
  const deferCollectiveLimit = proposed.domain === 'light' && Object.keys(mapping.serviceData).length > 0;
  const res = resolveTargets(cache, cfg, proposed, originArea, { deferCollectiveLimit });
  if (!res.ok) {
    return refuse(tier, res.reason, res.message);
  }

  let entityIds = res.entityIds;
  let serviceData = mapping.serviceData;
  let capabilityNotes: string[] = [];
  if (proposed.domain === 'light') {
    const plan = planLightCapabilities(cache, entityIds, serviceData, mapping.service);
    if (!plan.ok) return refuse(tier, plan.reason, plan.message);
    entityIds = plan.entityIds;
    serviceData = plan.serviceData;
    capabilityNotes = plan.notes;
  }

  if (res.collective && entityIds.length > cfg.matching.maxCollectiveTargets) {
    return refuse(
      tier,
      'too_many_targets',
      `"${proposed.target}" would touch ${entityIds.length} devices (limit ${cfg.matching.maxCollectiveTargets})`,
    );
  }

  const yellowRefusal = checkYellow(cache, cfg, tier, res.collective, entityIds, proposed.domain);
  if (yellowRefusal) return yellowRefusal;

  const resolved: ResolvedAction = {
    tier,
    domain: proposed.domain,
    service: mapping.service,
    serviceData,
    entityIds,
    verification: mapping.verification,
  };
  const names = entityIds.map((id) => displayName(cache, id)).join(', ');
  const detail = capabilityNotes.length > 0 ? `; ${capabilityNotes.join('; ')}` : '';
  return {
    outcome: cfg.dryRun ? 'dry_run' : 'execute',
    tier,
    message: `${proposed.domain}.${mapping.service} → ${names}${detail}${cfg.dryRun ? ' (dry-run)' : ''}`,
    entityIds,
    calls: [resolved],
  };
}

/**
 * A named mood: the bridge picks the appearance, so the model's only claims here
 * are the mood and the area. Targeting, the collective limit, and capability
 * checks are identical to any other lighting command — composing locally buys
 * better lighting, never wider authority.
 */
function decideMood(
  cache: RegistryCache,
  cfg: PolicyConfig,
  proposed: ProposedAction,
  mood: NonNullable<NonNullable<ProposedAction['light']>['mood']>,
  originArea: string | undefined,
  opts: DecideOptions,
): Decision {
  const tier: Tier = 'green';
  if (proposed.action === 'turn_off') {
    return refuse(tier, 'mood_on_turn_off', 'A mood describes how lights should look; it cannot be combined with turning them off');
  }

  const res = resolveTargets(cache, cfg, proposed, originArea, { deferCollectiveLimit: true });
  if (!res.ok) return refuse(tier, res.reason, res.message);

  const plan = composeMood(cache, res.entityIds, mood, proposed.tone, {
    brightnessPct: proposed.light?.brightness_pct ?? null,
    transitionSeconds: proposed.light?.transition_seconds ?? null,
    overrides: opts.moodOverrides,
  });
  if (!plan.ok) return refuse(tier, plan.reason, plan.message);

  if (res.collective && plan.entityIds.length > cfg.matching.maxCollectiveTargets) {
    return refuse(
      tier,
      'too_many_targets',
      `"${proposed.target}" would touch ${plan.entityIds.length} devices (limit ${cfg.matching.maxCollectiveTargets})`,
    );
  }

  const calls: ResolvedAction[] = plan.calls.map((call) => ({
    tier,
    domain: 'light',
    service: call.service,
    serviceData: call.serviceData,
    entityIds: call.entityIds,
    verification: 'state' as const,
  }));

  const summary = plan.calls
    .map((call) => `${call.entityIds.map((id) => displayName(cache, id)).join(', ')} → ${describe(call.service, call.serviceData)}`)
    .join(' | ');
  const detail = plan.notes.length > 0 ? `; ${plan.notes.join('; ')}` : '';
  return {
    outcome: cfg.dryRun ? 'dry_run' : 'execute',
    tier,
    message: `light mood "${mood}": ${summary}${detail}${cfg.dryRun ? ' (dry-run)' : ''}`,
    entityIds: plan.entityIds,
    calls,
  };
}

function describe(service: string, serviceData: Record<string, unknown>): string {
  if (service === 'turn_off') return 'off';
  const parts: string[] = [];
  if (Array.isArray(serviceData.rgb_color)) parts.push(`rgb(${serviceData.rgb_color.join(',')})`);
  if (typeof serviceData.color_temp_kelvin === 'number') parts.push(`${serviceData.color_temp_kelvin}K`);
  if (typeof serviceData.brightness_pct === 'number') parts.push(`${serviceData.brightness_pct}%`);
  return parts.length > 0 ? parts.join(' ') : 'on';
}

function checkYellow(
  cache: RegistryCache,
  cfg: PolicyConfig,
  tier: Tier,
  collective: boolean,
  entityIds: string[],
  domain: string,
): Decision | null {
  if (tier !== 'yellow') return null;
  if (collective) {
    return refuse(tier, 'collective_on_yellow', `Collective commands are not allowed for ${domain}; name one device`);
  }
  const notAllowed = entityIds.filter((id) => !cfg.yellowAllow.includes(id));
  if (notAllowed.length > 0) {
    const names = notAllowed.map((id) => `${displayName(cache, id)} (${id})`).join(', ');
    return refuse(tier, 'not_opted_in', `${names} is not enabled for voice control (yellow_allow in voicebridge.yaml)`);
  }
  return null;
}
