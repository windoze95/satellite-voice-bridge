// Registry cache → the Realtime session instructions: role, rules, and a
// compact HOUSE map. Output is deterministically ordered so identical registries
// produce identical prompts (prompt-cache friendly).
import type { PolicyConfig } from '../config.js';
import { displayName, effectiveAreaId, type RegistryCache } from '../ha/registry.js';

const RULES = `You are the voice-command interpreter for a private smart home. Commands are short and spoken (or typed). Your ONLY job is to translate each command into a single control_device function call, or reply with one short sentence when you cannot.

Rules:
- When the user wants a device changed, call control_device. Do not narrate, do not confirm, do not ask a question when a confident call is possible.
- Use ONLY area names and device names from HOUSE below. Set area to an area name exactly as written there, or null when no area was stated or implied.
- target is the device/group name as spoken; for whole-group commands use the domain plural (e.g. "lights").
- value is a percent 0-100 for brightness, fan speed, volume, or cover position; degrees for temperature; otherwise null.
- If the request is ambiguous, refers to something not in HOUSE, or is not a device command, reply with ONE short sentence instead of calling the function. Never guess.
- After a function result arrives, reply with at most one short sentence (it is logged, never spoken).`;

/** Which domains get advertised to the model (green + yellow; red stays unlisted). */
export function advertisedDomains(cfg: PolicyConfig): string[] {
  return [...cfg.tiers.green, ...cfg.tiers.yellow];
}

export function buildHouseMap(cache: RegistryCache, cfg: PolicyConfig): string {
  const domains = advertisedDomains(cfg);
  const byArea = new Map<string | null, Map<string, string[]>>();

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
    list.push(displayName(cache, entityId) + (aliases.length > 0 ? ` (aka ${aliases.join(', ')})` : ''));
  }

  const lines: string[] = ['HOUSE:'];
  const areas = [...cache.areasById.values()].sort((a, b) => a.name.localeCompare(b.name));
  const renderArea = (label: string, areaMap: Map<string, string[]> | undefined): void => {
    if (!areaMap || areaMap.size === 0) return;
    lines.push(`AREA: ${label}`);
    for (const domain of [...areaMap.keys()].sort()) {
      const names = areaMap.get(domain) ?? [];
      lines.push(`  ${domain}: ${names.sort((a, b) => a.localeCompare(b)).join('; ')}`);
    }
  };
  for (const area of areas) renderArea(area.name, byArea.get(area.area_id));
  renderArea('(no area)', byArea.get(null));
  return lines.join('\n');
}

export function buildInstructions(cache: RegistryCache, cfg: PolicyConfig, originArea?: string): string {
  const parts = [RULES, '', buildHouseMap(cache, cfg)];
  if (originArea) {
    parts.push('', `The device that heard this command is in: ${originArea}. When no area is stated, prefer devices there.`);
  }
  return parts.join('\n');
}
