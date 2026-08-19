// Deterministic target resolution: (target, area, domain) → concrete entity_ids
// against the registry cache. Pure functions; refusal over guessing, always.
import type { PolicyConfig } from '../config.js';
import { displayName, effectiveAreaId, type RegistryCache } from '../ha/registry.js';
import type { AreaEntry } from '../ha/types.js';
import type { ProposedAction } from '../realtime/tools.js';

export type Resolution =
  | { ok: true; entityIds: string[]; confidence: number; collective: boolean }
  | {
      ok: false;
      reason: 'unknown_area' | 'no_devices_in_scope' | 'no_confident_match' | 'ambiguous' | 'too_many_targets';
      message: string;
      candidates?: string[];
    };

const ARTICLES = new Set(['the', 'a', 'an', 'my', 'our']);
const COLLECTIVE_WORDS = new Set(['all', 'every', 'everything']);
const DOMAIN_WORDS: Record<string, string[]> = {
  light: ['light', 'lights'],
  fan: ['fan', 'fans'],
  switch: ['switch', 'switches'],
  media_player: ['media'],
  cover: ['cover', 'covers', 'blinds', 'shades'],
  lock: ['lock', 'locks'],
};

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stem(token: string): string {
  return token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
}

function tokensOf(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter((t) => t.length > 0 && !ARTICLES.has(t))
    .map(stem);
}

function isSubset(a: string[], b: string[]): boolean {
  const set = new Set(b);
  return a.length > 0 && a.every((t) => set.has(t));
}

/** "lights", "all the lights", "everything" → the whole in-scope domain. */
export function isCollective(target: string, domain: string): boolean {
  const domainWords = new Set((DOMAIN_WORDS[domain] ?? []).map((w) => stem(w)));
  const rest = tokensOf(target).filter((t) => !COLLECTIVE_WORDS.has(t) && !domainWords.has(t));
  return rest.length === 0 && tokensOf(target).length > 0;
}

/** Match a spoken area phrase to registry areas (names, registry aliases, config aliases). */
export function matchAreas(cache: RegistryCache, cfg: PolicyConfig, phrase: string): AreaEntry[] {
  const wanted = normalize(phrase);
  const byName = new Map<string, AreaEntry>();
  for (const area of cache.areasById.values()) byName.set(normalize(area.name), area);

  const matches = new Map<string, AreaEntry>();
  for (const area of cache.areasById.values()) {
    if (normalize(area.name) === wanted || (area.aliases ?? []).some((a) => normalize(a) === wanted)) {
      matches.set(area.area_id, area);
    }
  }
  for (const [alias, areaNames] of Object.entries(cfg.areaAliases)) {
    if (normalize(alias) !== wanted) continue;
    for (const name of areaNames) {
      const area = byName.get(normalize(name));
      if (area) matches.set(area.area_id, area);
    }
  }
  return [...matches.values()];
}

function nameVariants(cache: RegistryCache, entityId: string): string[] {
  const entry = cache.entitiesById.get(entityId);
  const variants = [displayName(cache, entityId), entry?.name, entry?.original_name, ...(entry?.aliases ?? [])];
  return variants.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

export function scoreTarget(cache: RegistryCache, entityId: string, target: string): number {
  const targetNorm = normalize(target);
  const targetTokens = tokensOf(target);
  let best = 0;
  for (const variant of nameVariants(cache, entityId)) {
    const variantNorm = normalize(variant);
    if (variantNorm === targetNorm) return 1;
    const variantTokens = tokensOf(variant);
    if (isSubset(targetTokens, variantTokens)) best = Math.max(best, 0.8);
    else if (isSubset(variantTokens, targetTokens)) best = Math.max(best, 0.7);
  }
  return best;
}

function controllable(cache: RegistryCache, domain: string): string[] {
  const ids: string[] = [];
  for (const [entityId, entry] of cache.entitiesById) {
    if (!entityId.startsWith(`${domain}.`)) continue;
    if (entry.disabled_by !== null || entry.hidden_by !== null) continue;
    if (entry.entity_category !== null && entry.entity_category !== undefined) continue;
    ids.push(entityId);
  }
  return ids.sort();
}

export function resolveTargets(
  cache: RegistryCache,
  cfg: PolicyConfig,
  proposed: ProposedAction,
  originArea?: string,
): Resolution {
  let candidates = controllable(cache, proposed.domain);

  // Area scoping.
  if (proposed.area !== null && proposed.area.trim() !== '') {
    const areas = matchAreas(cache, cfg, proposed.area);
    if (areas.length === 0) {
      const known = [...cache.areasById.values()].map((a) => a.name).sort();
      return {
        ok: false,
        reason: 'unknown_area',
        message: `I don't know an area called "${proposed.area}". Known areas: ${known.join(', ')}`,
      };
    }
    const areaIds = new Set(areas.map((a) => a.area_id));
    candidates = candidates.filter((id) => {
      const areaId = effectiveAreaId(cache, id);
      return areaId !== null && areaIds.has(areaId);
    });
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: 'no_devices_in_scope',
        message: `No ${proposed.domain} devices in ${areas.map((a) => a.name).join('/')}`,
      };
    }
  } else if (originArea) {
    // No spoken area: prefer the room that heard the command, widen if empty.
    const areas = matchAreas(cache, cfg, originArea);
    if (areas.length > 0) {
      const areaIds = new Set(areas.map((a) => a.area_id));
      const local = candidates.filter((id) => {
        const areaId = effectiveAreaId(cache, id);
        return areaId !== null && areaIds.has(areaId);
      });
      if (local.length > 0) candidates = local;
    }
  }

  // Collective commands take everything in scope.
  if (isCollective(proposed.target, proposed.domain)) {
    if (candidates.length > cfg.matching.maxCollectiveTargets) {
      return {
        ok: false,
        reason: 'too_many_targets',
        message: `"${proposed.target}" would touch ${candidates.length} devices (limit ${cfg.matching.maxCollectiveTargets})`,
      };
    }
    return { ok: true, entityIds: candidates, confidence: 1, collective: true };
  }

  // Name scoring.
  const scored = candidates
    .map((id) => ({ id, score: scoreTarget(cache, id, proposed.target) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < cfg.matching.minConfidence) {
    const hints = scored.slice(0, 3).map((s) => displayName(cache, s.id));
    return {
      ok: false,
      reason: 'no_confident_match',
      message:
        `No confident match for "${proposed.target}"` +
        (proposed.area ? ` in ${proposed.area}` : '') +
        (hints.length > 0 ? ` (closest: ${hints.join(', ')})` : ''),
      candidates: hints,
    };
  }

  const tied = scored.filter((s) => s.score === best.score);
  if (tied.length > 1) {
    const names = tied.map((s) => `${displayName(cache, s.id)} (${s.id})`);
    return {
      ok: false,
      reason: 'ambiguous',
      message: `"${proposed.target}" matches several devices equally: ${names.join(', ')}. Say which one.`,
      candidates: tied.map((s) => s.id),
    };
  }

  return { ok: true, entityIds: [best.id], confidence: best.score, collective: false };
}
