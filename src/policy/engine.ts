// The authorization gate. OpenAI proposes; this code decides. GREEN executes,
// YELLOW needs per-entity opt-in, RED and everything unknown is refused.
import type { PolicyConfig } from '../config.js';
import { mapService, type ResolvedAction } from '../ha/executor.js';
import { displayName, type RegistryCache } from '../ha/registry.js';
import type { ProposedAction } from '../realtime/tools.js';
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

  const mapping = mapService(proposed.action, proposed.domain, proposed.value);
  if (!mapping.ok) {
    return refuse(tier, mapping.reason, mapping.message);
  }

  const res = resolveTargets(cache, cfg, proposed, originArea);
  if (!res.ok) {
    return refuse(tier, res.reason, res.message);
  }

  if (tier === 'yellow') {
    if (res.collective) {
      return refuse(tier, 'collective_on_yellow', `Collective commands are not allowed for ${proposed.domain}; name one device`);
    }
    const notAllowed = res.entityIds.filter((id) => !cfg.yellowAllow.includes(id));
    if (notAllowed.length > 0) {
      const names = notAllowed.map((id) => `${displayName(cache, id)} (${id})`).join(', ');
      return refuse(tier, 'not_opted_in', `${names} is not enabled for voice control (yellow_allow in voicebridge.yaml)`);
    }
  }

  const resolved: ResolvedAction = {
    tier,
    domain: proposed.domain,
    service: mapping.service,
    serviceData: mapping.serviceData,
    entityIds: res.entityIds,
    verification: mapping.verification,
  };
  const names = res.entityIds.map((id) => displayName(cache, id)).join(', ');
  return {
    outcome: cfg.dryRun ? 'dry_run' : 'execute',
    tier,
    message: `${proposed.domain}.${mapping.service} → ${names}${cfg.dryRun ? ' (dry-run)' : ''}`,
    entityIds: res.entityIds,
    resolved,
  };
}
