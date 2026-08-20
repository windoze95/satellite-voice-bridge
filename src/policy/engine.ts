// The authorization gate. OpenAI proposes; this code decides. GREEN executes,
// YELLOW needs per-entity opt-in, RED and everything unknown is refused.
import type { PolicyConfig } from '../config.js';
import { mapService, type ResolvedAction } from '../ha/executor.js';
import { displayName, type RegistryCache } from '../ha/registry.js';
import type { ProposedAction } from '../realtime/tools.js';
import { planLightCapabilities } from './light-capabilities.js';
import { resolveTargets } from './resolve.js';

export type Tier = 'green' | 'yellow' | 'red' | 'unknown';

export interface Decision {
  outcome: 'execute' | 'dry_run' | 'refuse';
  tier: Tier;
  reason?: string;
  /** Human/model-readable result of the decision; goes into function_call_output. */
  message: string;
  entityIds: string[];
  resolved?: ResolvedAction;
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
});

export function decide(
  cache: RegistryCache,
  cfg: PolicyConfig,
  proposed: ProposedAction,
  originArea?: string,
): Decision {
  const tier = tierOf(cfg, proposed.domain);
  if (tier === 'unknown') {
    return refuse('unknown', 'unknown_domain', `${proposed.domain} is not in any policy tier; refusing`);
  }
  if (tier === 'red') {
    return refuse('red', 'red_tier', `Controlling ${proposed.domain} by voice is never allowed`);
  }

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

  if (tier === 'yellow') {
    if (res.collective) {
      return refuse(tier, 'collective_on_yellow', `Collective commands are not allowed for ${proposed.domain}; name one device`);
    }
    const notAllowed = entityIds.filter((id) => !cfg.yellowAllow.includes(id));
    if (notAllowed.length > 0) {
      const names = notAllowed.map((id) => `${displayName(cache, id)} (${id})`).join(', ');
      return refuse(tier, 'not_opted_in', `${names} is not enabled for voice control (yellow_allow in voicebridge.yaml)`);
    }
  }

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
    resolved,
  };
}
